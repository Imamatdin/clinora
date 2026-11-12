import { DocumentVersion } from '../../contracts/index.js';
import { DomainError } from '../identity/access.js';
import type { Tx } from '../../server/database.js';

/*
 * Approval state of a visit document, shared by the notebook (task 002), the doctor workspace (task 010)
 * and the assistant (task 003C). An approval always references one immutable document version. Once a
 * document has an approval, every newer version is an explicit amendment that names the approval it
 * amends and carries a reason; an approved version is never silently replaced by a plain draft.
 */
type ClinicalField = DocumentVersion['fields'][number];
const fail = (code: ConstructorParameters<typeof DomainError>[0]): never => { throw new DomainError(code); };

export type ApprovalRef = { id: string; versionId: string; revision: number; approvedAt: string; approvedBy: string; source: 'note' | 'assistant' };

/** Latest approval of a document (highest approved revision), from either approval table. */
export async function latestApproval(tx: Tx, documentId: string): Promise<ApprovalRef | null> {
  const row = (await tx.query(`SELECT id, version_id, revision, approved_at, approved_by, source FROM (
      SELECT id, version_id, revision, approved_at, approved_by, 'note' source FROM note_approvals WHERE document_id=$1
      UNION ALL
      SELECT id, version_id, revision, approved_at, approved_by, 'assistant' source FROM assistant_approvals WHERE document_id=$1) a
    ORDER BY revision DESC LIMIT 1`, [documentId])).rows[0];
  return row ? { id: row.id, versionId: row.version_id, revision: row.revision, approvedAt: new Date(row.approved_at).toISOString(), approvedBy: row.approved_by, source: row.source } : null;
}

/** The current version of a locked document row, or null for an empty note. */
export async function currentVersion(tx: Tx, doc: { id: string; current_version_id: string | null }): Promise<DocumentVersion | null> {
  if (!doc.current_version_id) return null;
  const row = (await tx.query('SELECT data FROM document_versions WHERE document_id=$1 AND id=$2', [doc.id, doc.current_version_id])).rows[0];
  return row ? DocumentVersion.parse(row.data) : null;
}

export type VersionKind = Pick<DocumentVersion, 'kind' | 'amendsApprovalId' | 'amendmentReason'>;
/**
 * Kind of the next draft version. No approval: an ordinary clinician edit. Current version approved:
 * an amendment, which needs a reason. Current version is already an amendment draft of the latest
 * approval: keep amending it with the same (or a newly given) reason.
 */
export function nextDraftKind(approval: ApprovalRef | null, current: DocumentVersion | null, reason: string | undefined): VersionKind {
  if (!approval) return { kind: 'clinician_edit', amendsApprovalId: null, amendmentReason: null };
  const continuing = current && current.id !== approval.versionId && current.kind === 'amendment' && current.amendsApprovalId === approval.id;
  const why = reason?.trim() || (continuing ? current!.amendmentReason : null);
  if (!why) return fail('INVALID_TRANSITION');
  return { kind: 'amendment', amendsApprovalId: approval.id, amendmentReason: why };
}

/** Fields of the current version that another editor owns, kept unchanged in a new version. */
export const carriedFields = (current: DocumentVersion | null, owned: ReadonlySet<string>): ClinicalField[] =>
  (current?.fields ?? []).filter(f => !owned.has(f.key));

/**
 * Checks shared by every approval: the version is the current one, not an AI draft, has at least one
 * recorded value, and nothing is still an unreviewed AI proposal, uncertain or in conflict.
 */
export function requireApprovable(current: DocumentVersion | null, expectedRevision: number, approval: ApprovalRef | null): DocumentVersion {
  if (!current || current.revision !== expectedRevision) return fail('STALE_VERSION');
  if (approval && approval.versionId === current.id) return fail('INVALID_TRANSITION');
  if (current.kind === 'ai_draft' || !current.fields.some(f => f.value !== null)) return fail('INVALID_TRANSITION');
  if (current.fields.some(f => f.unresolvedConflict !== null || f.status === 'uncertain' || (f.origin === 'ai' && f.status === 'proposed'))) return fail('INVALID_TRANSITION');
  return current;
}
