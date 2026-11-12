import { randomUUID } from 'node:crypto';
import type { Tx } from '../database.js';

export type AuditActor = { actorId: string; clinicId: string | null };

/**
 * Writes one audit event in the caller's transaction, so the event commits or rolls back with the change.
 * `detail` is non-identifying context only (ids, statuses, amounts, counts). Never patient names,
 * phone numbers, clinical text, tokens or secrets: audit_events is readable by managers and exported.
 */
export async function withAudit(tx: Tx, actor: AuditActor, action: string, resourceId: string, detail: Record<string, unknown> | null = null): Promise<void> {
  if (!/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/.test(action)) throw new Error('Audit action must be a dotted lower-case name');
  await tx.query('INSERT INTO audit_events(id, actor_id, clinic_id, action, resource_id, detail) VALUES ($1, $2, $3, $4, $5, $6)',
    [randomUUID(), actor.actorId, actor.clinicId, action, resourceId, detail === null ? null : JSON.stringify(detail, bigintReplacer)]);
}
const bigintReplacer = (_key: string, value: unknown) => typeof value === 'bigint' ? value.toString() : value;
