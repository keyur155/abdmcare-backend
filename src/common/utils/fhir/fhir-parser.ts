// ─────────────────────────────────────────────────────────────────────────────
// FHIR Bundle Parser — Extracts structured data from incoming FHIR documents
// Used by HIU to parse health records received from HIPs via ABDM
// ─────────────────────────────────────────────────────────────────────────────

export interface ParsedFHIRData {
  patientInfo: { name: string; gender: string; dob?: string };
  encounters: Array<{ date: string; type: string; status: string }>;
  conditions: Array<{ code: string; display: string; clinicalStatus: string }>;
  observations: Array<{ code: string; display: string; value: string; unit: string; date: string }>;
  medications: Array<{ name: string; dosage: string; frequency: string; status: string }>;
  reports: Array<{ code: string; display: string; status: string; conclusion?: string }>;
  // Newly surfaced — these are the FHIR resource types ABDM HIPs commonly
  // attach but the previous parser silently dropped, so the UI only ever saw
  // structured tables and missed the real "document" content.
  procedures: Array<{ code: string; display: string; status: string; date?: string }>;
  immunizations: Array<{ code: string; display: string; status: string; date?: string }>;
  allergies: Array<{ code: string; display: string; criticality?: string; reaction?: string }>;
  // The Composition's `text.div` is the human-readable rendered version of
  // the entire document (FHIR-required Narrative). For OPConsult/discharge
  // this is effectively the "document body" the clinician should read first.
  // We also capture per-section narratives so the UI can show a structured
  // document view instead of a flat table.
  narrative?: string;
  sections?: Array<{ title: string; html: string }>;
  // DocumentReference attachments — typically scanned reports, uploaded
  // prescriptions, lab PDFs. Each carries either an inline base64 blob or
  // an external URL plus its content type (e.g. application/pdf, image/png).
  documents: Array<{
    title: string;
    contentType: string;
    url?: string;
    data?: string;       // base64 — large; UI shows a "view inline" toggle
    size?: number;
    creation?: string;
  }>;
  sourceHIP?: string;
  compositionTitle?: string;
  compositionDate?: string;
}

function extractCoding(codeableConcept: any): { code: string; display: string } {
  if (!codeableConcept) return { code: '', display: '' };
  const coding = codeableConcept.coding?.[0] || {};
  return {
    code: coding.code || codeableConcept.code || '',
    display: coding.display || codeableConcept.text || '',
  };
}

function extractPatient(resource: any): ParsedFHIRData['patientInfo'] {
  const nameObj = resource.name?.[0] || {};
  const parts = [nameObj.prefix, nameObj.given, nameObj.family, nameObj.suffix]
    .flat()
    .filter(Boolean);
  return {
    name: nameObj.text || parts.join(' ') || 'Unknown',
    gender: resource.gender || 'unknown',
    dob: resource.birthDate,
  };
}

function extractEncounter(resource: any): ParsedFHIRData['encounters'][0] {
  const { display } = extractCoding(resource.type?.[0]);
  return {
    date: resource.period?.start || resource.meta?.lastUpdated || '',
    type: display || resource.class?.display || resource.class?.code || 'Unknown',
    status: resource.status || 'unknown',
  };
}

function extractCondition(resource: any): ParsedFHIRData['conditions'][0] {
  const { code, display } = extractCoding(resource.code);
  const clinicalStatus = resource.clinicalStatus?.coding?.[0]?.code
    || resource.clinicalStatus?.text
    || 'unknown';
  return { code, display, clinicalStatus };
}

function extractObservation(resource: any): ParsedFHIRData['observations'][0] {
  const { code, display } = extractCoding(resource.code);
  let value = '';
  let unit = '';

  if (resource.valueQuantity) {
    value = String(resource.valueQuantity.value ?? '');
    unit = resource.valueQuantity.unit || resource.valueQuantity.code || '';
  } else if (resource.valueString) {
    value = resource.valueString;
  } else if (resource.valueCodeableConcept) {
    const v = extractCoding(resource.valueCodeableConcept);
    value = v.display || v.code;
  } else if (resource.component) {
    value = resource.component
      .map((c: any) => {
        const cd = extractCoding(c.code);
        const v = c.valueQuantity ? `${c.valueQuantity.value} ${c.valueQuantity.unit || ''}` : '';
        return `${cd.display}: ${v}`;
      })
      .join('; ');
  }

  return {
    code,
    display,
    value,
    unit,
    date: resource.effectiveDateTime || resource.issued || resource.meta?.lastUpdated || '',
  };
}

function extractMedication(resource: any): ParsedFHIRData['medications'][0] {
  const med = extractCoding(resource.medicationCodeableConcept);
  const dosageInst = resource.dosageInstruction?.[0] || {};
  const timing = dosageInst.timing?.code?.text
    || dosageInst.timing?.repeat?.frequency
    || dosageInst.text
    || '';
  const dose = dosageInst.doseAndRate?.[0]?.doseQuantity
    ? `${dosageInst.doseAndRate[0].doseQuantity.value} ${dosageInst.doseAndRate[0].doseQuantity.unit || ''}`
    : dosageInst.text || '';

  return {
    name: med.display || med.code || 'Unknown',
    dosage: dose,
    frequency: String(timing),
    status: resource.status || 'unknown',
  };
}

function extractDiagnosticReport(resource: any): ParsedFHIRData['reports'][0] {
  const { code, display } = extractCoding(resource.code);
  return {
    code,
    display,
    status: resource.status || 'unknown',
    conclusion: resource.conclusion,
  };
}

function extractProcedure(resource: any): ParsedFHIRData['procedures'][0] {
  const { code, display } = extractCoding(resource.code);
  const date = resource.performedDateTime
    || resource.performedPeriod?.start
    || resource.meta?.lastUpdated;
  return {
    code,
    display,
    status: resource.status || 'unknown',
    date,
  };
}

function extractImmunization(resource: any): ParsedFHIRData['immunizations'][0] {
  const { code, display } = extractCoding(resource.vaccineCode);
  return {
    code,
    display,
    status: resource.status || 'unknown',
    date: resource.occurrenceDateTime || resource.recorded || resource.meta?.lastUpdated,
  };
}

function extractAllergy(resource: any): ParsedFHIRData['allergies'][0] {
  const { code, display } = extractCoding(resource.code);
  // FHIR allergy can have multiple reactions; surface the first manifestation
  // as a short summary string. Anything more elaborate goes into the raw
  // bundle which the UI can show on demand.
  const firstReaction = resource.reaction?.[0]?.manifestation?.[0];
  const reactionText = firstReaction
    ? extractCoding(firstReaction).display || firstReaction.text || ''
    : '';
  return {
    code,
    display,
    criticality: resource.criticality,
    reaction: reactionText,
  };
}

type BinaryRecord = { contentType: string; data?: string };

// Index every Binary resource in the (possibly nested) bundle by all the keys
// an Attachment.url might use to reference it: `Binary/<id>`, the bare `<id>`,
// and the entry.fullUrl (often `urn:uuid:<id>`). ABDM HIPs frequently send a
// DocumentReference/DiagnosticReport whose attachment is a REFERENCE to a
// separate Binary resource that actually holds the base64 PDF/DOC/image.
function collectBinaries(
  b: any,
  index: Map<string, BinaryRecord>,
  all: BinaryRecord[],
): void {
  if (!b || !Array.isArray(b.entry)) return;
  for (const entry of b.entry) {
    const resource = entry.resource || entry;
    if (!resource?.resourceType) continue;
    if (resource.resourceType === 'Bundle') {
      collectBinaries(resource, index, all);
      continue;
    }
    if (resource.resourceType === 'Binary') {
      const rec: BinaryRecord = {
        contentType: resource.contentType || 'application/octet-stream',
        data: resource.data,
      };
      all.push(rec);
      if (resource.id) {
        index.set(`Binary/${resource.id}`, rec);
        index.set(resource.id, rec);
      }
      if (entry.fullUrl) index.set(entry.fullUrl, rec);
    }
  }
}

// Turn a FHIR Attachment into a UI document, resolving Binary references to the
// actual base64 payload when the attachment carries no inline `data`.
function resolveAttachment(
  attachment: any,
  binaryIndex: Map<string, BinaryRecord>,
): ParsedFHIRData['documents'][0] | null {
  if (!attachment) return null;
  let data: string | undefined = attachment.data;
  let contentType: string = attachment.contentType || 'application/octet-stream';
  let url: string | undefined = attachment.url;

  if (!data && url) {
    const bin =
      binaryIndex.get(url) ||
      binaryIndex.get(url.replace(/^urn:uuid:/, '')) ||
      binaryIndex.get(url.replace(/^Binary\//, '')) ||
      binaryIndex.get(url.replace(/^#/, ''));
    if (bin) {
      data = bin.data;
      if (bin.contentType) contentType = bin.contentType;
    }
    // Keep the url only if it's an externally fetchable http(s) link. Internal
    // references (Binary/…, urn:uuid:…, #contained) are meaningless to the UI
    // once we've either inlined the data or failed to resolve it.
    if (url && !/^https?:\/\//i.test(url)) url = undefined;
  }

  if (!data && !url) return null;
  return {
    title: attachment.title || 'Document',
    contentType,
    url,
    data,
    size: typeof attachment.size === 'number' ? attachment.size : undefined,
    creation: attachment.creation,
  };
}

function extractDocumentReferences(
  resource: any,
  binaryIndex: Map<string, BinaryRecord>,
): ParsedFHIRData['documents'] {
  const baseTitle =
    resource.description || extractCoding(resource.type).display || 'Document';
  const out: ParsedFHIRData['documents'] = [];
  const contents = Array.isArray(resource.content) ? resource.content : [];
  for (const c of contents) {
    const doc = resolveAttachment(c?.attachment, binaryIndex);
    if (doc) {
      out.push({
        ...doc,
        title: doc.title !== 'Document' ? doc.title : baseTitle,
        creation: doc.creation || resource.date,
      });
    }
  }
  return out;
}

// FHIR Narrative.div is XHTML wrapped in <div xmlns="http://www.w3.org/1999/xhtml">.
// We strip the namespace + outer div so the UI can render it as inline HTML
// without attribute clutter or risk of leaking unexpected XML.
function cleanNarrative(narrative: any): string | undefined {
  const div: string | undefined = narrative?.div;
  if (typeof div !== 'string' || !div.length) return undefined;
  return div
    .replace(/<div\s+xmlns=["']http:\/\/www\.w3\.org\/1999\/xhtml["']\s*>/i, '<div>')
    .trim();
}

export function parseFHIRBundle(bundle: any): ParsedFHIRData {
  const result: ParsedFHIRData = {
    patientInfo: { name: 'Unknown', gender: 'unknown' },
    encounters: [],
    conditions: [],
    observations: [],
    medications: [],
    reports: [],
    procedures: [],
    immunizations: [],
    allergies: [],
    documents: [],
  };

  // Pre-pass: index every Binary resource so attachments that reference one
  // (Binary/<id>, urn:uuid:<id>) can be resolved to their base64 payload.
  const binaryIndex = new Map<string, BinaryRecord>();
  const allBinaries: BinaryRecord[] = [];
  collectBinaries(bundle, binaryIndex, allBinaries);

  // Walk entries recursively so nested Bundles (some HIPs wrap several
  // document Bundles inside a single collection Bundle) don't get silently
  // dropped — every leaf resource is merged into the same `result`.
  const walk = (b: any): void => {
    if (!b || !Array.isArray(b.entry)) return;

    for (const entry of b.entry) {
      const resource = entry.resource || entry;
      if (!resource?.resourceType) continue;

      switch (resource.resourceType) {
        case 'Bundle':
          walk(resource);
          break;

        case 'Composition': {
        result.compositionTitle = resource.title;
        result.compositionDate = resource.date;
        if (resource.custodian?.display) {
          result.sourceHIP = resource.custodian.display;
        }
        // Top-level Composition.text is the document narrative — the
        // human-readable version of the WHOLE document.
        const topNarrative = cleanNarrative(resource.text);
        if (topNarrative) result.narrative = topNarrative;
        // Each section has its own narrative (Diagnoses, Medications, etc.).
        // Surface them individually so the UI can render a "structured
        // document" view that matches what the patient sees in their PHR.
        if (Array.isArray(resource.section)) {
          result.sections = resource.section
            .map((s: any) => {
              const html = cleanNarrative(s?.text);
              if (!html) return null;
              return { title: s.title || extractCoding(s.code).display || 'Section', html };
            })
            .filter(Boolean) as Array<{ title: string; html: string }>;
        }
        break;
      }

      case 'Patient':
        result.patientInfo = extractPatient(resource);
        break;

      case 'Encounter':
        result.encounters.push(extractEncounter(resource));
        break;

      case 'Condition':
        result.conditions.push(extractCondition(resource));
        break;

      case 'Observation':
        result.observations.push(extractObservation(resource));
        break;

      case 'MedicationRequest':
      case 'MedicationStatement':
        result.medications.push(extractMedication(resource));
        break;

      case 'DiagnosticReport': {
        result.reports.push(extractDiagnosticReport(resource));
        // Lab/radiology PDFs ride in DiagnosticReport.presentedForm[] — surface
        // each as a downloadable document so the actual report isn't lost.
        const drTitle = extractCoding(resource.code).display || 'Diagnostic Report';
        const forms = Array.isArray(resource.presentedForm) ? resource.presentedForm : [];
        for (const att of forms) {
          const doc = resolveAttachment(att, binaryIndex);
          if (doc) {
            result.documents.push({
              ...doc,
              title: doc.title !== 'Document' ? doc.title : `${drTitle} (attachment)`,
              creation: doc.creation || resource.issued || resource.effectiveDateTime,
            });
          }
        }
        break;
      }

      case 'Procedure':
        result.procedures.push(extractProcedure(resource));
        break;

      case 'Immunization':
        result.immunizations.push(extractImmunization(resource));
        break;

      case 'AllergyIntolerance':
        result.allergies.push(extractAllergy(resource));
        break;

      case 'DocumentReference':
        result.documents.push(...extractDocumentReferences(resource, binaryIndex));
        break;

      case 'Media': {
        // Images (e.g. wound photos, scanned forms) arrive as Media.content.
        const doc = resolveAttachment(resource.content, binaryIndex);
        if (doc) {
          result.documents.push({
            ...doc,
            title: doc.title !== 'Document' ? doc.title : (extractCoding(resource.type).display || 'Media'),
            creation: doc.creation || resource.createdDateTime || resource.issued,
          });
        }
        break;
      }

      case 'Organization':
        if (!result.sourceHIP && resource.name) {
          result.sourceHIP = resource.name;
        }
        break;
      }
    }
  };

  walk(bundle);

  // Surface any Binary that no DocumentReference/DiagnosticReport/Media pointed
  // at (some HIPs send a bare Binary as the whole document). Dedupe against
  // already-surfaced documents by a short data signature so we never show the
  // same PDF twice.
  const seen = new Set(
    result.documents.map((d) => (d.data || d.url || '').slice(0, 64)).filter(Boolean),
  );
  for (const bin of allBinaries) {
    if (!bin.data) continue;
    const sig = bin.data.slice(0, 64);
    if (seen.has(sig)) continue;
    seen.add(sig);
    result.documents.push({ title: 'Document', contentType: bin.contentType, data: bin.data });
  }

  return result;
}
