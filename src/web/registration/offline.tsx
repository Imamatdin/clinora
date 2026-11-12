import { useEffect, useRef, useState } from 'react';
import { ApiFailure, type Request } from '../api.js';
import { changeEntry, clearOutbox, openOutbox, readOutbox, type OfflineEntry } from './outbox.js';
import { pickName, type Locale, type Names, type translator } from './i18n.js';

export type Synced = { code: string; visitId: string; tickets: { id: string; number: number; names: Names }[] };
export function useRegistrationOutbox(owner: string | null, base: string, request: Request) {
  const [items, setItems] = useState<OfflineEntry[]>([]), [synced, setSynced] = useState<Synced[]>([]);
  const [offline, setOffline] = useState(!navigator.onLine), [syncing, setSyncing] = useState(false);
  const alive = useRef(false), latestOwner = useRef(owner); latestOwner.current = owner;
  async function refresh() { if (owner && alive.current) setItems(await readOutbox(owner)); }
  async function sync() {
    if (!owner || !navigator.onLine || syncing) return;
    setSyncing(true);
    try {
      // Cross-tab serialization; server keys also protect a lost response or a browser crash.
      await navigator.locks.request('clinora-registration-sync', async () => {
        try {
          const user = await request<{ id: string; session: { deviceId: string | null } }>('/api/auth/me');
          if (!owner.startsWith(`${user.id}:${user.session.deviceId}:`)) { await clearOutbox(); return; }
          setOffline(false);
        } catch (e) {
          if (e instanceof ApiFailure && e.code === 'UNAUTHENTICATED') { await clearOutbox(); setSynced([]); }
          else setOffline(true);
          return;
        }
        for (const entry of await readOutbox(owner)) {
          if (!alive.current || latestOwner.current !== owner) return;
          if (entry.error || !entry.points.length) break; // Preserve FIFO, including unfinished routing.
          try {
            const { id, code, labels, error: _error, ...payload } = entry;
            const result = await request<Omit<Synced, 'code'>>(`${base}/offline`, { ...payload, idempotencyKey: id });
            await changeEntry(owner, id, () => null);
            if (!alive.current || latestOwner.current !== owner) return;
            setSynced(old => [...old, { ...result, code }]); setOffline(false);
          } catch (e) {
            const code = e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE';
            if (code === 'UNAUTHENTICATED' || code === 'FORBIDDEN') { await clearOutbox(); setItems([]); setSynced([]); return; }
            if (code === 'SERVICE_UNAVAILABLE') { setOffline(true); break; }
            await changeEntry(owner, entry.id, row => ({ ...row, error: code })); break;
          }
        }
      });
    } finally { if (alive.current) { await refresh(); setSyncing(false); } }
  }
  const latestSync = useRef(sync); latestSync.current = sync;
  useEffect(() => {
    alive.current = true;
    if (owner) void openOutbox(owner).then(setItems).then(() => latestSync.current());
    const online = () => { setOffline(false); void latestSync.current(); };
    const offline = () => setOffline(true);
    const changed = () => { void refresh(); };
    window.addEventListener('online', online); window.addEventListener('offline', offline);
    window.addEventListener('registration-outbox', changed);
    const timer = setInterval(() => { if (navigator.onLine) void latestSync.current(); }, 10000);
    return () => { alive.current = false; clearInterval(timer); window.removeEventListener('online', online); window.removeEventListener('offline', offline); window.removeEventListener('registration-outbox', changed); };
  }, [owner]);
  return { items, synced, offline, syncing, setOffline, refresh, sync };
}

/** Printed in the current shell: no fetch, no HTML interpolation, no names or clinical data. */
export function LocalTickets({ entry, locale, clinicName, t }: { entry: OfflineEntry; locale: Locale; clinicName: string; t: ReturnType<typeof translator> }) {
  return <div className="offline-print">{entry.labels.map((label, index) => <article className="ticket" key={index}>
    <strong>{clinicName}</strong><p>{pickName(label, locale)}</p><p className="number">{entry.code}</p><p>{t('registration.offline.provisional')}</p>
  </article>)}</div>;
}

type Match = { id: string; patientNo: number; fullName: string };
export function OfflineStatus({ owner, base, request, locale, t, items, synced, syncing, sync, onRoute, onResume }: {
  owner: string; base: string; request: Request; locale: Locale; t: ReturnType<typeof translator>;
  items: OfflineEntry[]; synced: Synced[]; syncing: boolean; sync: () => Promise<void>;
  onRoute: (row: OfflineEntry) => Promise<void>; onResume: (row: OfflineEntry) => void;
}) {
  const [matches, setMatches] = useState<{ id: string; patients: Match[] } | null>(null), [error, setError] = useState('');
  async function run(work: () => Promise<void>) {
    setError(''); try { await work(); } catch { setError(t('registration.offline.retry')); }
  }
  return <aside className="offline-status">
    <p>{t('registration.offline.pending', { count: items.length })}</p>
    <button type="button" disabled={syncing || !navigator.onLine} onClick={() => void run(sync)}>{t('registration.offline.sync')}</button>
    <details><summary>{t('registration.offline.help')}</summary><p>{t('registration.offline.cheat')}</p></details>
    {error && <p role="alert">{error}</p>}
    <ul>{items.map(row => <li key={row.id}>
      <strong>{row.code}</strong> {row.patient?.fullName}
      {!row.points.length && <button onClick={() => onResume(row)}>{t('registration.whoSees')}</button>}
      {row.error && <div role="alert" className="offline-attention">
        <h3>{t('registration.offline.attention')}</h3>
        <p>{t(row.error === 'ALREADY_EXISTS' ? 'registration.offline.duplicate' : row.error === 'INVALID_TRANSITION' ? 'registration.offline.closed' : 'registration.offline.catalog')}</p>
        {row.error === 'ALREADY_EXISTS' && <button onClick={() => void run(async () => {
          const p = row.patient!;
          setMatches({ id: row.id, patients: await request<Match[]>(`${base}/duplicates`, { fullName: p.fullName, birthDate: p.birthDate, phone: p.phone }) });
        })}>{t('registration.offline.findDuplicate')}</button>}
        {matches?.id === row.id && matches.patients.map(p => <button key={p.id} onClick={() => void run(async () => {
          await changeEntry(owner, row.id, old => { const { patient: _patient, error: _error, ...rest } = old; return { ...rest, id: crypto.randomUUID(), patientId: p.id }; });
          setMatches(null); await sync();
        })}>{t('registration.useExisting')}: {p.fullName} № {p.patientNo}</button>)}
        {row.error === 'INVALID_TRANSITION' && <button onClick={() => void run(async () => {
          const fresh = await request<{ day: { id: string } | null }>(`${base}/options`);
          if (!fresh.day) throw new Error('No open day');
          await changeEntry(owner, row.id, old => { const { error: _error, ...rest } = old; return { ...rest, id: crypto.randomUUID(), businessDayId: fresh.day!.id }; }); await sync();
        })}>{t('registration.offline.moveDay')}</button>}
        {row.error !== 'ALREADY_EXISTS' && row.error !== 'INVALID_TRANSITION' && <button onClick={() => void run(() => onRoute(row))}>{t('registration.offline.reroute')}</button>}
      </div>}
    </li>)}</ul>
    <ul className="offline-synced">{synced.map(row => <li key={row.code}><strong>{row.code}</strong> → {row.tickets.map(ticket => `${pickName(ticket.names, locale)}: ${ticket.number}`).join(' · ')}
      <a href={`${base}/visits/${row.visitId}/tickets`} target="_blank" rel="noopener">{t('registration.printAgain')}</a></li>)}</ul>
  </aside>;
}
