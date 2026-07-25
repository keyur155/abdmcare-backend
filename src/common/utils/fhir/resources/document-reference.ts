import {
  FHIRResource,
  FHIRReference,
  NRCES_PROFILES,
  generateUUID,
} from '../coding-tables';

/**
 * A non-structured document (PDF/DOC/image/etc.) to attach to a bundle.
 * `data` is the base64-encoded file content — ABDM requires attachments to be
 * inlined as base64 (the docs explicitly say "Do not send over such URL
 * reference"), so callers must read the file bytes before building.
 */
export interface DocumentInput {
  id: string;
  title: string;
  /** MIME type, e.g. application/pdf, image/png, application/msword. */
  contentType: string;
  /** base64-encoded file content. */
  data: string;
  size?: number;
  /** ISO timestamp the document was created. */
  creation?: string;
}

/**
 * Build FHIR DocumentReference resources from arbitrary uploaded/generated
 * files. Mirrors the ABDM "HealthDocumentRecord" / attachment model: the file
 * rides inline as `content[].attachment.data` (base64) with its `contentType`.
 * See Docs → Milestone 2 → Packaging Health Data (DocumentReference is a
 * supported entry for every HI type).
 */
export function buildDocumentReferences(
  docs: DocumentInput[] | undefined,
  patientRef: FHIRReference,
  authorRef?: FHIRReference,
  encounterRef?: FHIRReference,
): Array<{ uuid: string; resource: FHIRResource }> {
  return (docs || [])
    .filter((d) => d && d.data)
    .map((d) => {
      const uuid = generateUUID();
      const resource: FHIRResource = {
        resourceType: 'DocumentReference',
        id: uuid,
        meta: { profile: [NRCES_PROFILES.DocumentReference] },
        status: 'current',
        docStatus: 'final',
        type: { text: d.title || 'Document' },
        subject: patientRef,
        ...(authorRef ? { author: [authorRef] } : {}),
        ...(d.creation ? { date: d.creation } : {}),
        content: [
          {
            attachment: {
              contentType: d.contentType || 'application/pdf',
              data: d.data,
              title: d.title || 'Document',
              ...(d.creation ? { creation: d.creation } : {}),
              ...(typeof d.size === 'number' ? { size: d.size } : {}),
            },
          },
        ],
        ...(encounterRef ? { context: { encounter: [encounterRef] } } : {}),
      };
      return { uuid, resource };
    });
}
