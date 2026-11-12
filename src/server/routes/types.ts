import type { z } from 'zod';
import { DomainError } from '../../modules/identity/access.js';
import type { Role } from '../../modules/identity/roles.js';
import type { ClinicContext } from '../roles.js';

export type Body = () => Promise<unknown>;
/** A binary attachment (e.g. a server-rendered PDF). The filename is a fixed ASCII name chosen by the route. */
export type FileResult = { contentType: 'application/pdf'; filename: string; data: Buffer };
/**
 * What a clinic route returns: exactly one of JSON (`body`), a server-rendered HTML page (`html`, task 007
 * print tickets) or a file (`file`, task 010 prescription PDF). The `never` fields make the shapes exclusive,
 * so app.ts can tell them apart without a tag and a route cannot return two at once.
 */
export type JsonResult = { status?: number; body: unknown; html?: never; file?: never };
export type HtmlResult = { status?: number; html: string; body?: never; file?: never };
export type FileRouteResult = { file: FileResult; status?: never; body?: never; html?: never };
export type RouteResult = JsonResult | HtmlResult | FileRouteResult;
/**
 * One clinic route, relative to /api/clinics/:clinicId/. `roles` is checked by requireRole against the
 * database before the body is read. Params captured by the pattern must be UUIDs (checked by the router).
 */
export type Route = {
  method: 'GET' | 'POST'; pattern: RegExp; roles: readonly Role[];
  handle: (ctx: ClinicContext, params: string[], body: Body) => Promise<RouteResult>
};
export const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value); if (!result.success) throw new DomainError('INVALID_INPUT'); return result.data;
};
export const uuid = '([0-9a-fA-F-]{36})';
