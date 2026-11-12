import { z } from 'zod';

/** Clinic roles. Shared by server guards and the web shell; the server is the authority. */
export const ROLES = ['ceo', 'administrator', 'registrar', 'doctor', 'laboratory', 'cashier', 'inpatient'] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

/** Who may manage staff and open or close the business day. */
export const MANAGERS: readonly Role[] = ['ceo', 'administrator'];
/** Only a CEO may grant or remove the CEO role, or change a member who holds it. */
export const CEO_ONLY: readonly Role[] = ['ceo'];

/** Login names: lowercase, 3-40 characters, at least one letter so they never look like a phone number. */
export const Login = z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,40}$/).regex(/[a-z]/);

/**
 * Normalize a phone number to +<country><number>. Accepts spaces, dashes, brackets.
 * A 9-digit local number is treated as Uzbekistan (+998). Returns null when not a phone number.
 */
export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim();
  if (!/^\+?[0-9\s()-]{7,24}$/.test(trimmed)) return null;
  let digits = trimmed.replace(/\D/g, '');
  if (digits.length === 9) digits = '998' + digits;
  return /^[1-9][0-9]{7,14}$/.test(digits) ? '+' + digits : null;
}
export const Phone = z.string().max(32).transform((value, ctx) => {
  const phone = normalizePhone(value);
  if (!phone) { ctx.addIssue({ code: 'custom', message: 'Phone number required' }); return z.NEVER; }
  return phone;
});

/** Resolve a sign-in identifier into the column it addresses. */
export function identifierKind(raw: string): { column: 'email' | 'phone' | 'login'; value: string } | null {
  const value = raw.trim();
  if (value.includes('@')) return /^[^\s@]{1,64}@[^\s@]{1,190}$/.test(value) ? { column: 'email', value: value.toLowerCase() } : null;
  const phone = normalizePhone(value);
  if (phone) return { column: 'phone', value: phone };
  const login = Login.safeParse(value);
  return login.success ? { column: 'login', value: login.data } : null;
}
