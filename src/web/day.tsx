import type { CurrentDayView } from '../contracts/clinic.js';
import { formatDate, formatTime, t } from './i18n/index.js';

/** Header: today's business-day state as a dot and a few words. Read-only; the server decides what can be opened. */
export function DayPill({ day }: { day: CurrentDayView | null }) {
  if (!day) return <span className="day dot">{t('day.unknown')}</span>;
  const open = day.openDay;
  if (open) return <span className={`day dot ${open.businessDate === day.today ? 'ok' : 'attn'}`} data-state="open">{t('day.open', { date: formatDate(open.businessDate) })}</span>;
  if (day.day?.status === 'closed') return <span className="day dot" data-state="closed">{t('day.closed', { date: formatDate(day.day.businessDate) })}</span>;
  return <span className="day dot attn" data-state="none">{t('day.none')}</span>;
}

/** Open or close the business day. Shown only to CEO and administrator (in the day sheet); the server enforces it regardless. */
export function DayPanel({ day, busy, onOpen, onClose, onReopen }: { day: CurrentDayView | null; busy: boolean; onOpen: () => void; onClose: (id: string, date: string) => void; onReopen?: ((id: string) => void) | undefined }) {
  if (!day) return null;
  const open = day.openDay, stale = open && open.businessDate !== day.today;
  return <section className="day-panel" aria-label={t('day.label')}>
    <p className="day-state"><DayPill day={day} /></p>
    {stale && <p className="error">{t('day.staleOpen', { date: formatDate(open.businessDate) })}</p>}
    {open ? <>
      <p className="fine">{t('day.openedBy', { name: open.openedBy, time: formatTime(open.openedAt, day.timezone) })}</p>
      <button className="primary big" disabled={busy} onClick={() => onClose(open.id, formatDate(open.businessDate))}>{t('day.closeButton')}</button>
      <p className="fine">{t('day.summaryLater')}</p>
    </> : day.day?.status === 'closed' ? <>
      <p className="fine">{t('day.closedBy', { name: day.day.closedBy ?? '', time: day.day.closedAt ? formatTime(day.day.closedAt, day.timezone) : '' })}</p>
      {/* Task 023: CEO only (the server enforces it); today's day only. */}
      {onReopen && day.day.businessDate === day.today && <button disabled={busy} onClick={() => onReopen(day.day!.id)}>{t('day.reopenButton')}</button>}
    </> : <button className="primary big" disabled={busy} onClick={onOpen}>{t('day.openButton')}</button>}
  </section>;
}
