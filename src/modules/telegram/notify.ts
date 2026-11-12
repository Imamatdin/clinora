import { z } from 'zod';
import type pg from 'pg';
import type { Role } from '../identity/roles.js';
import type { TelegramConfig } from './api.js';
import { BOT_LOCALES, botText, type BotLocale } from './messages.js';

/*
 * Bot notices to staff. A notice is a fixed sentence plus a button into the authenticated app.
 * Templates accept only small integers as parameters, so a caller cannot put a patient name,
 * diagnosis, phone number or result into a Telegram message even by mistake.
 */

const Count = z.number().int().min(0).max(100000);
const NoParams = z.object({}).strict();

export const NOTICE_TEMPLATES = {
  'day.closed': { params: z.object({collected:z.string().regex(/^\d{1,30}$/),refunds:z.string().regex(/^\d{1,30}$/),cashOuts:z.string().regex(/^\d{1,30}$/)}).strict(), text: {
    'uz-Cyrl':'Иш куни ёпилди. Тушум: {collected} сўм. Қайтарилди: {refunds} сўм. Харажат: {cashOuts} сўм.',
    'uz-Latn':'Ish kuni yopildi. Tushum: {collected} soʻm. Qaytarildi: {refunds} soʻm. Xarajat: {cashOuts} soʻm.',
    ru:'Рабочий день закрыт. Поступления: {collected} сум. Возвраты: {refunds} сум. Расходы: {cashOuts} сум.' } },
  'queue.new_patient': { params: NoParams, text: {
    'uz-Cyrl': 'Навбатингизга янги бемор қўшилди. Тафсилотлар фақат иловада.',
    'uz-Latn': 'Navbatingizga yangi bemor qoʻshildi. Tafsilotlar faqat ilovada.',
    ru: 'В вашу очередь добавлен новый пациент. Подробности только в приложении.' } },
  'queue.waiting': { params: z.object({ count: Count }).strict(), text: {
    'uz-Cyrl': 'Навбатингизда {count} киши кутмоқда.',
    'uz-Latn': 'Navbatingizda {count} kishi kutmoqda.',
    ru: 'В вашей очереди ожидают: {count}.' } },
  'lab.new_order': { params: NoParams, text: {
    'uz-Cyrl': 'Лабораторияга янги буюртма келди. Тафсилотлар фақат иловада.',
    'uz-Latn': 'Laboratoriyaga yangi buyurtma keldi. Tafsilotlar faqat ilovada.',
    ru: 'В лабораторию поступил новый заказ. Подробности только в приложении.' } },
  'day.not_opened': { params: NoParams, text: {
    'uz-Cyrl': 'Иш куни ҳали очилмаган.',
    'uz-Latn': 'Ish kuni hali ochilmagan.',
    ru: 'Рабочий день ещё не открыт.' } },
  'access.linked': { params: NoParams, text: {
    'uz-Cyrl': 'Clinora ҳисобингиз ушбу Telegram ҳисобига боғланди.',
    'uz-Latn': 'Clinora hisobingiz ushbu Telegram hisobiga bogʻlandi.',
    ru: 'Ваш аккаунт Clinora привязан к этому аккаунту Telegram.' } }
} satisfies Record<string, { params: z.ZodType<Record<string, number|string>>; text: Record<BotLocale, string> }>;
export type NoticeTemplate = keyof typeof NOTICE_TEMPLATES;
export type NoticeParams<T extends NoticeTemplate> = z.infer<(typeof NOTICE_TEMPLATES)[T]['params']>;

/** The only shape of message a notice can produce: fixed text and one button into the app. */
export function renderNotice<T extends NoticeTemplate>(template: T, params: NoticeParams<T>, locale: BotLocale, appUrl: string) {
  if (!BOT_LOCALES.includes(locale)) throw new Error('Unknown locale');
  const definition = NOTICE_TEMPLATES[template];
  const values = definition.params.parse(params) as Record<string, number|string>;
  const text = definition.text[locale].replace(/\{(\w+)\}/g, (match, name: string) => name in values ? String(values[name]) : match);
  return { text, reply_markup: { inline_keyboard: [[{ text: botText(locale, 'open'), web_app: { url: appUrl } }]] } };
}

export type NoticeRecipient = { role: Role } | { userId: string };

/**
 * Sends a notice to linked, active staff of one clinic, by role or by account id.
 * Recipients are resolved from current memberships and roles at send time (blocked staff get nothing).
 * Call after the triggering transaction commits. Delivery is at-most-once; failures are counted, not retried.
 */
export async function notifyStaff<T extends NoticeTemplate>(pool: pg.Pool, telegram: TelegramConfig | undefined, appUrl: string,
  input: { clinicId: string; to: NoticeRecipient; template: T; params: NoticeParams<T> }): Promise<{ recipients: number; sent: number; failed: number }> {
  // Render first: an invalid parameter fails before any lookup or send.
  renderNotice(input.template, input.params, 'uz-Cyrl', appUrl);
  if (!telegram) return { recipients: 0, sent: 0, failed: 0 };
  const byRole = 'role' in input.to;
  const rows = (await pool.query(`SELECT DISTINCT l.telegram_user_id::text AS chat FROM telegram_links l
      JOIN accounts a ON a.id=l.account_id AND a.status='active'
      JOIN memberships m ON m.user_id=l.account_id AND m.clinic_id=$1 AND m.status='active'
      JOIN membership_roles r ON r.clinic_id=m.clinic_id AND r.user_id=m.user_id
     WHERE ($2::boolean AND r.role=$3) OR (NOT $2::boolean AND l.account_id=$4::uuid)`,
    [input.clinicId, byRole, byRole ? (input.to as { role: Role }).role : null, byRole ? null : (input.to as { userId: string }).userId])).rows;
  let sent = 0, failed = 0;
  for (const row of rows) {
    // Staff locale preferences arrive with the locale switch; the clinic default is used until then.
    const message = renderNotice(input.template, input.params, 'uz-Cyrl', appUrl);
    const result = await telegram.api.call('sendMessage', { chat_id: row.chat, ...message });
    if (result.ok) sent++; else failed++;
  }
  return { recipients: rows.length, sent, failed };
}
