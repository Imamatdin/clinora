import { createHash } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../identity/access.js';
import type { Role } from '../identity/roles.js';
import { requireRole, type ClinicContext } from '../../server/roles.js';

/** Catalog and import are administrator work (task 005). The CEO reads the catalog; writes need the administrator role. */
export const CATALOG_WRITERS = ['administrator'] as const satisfies readonly Role[];
export const CATALOG_READERS = ['administrator', 'ceo'] as const satisfies readonly Role[];

export const fail = (code: ConstructorParameters<typeof DomainError>[0]): never => { throw new DomainError(code); };
export const Key = z.string().min(8).max(200);
export const authorize = (ctx: ClinicContext, roles: readonly Role[]) => requireRole(ctx.tx, ctx.actorId, ctx.clinicId, roles);

const stable = (value: unknown): string => JSON.stringify(value, (_k, v) => v && typeof v === 'object' && !Array.isArray(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
/**
 * Replays the stored result for the same clinic, actor, operation and key; a different payload under the
 * same key is IDEMPOTENCY_CONFLICT. The advisory lock makes a concurrent duplicate wait for the first.
 */
export async function once<T>(ctx: ClinicContext, operation: string, input: { idempotencyKey: string }, work: () => Promise<T>): Promise<T> {
  const scope = [ctx.clinicId, ctx.actorId, operation, input.idempotencyKey];
  await ctx.tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(scope)]);
  const hash = createHash('sha256').update(stable(input)).digest('hex');
  const old = (await ctx.tx.query('SELECT payload_hash,response FROM idempotency_records WHERE clinic_id=$1 AND actor_id=$2 AND operation=$3 AND key=$4', scope)).rows[0];
  if (old) return old.payload_hash === hash ? old.response as T : fail('IDEMPOTENCY_CONFLICT');
  const result = await work();
  await ctx.tx.query('INSERT INTO idempotency_records(clinic_id,actor_id,operation,key,payload_hash,response) VALUES($1,$2,$3,$4,$5,$6)', [...scope, hash, JSON.stringify(result)]);
  return result;
}

export type Names = { uzCyrl: string; uzLatn: string | null; ru: string | null };
export const names = (r: { name_uz_cyrl: string; name_uz_latn: string | null; name_ru: string | null }): Names =>
  ({ uzCyrl: r.name_uz_cyrl, uzLatn: r.name_uz_latn, ru: r.name_ru });

/**
 * Script-insensitive key, the TypeScript twin of SQL registration_fold() (migration 015): Uzbek
 * Cyrillic, Uzbek Latin and Russian spellings fold to one lowercase Latin skeleton. Used to match
 * spreadsheet rows by name; tests keep it equal to the SQL function.
 */
export function fold(input: string | null | undefined): string {
  const from = 'абвгдезийклмнопрстуфхцыэўқғҳъь', to = 'abvgdeziyklmnoprstufxsieoqgh';
  let s = (input ?? '').toLowerCase().split('').map(ch => { const i = from.indexOf(ch); return i < 0 ? ch : to[i] ?? ''; }).join('');
  s = s.replaceAll('ё', 'yo').replaceAll('ж', 'j').replaceAll('ч', 'ch').replaceAll('ш', 'sh').replaceAll('щ', 'sh').replaceAll('ю', 'yu').replaceAll('я', 'ya');
  s = s.replace(/[ʻʼ'`‘’ʹ]/g, '');
  for (const [a, b] of [['kh', 'x'], ['h', 'x'], ['q', 'k'], ['ye', 'e'], ['ts', 's'], ['zh', 'j'], ['dj', 'j'], ['w', 'v']] as const) s = s.replaceAll(a, b);
  return s.replace(/[^a-z0-9]+/g, ' ').trim();
}
