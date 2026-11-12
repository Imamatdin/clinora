import { z } from 'zod';
import { DbId, DbInstant, Names } from './common.js';

export const QueuePointKind = z.enum(['doctor', 'department', 'service']);
export const QueuePointRow = z.object({
  id: DbId, clinic_id: DbId, kind: QueuePointKind, user_id: DbId.nullable(), department_id: DbId.nullable(),
  service_group_id: DbId.nullable(), ...Names, is_active: z.boolean()
});
export const QueueCounterRow = z.object({ clinic_id: DbId, business_day_id: DbId, queue_point_id: DbId, last_number: z.number().int().min(0) });
export const QueueTicketStatus = z.enum(['waiting', 'called', 'in_progress', 'completed', 'cancelled']);
/**
 * Allowed transitions, enforced by trigger: waiting -> called | in_progress | cancelled;
 * called -> in_progress | waiting | cancelled; in_progress -> completed | cancelled.
 */
export const QUEUE_TRANSITIONS: Record<z.infer<typeof QueueTicketStatus>, readonly z.infer<typeof QueueTicketStatus>[]> = {
  waiting: ['called', 'in_progress', 'cancelled'], called: ['in_progress', 'waiting', 'cancelled'],
  in_progress: ['completed', 'cancelled'], completed: [], cancelled: []
};
export const QueueTicketRow = z.object({
  id: DbId, clinic_id: DbId, business_day_id: DbId, visit_id: DbId, queue_point_id: DbId,
  number: z.number().int().positive(), status: QueueTicketStatus, created_at: DbInstant,
  called_at: DbInstant.nullable(), started_at: DbInstant.nullable(), completed_at: DbInstant.nullable()
});

export type QueuePointRow = z.infer<typeof QueuePointRow>;
export type QueueCounterRow = z.infer<typeof QueueCounterRow>;
export type QueueTicketRow = z.infer<typeof QueueTicketRow>;
