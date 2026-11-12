import { DomainError } from '../identity/access.js';
import { requireRole, type ClinicContext } from '../../server/roles.js';
import { withAudit } from '../../server/repo/audit.js';
import { REGISTRARS } from './actions.js';

/*
 * Queue tickets as a server-rendered HTML page for 80 mm thermal paper that stays readable at 58 mm.
 * One ticket per queue point: clinic name, patient number, queue point, queue number, date and time.
 * Deliberately no patient name, diagnosis or service list: tickets are left on counters and seen by others.
 * The page links /ticket.css and /ticket.js (src/web/public) because the global CSP forbids inline
 * styles and scripts; ticket.js opens the print dialog on load.
 */

type Locale = 'uz-Cyrl' | 'uz-Latn' | 'ru';
const LABELS: Record<Locale, { title: string; patientNo: string; queue: string; print: string; keep: string }> = {
  'uz-Cyrl': { title: 'Навбат талони', patientNo: 'Бемор рақами', queue: 'Навбат', print: 'Чоп этиш', keep: 'Навбатингизни кутинг' },
  'uz-Latn': { title: 'Navbat taloni', patientNo: 'Bemor raqami', queue: 'Navbat', print: 'Chop etish', keep: 'Navbatingizni kuting' },
  ru: { title: 'Талон очереди', patientNo: 'Номер пациента', queue: 'Очередь', print: 'Печать', keep: 'Ожидайте вызова' }
};
const escape = (value: unknown) => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]!));
const pick = (r: { name_uz_cyrl: string; name_uz_latn: string | null; name_ru: string | null }, locale: Locale) =>
  (locale === 'ru' ? r.name_ru : locale === 'uz-Latn' ? r.name_uz_latn : null) ?? r.name_uz_cyrl;

export async function ticketsHtml(ctx: ClinicContext, visitId: string): Promise<string> {
  ctx = await requireRole(ctx.tx, ctx.actorId, ctx.clinicId, REGISTRARS);
  const head = (await ctx.tx.query(`SELECT c.name clinic, c.timezone, s.receipt_header->>'name' header, coalesce(a.locale, s.default_locale, 'uz-Cyrl') locale,
      p.patient_no, d.business_date
    FROM visits v JOIN clinics c ON c.id=v.clinic_id LEFT JOIN clinic_settings s ON s.clinic_id=c.id
    JOIN patients p ON p.clinic_id=v.clinic_id AND p.id=v.patient_id JOIN business_days d ON d.clinic_id=v.clinic_id AND d.id=v.business_day_id
    LEFT JOIN accounts a ON a.id=$3 WHERE v.clinic_id=$1 AND v.id=$2`, [ctx.clinicId, visitId, ctx.actorId])).rows[0];
  if (!head) throw new DomainError('NOT_FOUND');
  const tickets = (await ctx.tx.query(`SELECT t.number, to_char(t.created_at AT TIME ZONE $3, 'DD.MM.YYYY HH24:MI') issued, q.name_uz_cyrl, q.name_uz_latn, q.name_ru
    FROM queue_tickets t JOIN queue_points q ON q.clinic_id=t.clinic_id AND q.id=t.queue_point_id
    WHERE t.clinic_id=$1 AND t.visit_id=$2 AND t.status<>'cancelled' ORDER BY t.created_at, q.name_uz_cyrl`, [ctx.clinicId, visitId, head.timezone])).rows;
  const locale: Locale = head.locale in LABELS ? head.locale : 'uz-Cyrl', l = LABELS[locale];
  const clinic = escape(head.header || head.clinic);
  await withAudit(ctx.tx, ctx, 'registration.tickets_printed', visitId, { tickets: tickets.length });
  const body = tickets.map(t => `<article class="ticket">
  <p class="clinic">${clinic}</p>
  <p class="point">${escape(pick(t, locale))}</p>
  <p class="label">${escape(l.queue)}</p>
  <p class="number">${escape(t.number)}</p>
  <p class="patient">${escape(l.patientNo)}: <strong>${escape(head.patient_no)}</strong></p>
  <p class="time">${escape(t.issued)}</p>
  <p class="keep">${escape(l.keep)}</p>
</article>`).join('\n');
  return `<!doctype html>
<html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(l.title)}</title><link rel="stylesheet" href="/ticket.css"><script src="/ticket.js" defer></script></head>
<body><button type="button" id="print-again" class="no-print">${escape(l.print)}</button>
${body}
</body></html>`;
}
