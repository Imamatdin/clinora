import type { z } from 'zod';
import { DomainError } from '../../modules/identity/access.js';
import type { Role } from '../../modules/identity/roles.js';
import type { ClinicContext } from '../roles.js';

export type Body = () => Promise<unknown>;
/**
 * One clinic route, relative to /api/clinics/:clinicId/. `roles` is checked by requireRole against the
 * database before the body is read. Params captured by the pattern must be UUIDs (checked by the router).
 */
export type Route = {
  method: 'GET' | 'POST'; pattern: RegExp; roles: readonly Role[];
  handle: (ctx: ClinicContext, params: string[], body: Body) => Promise<{ status?: number; body: unknown }>
};
export const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value); if (!result.success) throw new DomainError('INVALID_INPUT'); return result.data;
};
export const uuid = '([0-9a-fA-F-]{36})';
