import type { CurrentDayView } from '../contracts/clinic.js';
import { formatDate, formatTime, t } from './i18n/index.js';

/** Header pill: today's business-day state. Read-only; the server decides what can be opened. */
export function DayPill({ day }: { day: CurrentDayView | null }) {
  if (!day) return <span className="pill">{t('day.unknown')}</span>;
  const open = day.openDay;
  if (open) return <span className="pill day-open" data-state="open">{t('day.open', { date: formatDate(open.businessDate) })}</span>;
  if (day.day?.status === 'closed') return <span className="pill day-closed" data-state="closed">{t('day.closed', { date: formatDate(day.day.businessDate) })}</span>;
  return <span className="pill day-closed" data-state="none">{t('day.none')}</span>;
}

/** Open or close the business day. Shown only to CEO and administrator; the server enforces it regardless. */
export function DayPanel({ day, busy, onOpen, onClose, onReopen, compact=false }: { day: CurrentDayView | null; busy: boolean; onOpen: () => void; onClose: (id: string, date: string) => void; onReopen?: ((id: string) => void) | undefined; compact?:boolean }) {
  if (!day) return null;
  const open = day.openDay, stale = open && open.businessDate !== day.today;
  const panel=<section className="panel day-panel" aria-labelledby="day-heading">
    <h2 id="day-heading">{t('day.label')}</h2>
    <p className="day-state"><DayPill day={day} /></p>
    {stale && <p className="notice">{t('day.staleOpen', { date: formatDate(open.businessDate) })}</p>}
    {open ? <>
      <p className="fine">{t('day.openedBy', { name: open.openedBy, time: formatTime(open.openedAt, day.timezone) })}</p>
      <button className="primary big" disabled={busy} onClick={() => onClose(open.id, formatDate(open.businessDate))}>{t('day.closeButton')}</button>
      <p className="fine">{t('day.summaryLater')}</p>
    </> : day.day?.status === 'closed' ? <>
      <p className="fine">{t('day.closedBy', { name: day.day.closedBy ?? '', time: day.day.closedAt ? formatTime(day.day.closedAt, day.timezone) : '' })}</p>
      <p>{t('day.todayClosed')}</p>
      {/* Task 023: CEO only (the server enforces it); today's day only. */}
      {onReopen && day.day.businessDate === day.today && <button disabled={busy} onClick={() => onReopen(day.day!.id)}>{t('day.reopenButton')}</button>}
    </> : <button className="primary big" disabled={busy} onClick={onOpen}>{t('day.openButton')}</button>}
  </section>;
  return compact?<details className="ceo-day-control"><summary>{t('day.label')} <DayPill day={day}/></summary>{panel}</details>:panel;
}
