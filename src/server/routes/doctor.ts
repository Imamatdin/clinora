import * as d from '../../modules/doctor/actions.js';
import { renderPrescriptionPdf } from '../../modules/doctor/pdf.js';
import { registerRoutes } from './registry.js';
import { parse, uuid } from './types.js';

/** Task 010 doctor workspace. The queue itself (queue/mine, queue/call-next, queue/tickets/:id/status) is task 007's API. requireRole('doctor') runs before the body is read; actions recheck clinical access and patient scope. */
const R = d.DOCTOR, ENC = `doctor/encounters/${uuid}`, TICKET = `doctor/tickets/${uuid}`;
registerRoutes('doctor', [
  { method: 'POST', pattern: new RegExp(`^${TICKET}/start$`), roles: R, handle: async (ctx, [t], b) => ({ body: await d.startVisit(ctx, t!, parse(d.KeyInput, await b())) }) },
  { method: 'POST', pattern: new RegExp(`^${TICKET}/complete$`), roles: R, handle: async (ctx, [t], b) => ({ body: await d.completeConsultation(ctx, t!, parse(d.KeyInput, await b())) }) },
  { method: 'GET', pattern: new RegExp(`^doctor/patients/${uuid}$`), roles: R, handle: async (ctx, [p]) => ({ body: await d.patientCard(ctx, p!) }) },
  { method: 'GET', pattern: /^doctor\/catalog$/, roles: R, handle: async ctx => ({ body: await d.catalog(ctx) }) },
  { method: 'GET', pattern: new RegExp(`^${ENC}$`), roles: R, handle: async (ctx, [e]) => ({ body: await d.visitView(ctx, e!) }) },
  { method: 'POST', pattern: new RegExp(`^${ENC}/note$`), roles: R, handle: async (ctx, [e], b) => ({ body: await d.saveNote(ctx, e!, parse(d.NoteInput, await b())) }) },
  { method: 'POST', pattern: new RegExp(`^${ENC}/approve$`), roles: R, handle: async (ctx, [e], b) => ({ body: await d.approveNote(ctx, e!, parse(d.ApproveInput, await b())) }) },
  { method: 'POST', pattern: new RegExp(`^${ENC}/orders$`), roles: R, handle: async (ctx, [e], b) => ({ status: 201, body: await d.orderServices(ctx, e!, parse(d.OrderInput, await b())) }) },
  { method: 'GET', pattern: new RegExp(`^${ENC}/prescription$`), roles: R, handle: async (ctx, [e]) => ({ body: await d.prescriptionDocument(ctx, e!) }) },
  { method: 'GET', pattern: new RegExp(`^${ENC}/prescription\\.pdf$`), roles: R, handle: async (ctx, [e]) => {
    const doc = await d.prescriptionDocument(ctx, e!);
    return { file: { contentType: 'application/pdf', filename: 'clinora-prescription.pdf', data: await renderPrescriptionPdf(doc) } };
  } }
]);
