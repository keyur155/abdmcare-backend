import { Job, UnrecoverableError } from 'bullmq';
import fs from 'fs';
import prisma from '../common/config/database';
import logger from '../common/config/logger';
import { abdmConfig } from '../common/config/abdm';
import { AbdmClient, resolveHipTenant } from '../common/utils/abdm-client';
import EncryptionService from '../common/utils/encryption';
import crypto from 'crypto';
import { HealthDataPushJobData, createHealthDataPushWorker, logHealthDataPushQueueCounts } from '../common/config/queue';
import { deriveHiType, hiTypeToProfile, AbdmHiType } from '../modules/hip/discovery-helpers';
import { DocumentInput } from '../common/utils/fhir/resources/document-reference';

const abdmClient = new AbdmClient();

// Cap on how large a single document we inline as base64 into a bundle. ABDM
// requires attachments to be inline base64 (no external URLs), but a huge PDF
// would bloat the encrypted push and risk OOM — skip and log those instead.
const MAX_INLINE_DOC_BYTES = 10 * 1024 * 1024;

/**
 * Read locally-stored documents (Document.storageUrl is an on-disk path — see
 * document.service.ts) and return them as base64 DocumentInput for the FHIR
 * builder. Files missing on disk or over the size cap are skipped with a log.
 */
function readDocumentsAsBase64(docs: any[], transactionId: string): DocumentInput[] {
  const out: DocumentInput[] = [];
  for (const d of docs) {
    try {
      if (!d.storageUrl || !fs.existsSync(d.storageUrl)) {
        logger.warn('Worker: document file missing on disk, skipping', {
          transactionId, documentId: d.id, storageUrl: d.storageUrl,
        });
        continue;
      }
      const stat = fs.statSync(d.storageUrl);
      if (stat.size > MAX_INLINE_DOC_BYTES) {
        logger.warn('Worker: document too large to inline, skipping', {
          transactionId, documentId: d.id, sizeBytes: stat.size,
        });
        continue;
      }
      const buf = fs.readFileSync(d.storageUrl);
      out.push({
        id: d.id,
        title: d.fileName || String(d.type || 'Document'),
        contentType: d.mimeType || 'application/pdf',
        data: buf.toString('base64'),
        size: buf.length,
        creation: d.createdAt ? new Date(d.createdAt).toISOString() : undefined,
      });
    } catch (e: any) {
      logger.warn('Worker: failed to read document, skipping', {
        transactionId, documentId: d.id, error: e?.message,
      });
    }
  }
  return out;
}

/**
 * Sentinel thrown when a transfer cannot succeed regardless of retry — e.g.
 * the consent artefact authorises careContextReferences our HIP no longer
 * stores (orphan refs after a DB reset), or the consent date-window has zero
 * matching encounters. Re-running the same job in 5/15/45s will deterministically
 * fail again, so we surface this to BullMQ as `UnrecoverableError` to skip the
 * remaining attempts. The message becomes the FAILED-notify description ABDM
 * relays to the patient's ABHA app, so it should be human-readable.
 */
class UnrecoverablePushError extends Error {
  constructor(public readonly reason: string, public readonly description: string) {
    super(reason);
    this.name = 'UnrecoverablePushError';
  }
}

async function processHealthDataPush(job: Job<HealthDataPushJobData>): Promise<void> {
  const { transactionId, consentAbdmId, consentPatientId, dataPushUrl, dateRange, hiTypes, authorisedCareContextRefs, keyMaterial, tenantHipId, tenantHospitalId } = job.data;

  logger.info('Worker: Processing health data push', {
    transactionId,
    jobId: job.id,
    dataPushUrl,
    consentAbdmId,
    hiTypes,
    authorisedCareContextCount: authorisedCareContextRefs?.length || 0,
    dateRange,
    tenantHipId,
    tenantHospitalId,
  });

  // Track the care-context references involved so a FAILED notification can
  // still carry a valid `statusResponses` array (required by ABDM, else 400).
  let careContextRefs: string[] = [];

  try {
    const consent = await prisma.consent.findFirst({
      where: { abdmConsentId: consentAbdmId },
      include: { patient: { include: { abhaRecord: true } } },
    });

    if (!consent) {
      throw new Error(`Consent not found: ${consentAbdmId}`);
    }

    // Resolve the tenant hospital — this is the FACILITY that authored the
    // care contexts and whose name MUST appear as the FHIR
    // Composition.custodian. We never use the consent's patient.hospitalId
    // here because on a multi-tenant platform the patient may have rows at
    // multiple hospitals (same ABHA, different facility) — the consent's
    // requesterHospitalId is the HIU's local copy, NOT the HIP we're
    // fulfilling as. Always prefer tenantHospitalId from the job (set by
    // hip.service.handleHealthInformationRequest from the inbound X-HIP-ID).
    const hospital = tenantHospitalId
      ? await prisma.hospital.findFirst({ where: { id: tenantHospitalId } })
      : await prisma.hospital.findFirst({ where: { id: consent.patient.hospitalId || undefined } });

    // Cross-hospital ABHA reconciliation.
    // On a platform that acts as BOTH HIU and HIP, a consent raised at
    // hospital A (HIU) references A's patient row, but the authorised care
    // contexts were linked at hospital B (HIP) under B's OWN patient row for
    // the SAME ABHA. Scoping by `consent.patientId` alone therefore returns
    // zero rows — the classic `matched: 0` self-loop, even though ABDM routed
    // this fulfil request to our hipId precisely because the ABHA linked
    // contexts here. So resolve every local patient row that shares the
    // consent patient's ABHA identity and match care contexts across them.
    //
    // The `hipId = tenantHipId` filter below is retained, so the
    // "never serve another hospital's data" invariant STILL holds: we only
    // ever return care contexts this tenant owns. We're only broadening the
    // patient-row match to sibling rows of the same national ABHA identifier.
    // DEFENSE-IN-DEPTH: broadening the patient match to ABHA-sibling rows (which
    // may live at OTHER hospitals) is ONLY safe because the care-context query
    // below filters `hipId = tenantHipId`, so we still return exclusively this
    // tenant's contexts. If tenantHipId is absent that filter drops — so we MUST
    // NOT broaden to siblings, or we'd return another hospital's contexts. Tie
    // the two together: only reconcile across ABHA siblings when a tenant hipId
    // is present to scope them. Without it, stay strictly on the consent patient.
    const cp: any = consent.patient;
    let abhaSiblingIds: string[] = [];
    if (tenantHipId) {
      const abhaOr: any[] = [];
      if (cp?.abhaNumber) abhaOr.push({ abhaNumber: cp.abhaNumber });
      if (cp?.abhaAddress) abhaOr.push({ abhaAddress: cp.abhaAddress });
      if (cp?.abhaId) abhaOr.push({ abhaId: cp.abhaId });
      if (cp?.abhaRecord?.abhaNumber) abhaOr.push({ abhaRecord: { abhaNumber: cp.abhaRecord.abhaNumber } });
      if (cp?.abhaRecord?.abhaAddress) abhaOr.push({ abhaRecord: { abhaAddress: cp.abhaRecord.abhaAddress } });
      abhaSiblingIds = abhaOr.length
        ? (await prisma.patient.findMany({ where: { OR: abhaOr }, select: { id: true } })).map((p) => p.id)
        : [];
    }
    const candidatePatientIds = Array.from(new Set([consentPatientId, ...abhaSiblingIds]));
    if (candidatePatientIds.length > 1) {
      logger.info('Worker: reconciled ABHA across patient rows for care-context lookup', {
        transactionId,
        consentPatientId,
        candidatePatientCount: candidatePatientIds.length,
      });
    }

    const careContextsWithEnc = await prisma.careContext.findMany({
      where: {
        patientId: { in: candidatePatientIds },
        ...(tenantHipId ? { hipId: tenantHipId } : {}),
      },
      include: {
        encounter: {
          include: {
            doctor: true,
            prescriptions: true,
            labOrders: true,
            emrRecords: true,
            ipdAdmission: true,
            appointment: { select: { id: true } },
          },
        },
      },
    });

    if (tenantHipId) {
      logger.info('Worker: Tenant-scoped care-context query', {
        transactionId,
        tenantHipId,
        tenantHospitalId,
        matched: careContextsWithEnc.length,
      });
    } else {
      // Legacy single-tenant path — should be rare. Log so we can find any
      // callers still feeding the worker without a tenant.
      logger.warn('Worker: No tenantHipId on job — falling back to patientId-only scope (single-tenant deployment).', {
        transactionId,
      });
    }

    // Filter encounters within consent dateRange. We DO NOT additionally
    // filter by `authorisedCareContextRefs` here — that would drop care
    // contexts whose encounter is in scope but whose careContextId we
    // happen to have stored under a different surface form. Instead,
    // authorisedCareContextRefs is enforced strictly below, AFTER hiType
    // filtering, on the actual references we are about to ship.
    const fromDate = dateRange?.from ? new Date(dateRange.from) : null;
    const toDate = dateRange?.to ? new Date(dateRange.to) : null;

    const dateValidContexts = careContextsWithEnc.filter((cc) => {
      if (!cc.encounter) return false;
      const encDate = cc.encounter.visitDate || cc.encounter.createdAt;
      if (fromDate && encDate < fromDate) return false;
      if (toDate && encDate > toDate) return false;
      return true;
    });

    if (dateValidContexts.length === 0) {
      // Distinguish the failure modes: (a) zero care contexts matched the
      // patient+hipId at all → linking/tenant problem; (b) contexts matched
      // but their encounters fall outside the consent window → date-range
      // problem; (c) contexts matched but have no encounter row → data model
      // problem. The sample dates make a date-range mismatch obvious at a glance.
      logger.warn('Worker: No encounters found in consent date range', {
        transactionId,
        from: dateRange?.from,
        to: dateRange?.to,
        matchedCareContexts: careContextsWithEnc.length,
        careContextsWithoutEncounter: careContextsWithEnc.filter((cc) => !cc.encounter).length,
        sampleEncounterDates: careContextsWithEnc
          .slice(0, 5)
          .map((cc) => cc.encounter?.visitDate || cc.encounter?.createdAt || null),
      });
    }

    // Load vitals, investigations, immunizations and payments separately
    // (vitals/investigations/immunizations link via encounterId, payments
    // link via appointmentId or admissionId — Payment has no direct
    // encounterId column).
    const dateValidEncIds = dateValidContexts.map((cc) => cc.encounter!.id);
    const dateValidAppointmentIds = dateValidContexts
      .map((cc) => (cc.encounter as any)?.appointment?.id)
      .filter(Boolean) as string[];
    const dateValidAdmissionIds = Array.from(new Set(
      dateValidContexts
        .map((cc) => cc.encounter?.admissionId)
        .filter(Boolean) as string[],
    ));

    const [allVitals, allInvestigations, allImmunizations, allPayments, allDocuments] = await Promise.all([
      dateValidEncIds.length > 0
        ? prisma.vitals.findMany({ where: { encounterId: { in: dateValidEncIds } } })
        : Promise.resolve([]),
      dateValidEncIds.length > 0
        ? prisma.investigation.findMany({ where: { encounterId: { in: dateValidEncIds } } })
        : Promise.resolve([]),
      dateValidEncIds.length > 0
        ? prisma.immunization.findMany({ where: { encounterId: { in: dateValidEncIds } } })
        : Promise.resolve([]),
      (dateValidAppointmentIds.length > 0 || dateValidAdmissionIds.length > 0)
        ? prisma.payment.findMany({
            where: {
              OR: [
                ...(dateValidAppointmentIds.length > 0 ? [{ appointmentId: { in: dateValidAppointmentIds } }] : []),
                ...(dateValidAdmissionIds.length > 0 ? [{ admissionId: { in: dateValidAdmissionIds } }] : []),
              ],
              status: { in: ['PAID', 'PARTIAL', 'REFUNDED', 'PENDING'] },
            },
          })
        : Promise.resolve([]),
      // Non-structured documents (uploaded/generated PDFs, scanned reports).
      // Scoped to the in-range encounters + their IPD admission so we attach
      // exactly the files that belong to each care context's encounter.
      (dateValidEncIds.length > 0 || dateValidAdmissionIds.length > 0)
        ? prisma.document.findMany({
            where: {
              OR: [
                ...(dateValidEncIds.length > 0 ? [{ encounterId: { in: dateValidEncIds } }] : []),
                ...(dateValidAdmissionIds.length > 0 ? [{ admissionId: { in: dateValidAdmissionIds } }] : []),
              ],
            },
          })
        : Promise.resolve([]),
    ]);

    // Bucket payments by encounter id. We resolve via appointmentId (OPD)
    // and admissionId (IPD); a single Payment row will only appear under one
    // bucket because each row has either appointmentId OR admissionId, not
    // both.
    const paymentsByEnc = new Map<string, any[]>();
    for (const cc of dateValidContexts) {
      const enc = cc.encounter!;
      const apptId = (enc as any).appointment?.id;
      const admId = enc.admissionId;
      const matched = allPayments.filter((p: any) =>
        (apptId && p.appointmentId === apptId) ||
        (admId && p.admissionId === admId),
      );
      if (matched.length > 0) paymentsByEnc.set(enc.id, matched);
    }

    // Per-care-context hiType derivation (same algorithm as discovery/link).
    // The hiType drives both the consent-scope filter AND the FHIR profile
    // chosen by the bundle builder.
    const ccWithHiType = dateValidContexts.map((cc) => {
      const enc = cc.encounter!;
      const ccHiType = deriveHiType({
        type: enc.type as any,
        admissionId: enc.admissionId,
        hasImmunization: allImmunizations.some((im) => im.encounterId === enc.id),
        hasInvestigation: allInvestigations.some((inv) => inv.encounterId === enc.id),
        hasPrescription:
          (enc.prescriptions?.length || 0) > 0 ||
          (enc as any).labOrders?.length > 0,
        hasDiagnosis: !!(enc.finalDiagnosis || enc.diagnosis || enc.provisionalDiagnosis),
        hasPayment: (paymentsByEnc.get(enc.id)?.length || 0) > 0,
      });
      return { cc, hiType: ccHiType };
    });

    // Apply consent.hiTypes filter — drop care contexts whose derived type
    // is not in the consented scope. Empty/undefined hiTypes means "no
    // restriction" (legacy consents that pre-dated the column).
    const allowedHiTypes = (hiTypes && hiTypes.length > 0) ? new Set(hiTypes) : null;
    const hiTypeFiltered = (allowedHiTypes
      ? ccWithHiType.filter(({ hiType }) => allowedHiTypes.has(hiType))
      : ccWithHiType
    );

    if (allowedHiTypes && hiTypeFiltered.length < ccWithHiType.length) {
      logger.info('Worker: Filtered care contexts to consented hiTypes', {
        transactionId,
        consentedHiTypes: Array.from(allowedHiTypes),
        beforeFilter: ccWithHiType.length,
        afterFilter: hiTypeFiltered.length,
        droppedHiTypes: ccWithHiType
          .filter(({ hiType }) => !allowedHiTypes.has(hiType))
          .map(({ hiType }) => hiType),
      });
    }

    // Apply consent-artefact careContextReferences filter. ABDM rejects
    // (ABDM-7727 / 400) any data-push entry whose `careContextReference` is
    // not on the artefact's authorised list. The list is the ONLY thing the
    // gateway compares against; even if the patient is the same and the
    // dateRange matches, an unlisted reference is a hard reject.
    //
    // `authorisedCareContextRefs` empty/undefined means we never captured
    // the artefact body (legacy consents pre-dating the artefactBody
    // persistence) — in that case fall through with everything we have.
    const authorisedSet = (authorisedCareContextRefs && authorisedCareContextRefs.length > 0)
      ? new Set(authorisedCareContextRefs)
      : null;
    const validContexts = authorisedSet
      ? hiTypeFiltered.filter(({ cc }) => authorisedSet.has(cc.careContextId))
      : hiTypeFiltered;

    if (authorisedSet && validContexts.length < hiTypeFiltered.length) {
      const dropped = hiTypeFiltered
        .filter(({ cc }) => !authorisedSet.has(cc.careContextId))
        .map(({ cc }) => cc.careContextId);
      logger.info('Worker: Filtered care contexts to artefact-authorised refs', {
        transactionId,
        authorisedCount: authorisedSet.size,
        authorisedSample: Array.from(authorisedSet).slice(0, 5),
        beforeFilter: hiTypeFiltered.length,
        afterFilter: validContexts.length,
        droppedRefs: dropped.slice(0, 10),
      });
    }

    careContextRefs = (validContexts.length > 0
      ? validContexts.map((v) => v.cc)
      : careContextsWithEnc
    ).map((cc) => cc.careContextId).filter(Boolean);


    const vitalsByEnc = new Map<string, any[]>();
    for (const v of allVitals) {
      if (!v.encounterId) continue;
      const list = vitalsByEnc.get(v.encounterId) || [];
      list.push(v);
      vitalsByEnc.set(v.encounterId, list);
    }
    const investigationsByEnc = new Map<string, any[]>();
    for (const inv of allInvestigations) {
      if (!inv.encounterId) continue;
      const list = investigationsByEnc.get(inv.encounterId) || [];
      list.push(inv);
      investigationsByEnc.set(inv.encounterId, list);
    }
    const immunizationsByEnc = new Map<string, any[]>();
    for (const im of allImmunizations) {
      if (!im.encounterId) continue;
      const list = immunizationsByEnc.get(im.encounterId) || [];
      list.push(im);
      immunizationsByEnc.set(im.encounterId, list);
    }

    const { buildFHIRBundle } = await import('../common/utils/fhir/fhir-builder');

    // Establish ONE ECDH session for the whole transfer. Every entry MUST be
    // encrypted with this single session key so the HIU can decrypt them all
    // using the one keyMaterial.dhPublicKey we publish in the push payload.
    //
    // ABDM/Fidelius spec: BouncyCastle "curve25519" Weierstrass form.
    // Public keys are 65-byte uncompressed points (`04 || X(32) || Y(32)`).
    // The session key is HKDF-SHA256(sharedSecret.x, salt = first 20 bytes of
    // (senderNonce ⊕ requesterNonce)) and the AES-GCM IV is the LAST 12 bytes
    // of the same XOR — i.e. fully deterministic from the nonces, NO IV
    // prefix is sent on the wire. See `EncryptionService` for details.
    try {
      const peerB64 = keyMaterial.dhPublicKey?.keyValue;
      const peerBytes = peerB64 ? EncryptionService.decodePeerKeyForDiagnostics(peerB64) : Buffer.alloc(0);
      const head = peerBytes.subarray(0, Math.min(8, peerBytes.length)).toString('hex');
      logger.info('Worker: HIU keyMaterial received', {
        transactionId,
        cryptoAlg: keyMaterial.cryptoAlg,
        curveLabel: keyMaterial.curve,
        keyValueLength: peerB64?.length || 0,
        keyBytesLength: peerBytes.length,
        keyHead: head,
        firstByte: peerBytes[0]?.toString(16),
        nonceLength: keyMaterial.nonce ? Buffer.from(keyMaterial.nonce, 'base64').length : 0,
      });
    } catch {
      // diagnostic only
    }

    const ownKeyPair = EncryptionService.generateECDHKeyPair();

    let session: { sessionKey: Buffer; iv: Buffer };
    try {
      session = EncryptionService.deriveSession(
        ownKeyPair.privateKey,
        keyMaterial.dhPublicKey.keyValue,
        ownKeyPair.nonce,
        keyMaterial.nonce,
      );
    } catch (e: any) {
      logger.error('Worker: ECDH derive failed', {
        transactionId,
        error: e?.message,
        keyValuePrefix: keyMaterial.dhPublicKey?.keyValue?.slice(0, 16),
      });
      throw e;
    }

    // ABDM HIU public-key wire format
    // ────────────────────────────────────────────────────────────────────────
    // The HIU side (Fidelius / BouncyCastle) parses incoming public keys with
    //
    //   KeyFactory.getInstance("EC")
    //            .generatePublic(new X509EncodedKeySpec(decodedKey))
    //
    // which strictly requires an X.509 SubjectPublicKeyInfo DER, NOT a raw
    // uncompressed point. Sending the 65-byte raw point (`04||X||Y`) — which
    // is what `ownKeyPair.publicKey` is — yields the very specific error
    //   ABDM-9999: "encoded key spec not recognized
    //               failed to construct sequence from byte[]
    //               corrupted stream - out of bounds length found  ${rand} >= 65"
    // because BC reads the leading `0x04` as ASN.1 OCTET STRING tag and the
    // following byte (a random byte from the X-coordinate) as a DER length —
    // hence the apparent "length" varying across attempts (90/108/126…).
    //
    // We pre-compute the SPKI-wrapped form during keypair generation
    // (`x509PublicKey`); send that on the wire. Salt/IV derivation still uses
    // the underlying uncompressed point, so this is purely an outbound
    // encoding swap. Our own `decodePeerPoint` already accepts both raw and
    // SPKI on inbound for forward-compatibility with HIUs that send raw.
    //
    // EMPIRICAL (live sandbox, ABDM-9999 "Could not read encrypted content …
    // encoded key spec not recognized … Extra data detected in stream"): the
    // ABDM patient-hiu app (Fidelius/BouncyCastle) reads **keyValue** and runs
    // `X509EncodedKeySpec(decode(keyValue))` — so keyValue MUST be the SPKI DER,
    // NOT the raw 65-byte point (raw → "Extra data detected in stream"). Publish
    // the SPKI form in BOTH keyValue and x509PublicKey so any consumer that
    // imports via X509EncodedKeySpec (the Fidelius reference behaviour) works.
    const outX509KeyValue = ownKeyPair.x509PublicKey || ownKeyPair.publicKey;
    const outRawBytes = Buffer.from(ownKeyPair.publicKey, 'base64');
    const outX509Bytes = Buffer.from(outX509KeyValue, 'base64');
    const classifyKey = (b: Buffer) =>
      b.length === 65 && b[0] === 0x04 ? 'raw-uncompressed'
      : b[0] === 0x30 ? 'spki-der'
      : 'unknown';
    logger.info('Worker: outbound dhPublicKey wire format', {
      transactionId,
      keyValueEncoding: classifyKey(outX509Bytes),
      keyValueBytesLength: outX509Bytes.length,
      rawPointBytesLength: outRawBytes.length,
      x509Encoding: classifyKey(outX509Bytes),
      x509BytesLength: outX509Bytes.length,
    });
    const sessionKeyMaterial = {
      cryptoAlg: 'ECDH',
      curve: 'Curve25519',
      dhPublicKey: {
        expiry: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        parameters: 'Curve25519/32byte random key',
        keyValue: outX509KeyValue,
        x509PublicKey: outX509KeyValue,
      },
      nonce: ownKeyPair.nonce,
    };

    const makeEntry = (dataString: string, careContextReference: string) => {
      const content = EncryptionService.encryptWithSessionKey(dataString, session.sessionKey, session.iv);
      return {
        content,
        media: 'application/fhir+json',
        checksum: crypto.createHash('md5').update(content).digest('hex'),
        careContextReference,
      };
    };

    // Build one FHIR bundle + entry per care context. The profile is forced
    // to the per-cc hiType so the BUNDLE we push matches the hiType we
    // ADVERTISED on link/discover. NRCeS profiles (OPConsultRecord,
    // DischargeSummaryRecord, PrescriptionRecord, DiagnosticReportRecord,
    // ImmunizationRecord, WellnessRecord, HealthDocumentRecord) are accepted
    // by ABDM-certified PHR apps; sending a mismatched profile causes the
    // PHR app to silently drop the entry.
    const entries: Array<{ content: string; media: string; checksum: string; careContextReference: string; hiType: AbdmHiType }> = [];

    let totalDocumentsAttached = 0;
    for (const { cc, hiType } of validContexts) {
      const enc = cc.encounter!;
      const profileOverride = hiTypeToProfile(hiType);
      // Non-structured files (PDF/DOC/image) belonging to THIS encounter (or its
      // IPD admission). Read from disk and inlined as base64 DocumentReferences
      // so the bundle carries both structured FHIR AND the original documents.
      const encDocs = allDocuments.filter((d: any) =>
        d.encounterId === enc.id || (enc.admissionId && d.admissionId === enc.admissionId),
      );
      const documentInputs = encDocs.length ? readDocumentsAsBase64(encDocs, transactionId) : [];
      totalDocumentsAttached += documentInputs.length;
      try {
        const fhirBundle = buildFHIRBundle({
          patient: consent.patient,
          doctor: enc.doctor,
          hospital,
          encounter: enc as any,
          vitals: vitalsByEnc.get(enc.id) || [],
          encounterPrescriptions: enc.prescriptions || [],
          investigations: investigationsByEnc.get(enc.id) || [],
          documents: documentInputs,
          immunizations: (immunizationsByEnc.get(enc.id) || []).map((im: any) => ({
            id: im.id,
            vaccineName: im.vaccineName,
            vaccineCode: im.vaccineCode,
            manufacturer: im.manufacturer,
            lotNumber: im.lotNumber,
            expiryDate: im.expiryDate,
            doseNumber: im.doseNumber,
            totalDoses: im.totalDoses,
            site: im.site,
            route: im.route,
            doseQuantity: im.doseQuantity != null ? Number(im.doseQuantity) : null,
            doseUnit: im.doseUnit,
            administeredAt: im.administeredAt,
            reason: im.reason,
            notes: im.notes,
          })),
          payments: (paymentsByEnc.get(enc.id) || []).map((p: any) => ({
            id: p.id,
            amount: p.amount != null ? Number(p.amount) : 0,
            paymentMethod: p.paymentMethod,
            status: p.status,
            receiptNumber: p.receiptNumber,
            transactionId: p.transactionId,
            description: p.description,
            items: p.items,
            paidAt: p.paidAt,
            createdAt: p.createdAt,
            appointmentId: p.appointmentId,
            admissionId: p.admissionId,
          })),
          profileOverride,
        });
        entries.push({ ...makeEntry(JSON.stringify(fhirBundle), cc.careContextId), hiType });
      } catch (buildErr: any) {
        logger.warn('Worker: Failed to build FHIR bundle for encounter, using fallback', {
          encounterId: enc.id,
          error: buildErr.message,
        });
        const fallback = buildBasicFHIRBundle([enc]);
        entries.push({ ...makeEntry(JSON.stringify(fallback), cc.careContextId), hiType });
      }
    }

    // If no entries were built (e.g. no encounters in range OR all dropped
    // by the consent-hiType filter / artefact careContextReference filter),
    // do NOT push a synthetic empty bundle — ABDM treats that as "data
    // delivered" which misleads the user. Instead skip the push entirely
    // and notify FAILED with a precise reason.
    //
    // This is also UNRECOVERABLE — the same job re-running in 5s/15s will
    // hit the same DB state and fail identically, generating duplicate
    // FAILED notifications to ABDM (which the patient sees as repeated
    // "fetch failed" toasts). We classify the failure so BullMQ skips
    // remaining attempts.
    if (entries.length === 0) {
      // Disambiguate the most useful error variant for the patient.
      const hadAuthorisedFilter = !!(authorisedCareContextRefs && authorisedCareContextRefs.length > 0);
      const droppedByAuthorisedFilter = hadAuthorisedFilter && hiTypeFiltered.length > 0 && validContexts.length === 0;
      let description: string;
      if (droppedByAuthorisedFilter) {
        description = 'Care contexts referenced in this consent are no longer available at the HIP. Please unlink and re-link records, then grant a new consent.';
      } else if (dateValidContexts.length === 0) {
        description = 'No encounters fall within the consented date range.';
      } else if (hiTypeFiltered.length === 0) {
        description = 'No records of the consented health-information types are available for this patient.';
      } else {
        description = 'No records match the consent scope.';
      }
      logger.info('Worker: No care contexts match consent scope, marking transfer as FAILED with no-data', {
        transactionId,
        dateRange,
        consentedHiTypes: hiTypes,
        droppedByAuthorisedFilter,
        description,
      });
      throw new UnrecoverablePushError('No care contexts match the consent scope', description);
    }

    logger.info('Worker: Built FHIR bundles per consented hiType', {
      transactionId,
      bundleCount: entries.length,
      documentsAttached: totalDocumentsAttached,
      hiTypeBreakdown: entries.reduce((acc, e) => {
        acc[e.hiType] = (acc[e.hiType] || 0) + 1;
        return acc;
      }, {} as Record<string, number>),
    });

    // ABDM data push supports pagination (pageNumber is 0-indexed, pageCount is
    // the total number of pages). Split entries into bounded pages so large
    // record sets are delivered in chunks instead of one oversized POST. The
    // HIU side retains the keypair until the last page (pageNumber >= pageCount-1).
    const PAGE_SIZE = 10;
    const pages: (typeof entries)[] = [];
    for (let i = 0; i < entries.length; i += PAGE_SIZE) {
      pages.push(entries.slice(i, i + PAGE_SIZE));
    }
    if (pages.length === 0) pages.push([]);
    const pageCount = pages.length;

    for (let pageNumber = 0; pageNumber < pageCount; pageNumber++) {
      // Wire schema (ABDM "Transferring Health Data" OpenAPI, op
      // `callingDataPushUrl` at /api-hiu/data/notification):
      //   { transactionId, pageNumber, pageCount, entries[], keyMaterial }
      //
      // entry shape: { content, media, checksum, careContextReference }
      //
      // STRICT — we deliberately do NOT include any extension fields
      // (consentId, requestId, …): several HIUs run a JSON-schema validator
      // that rejects unknown keys with a generic 400, which is exactly the
      // failure mode we hit before this strip.
      const wireEntries = pages[pageNumber].map(({ content, media, checksum, careContextReference }) => ({
        content,
        media,
        checksum,
        careContextReference,
      }));
      const pushBody = {
        transactionId,
        pageNumber,
        pageCount,
        entries: wireEntries,
        keyMaterial: sessionKeyMaterial,
      };
      try {
        await abdmClient.post(dataPushUrl, pushBody);
        logger.info('Worker: pushed data page', {
          transactionId,
          pageNumber,
          pageCount,
          entries: pages[pageNumber].length,
        });
      } catch (pushErr: any) {
        // Surface the HIU's actual error body so we can diagnose 4xx without
        // re-running. Axios attaches the parsed body on `response.data` —
        // strip large encrypted blobs from the failed-payload echo so we
        // don't dump megabytes per attempt.
        const respStatus = pushErr?.response?.status;
        const respBody = pushErr?.response?.data;
        const respHeaders = pushErr?.response?.headers;
        const compactedBody = (typeof respBody === 'object' && respBody)
          ? JSON.stringify(respBody).slice(0, 800)
          : String(respBody).slice(0, 800);
        logger.error('Worker: data push HTTP error', {
          transactionId,
          pageNumber,
          dataPushUrl,
          status: respStatus,
          responseBody: compactedBody,
          contentType: respHeaders?.['content-type'],
          payloadKeys: Object.keys(pushBody),
          firstEntryKeys: wireEntries[0] ? Object.keys(wireEntries[0]) : [],
          keyMaterialCurve: sessionKeyMaterial.curve,
          keyMaterialParams: sessionKeyMaterial.dhPublicKey.parameters,
        });
        throw pushErr;
      }
    }

    // Per-care-context delivery status for the data-flow notification.
    const statusResponses = entries.map((e) => ({
      careContextReference: e.careContextReference,
      hiStatus: 'DELIVERED',
      description: 'Transferred',
    }));

    // Notify ABDM: data delivered. Use the tenant's hipId everywhere this
    // notification carries a HIP identifier — the gateway expects it to
    // match the X-HIP-ID we serve under, otherwise it treats the notify as
    // coming from a different facility.
    const notifyTenant = tenantHospitalId
      ? await resolveHipTenant(tenantHospitalId).catch(() => null)
      : null;
    const notifyHipId = notifyTenant?.hipId || tenantHipId || abdmConfig.hip.id;
    await abdmClient.post(
      abdmConfig.endpoints.hip.dataFlowNotify,
      {
        notification: {
          consentId: consentAbdmId,
          transactionId,
          doneAt: new Date().toISOString(),
          notifier: { type: 'HIP', id: notifyHipId },
          statusNotification: { sessionStatus: 'TRANSFERRED', hipId: notifyHipId, statusResponses },
        },
      },
      { 'X-HIP-ID': notifyHipId },
      notifyTenant,
    );

    logger.info('Worker: Health data push completed', { transactionId, entriesCount: entries.length, pageCount });
  } catch (error: any) {
    const isUnrecoverable = error instanceof UnrecoverablePushError;
    const description: string = isUnrecoverable
      ? (error as UnrecoverablePushError).description
      : 'Transfer failed';

    logger.error('Worker: Health data push failed', {
      transactionId,
      error: error.message,
      unrecoverable: isUnrecoverable,
      attempt: job.attemptsMade + 1,
      attemptsAllowed: job.opts?.attempts,
    });

    // Notify ABDM: push failed. Send the FAILED notification at most ONCE per
    // transaction — for unrecoverable failures we know retries won't help, and
    // for transient failures we let the final attempt own the FAILED notify
    // (BullMQ surfaces `attemptsMade` 0-indexed so `attemptsMade + 1 === attempts`
    // means "this is the last attempt").
    const isLastAttempt = (job.attemptsMade + 1) >= (job.opts?.attempts || 1);
    const shouldNotify = isUnrecoverable || isLastAttempt;
    if (shouldNotify) {
      // Resolve the careContextReferences to report as ERRORED. Prefer the ones
      // we were about to ship; fall back to the artefact-authorised refs. ABDM
      // rejects a statusResponses entry whose careContextReference is empty
      // (ABDM-7727 / 400), so a "no data" failure (stale/empty consent) has
      // NOTHING valid to report — sending careContextReference:'' just spams the
      // CM with 400s. In that case skip the notify (the HIU side already skips
      // for the same reason); the CM ages the transfer out on its own.
      const failRefs = careContextRefs.length > 0
        ? careContextRefs
        : (authorisedCareContextRefs && authorisedCareContextRefs.length > 0
            ? authorisedCareContextRefs
            : []);
      if (failRefs.length === 0) {
        logger.warn('Worker: skipping FAILED notification — no careContextReference to report (empty consent scope; would 400)', {
          transactionId,
          consentAbdmId,
          reason: description,
        });
      } else {
        try {
          const failTenant = tenantHospitalId
            ? await resolveHipTenant(tenantHospitalId).catch(() => null)
            : null;
          const failHipId = failTenant?.hipId || tenantHipId || abdmConfig.hip.id;
          await abdmClient.post(
            abdmConfig.endpoints.hip.dataFlowNotify,
            {
              notification: {
                consentId: consentAbdmId,
                transactionId,
                doneAt: new Date().toISOString(),
                notifier: { type: 'HIP', id: failHipId },
                statusNotification: {
                  sessionStatus: 'FAILED',
                  hipId: failHipId,
                  statusResponses: failRefs.map((ref) => ({
                    careContextReference: ref,
                    hiStatus: 'FAILED',
                    description,
                  })),
                },
              },
            },
            { 'X-HIP-ID': failHipId },
            failTenant,
          );
        } catch (notifyErr: any) {
          logger.error('Worker: Failed to send FAILED notification to ABDM', { error: notifyErr.message });
        }
      }
    } else {
      logger.info('Worker: Skipping FAILED notification — will retry', {
        transactionId,
        attempt: job.attemptsMade + 1,
        attemptsAllowed: job.opts?.attempts,
      });
    }

    // Surface unrecoverable failures to BullMQ as `UnrecoverableError` so it
    // skips the remaining attempts. Transient failures keep the original error
    // type so the queue's exponential backoff still kicks in.
    if (isUnrecoverable) {
      throw new UnrecoverableError(error.message);
    }
    throw error;
  }
}

function buildBasicFHIRBundle(encounters: any[]): any {
  return {
    resourceType: 'Bundle',
    type: 'collection',
    timestamp: new Date().toISOString(),
    entry: encounters.map((enc) => ({
      resource: {
        resourceType: 'Encounter',
        id: enc.id,
        status: 'finished',
        class: { system: 'http://terminology.hl7.org/CodeSystem/v3-ActCode', code: 'AMB' },
        period: { start: enc.createdAt?.toISOString(), end: enc.updatedAt?.toISOString() },
      },
    })),
  };
}

export function startHealthDataPushWorker(): void {
  createHealthDataPushWorker(processHealthDataPush);
  logger.info('Health data push worker started');
  // Snapshot the queue depth at boot so a pre-existing backlog (jobs enqueued
  // by a previous run that never drained) is immediately visible. A high
  // `waiting`/`delayed` here means jobs are stuck, not that requests aren't
  // arriving.
  void logHealthDataPushQueueCounts('worker-boot');
}
