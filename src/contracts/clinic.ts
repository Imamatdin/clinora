import { z } from 'zod';
import { Login, Phone, Role, ROLES, type Role as RoleName } from '../modules/identity/roles.js';
import { Password } from './notebook.js';

const RoleSet = z.array(Role).min(1).max(ROLES.length).refine(r => new Set(r).size === r.length, 'Duplicate role');
export const StaffCreateInput = z.object({
  fullName: z.string().trim().min(1).max(160),
  login: Login,
  phone: Phone.nullable(),
  roles: RoleSet
}).strict();
export const StaffRolesInput = z.object({ roles: RoleSet }).strict();
export const StaffStatusInput = z.object({ status: z.enum(['active', 'blocked']) }).strict();
export const PasswordChangeInput = z.object({ currentPassword: z.string().min(1).max(128), newPassword: Password }).strict()
  .refine(v => v.currentPassword !== v.newPassword, 'New password must differ');
export const EmptyInput = z.object({}).strict();

export type StaffView = {
  userId: string; fullName: string; login: string | null; phone: string | null; roles: RoleName[];
  status: 'active' | 'blocked'; managed: boolean; mustChangePassword: boolean
};
export type BusinessDayView = {
  id: string; businessDate: string; status: 'open' | 'closed';
  openedBy: string; openedAt: string; closedBy: string | null; closedAt: string | null
};
export type CurrentDayView = { today: string; timezone: string; day: BusinessDayView | null; openDay: BusinessDayView | null };
export type ClinicMembershipView = { id: string; name: string; roles: RoleName[]; isOwner: boolean; clinicalAccess: boolean };
