import { useEffect, useState } from 'react';
import { waitingOutbox, type Waiting } from './outbox.js';
import { translator } from './i18n.js';

const t = translator('uz-Cyrl');
/**
 * Shown to anyone on this computer, including the sign-in screen: queued offline registrations
 * of other staff (counts and staff names only, never patient fields). Blocked ones (lost role)
 * are shown to the clinic's CEO/administrators as needing a decision.
 */
export function OfflineWaiting({ me }: { me: { id: string; clinics: { id: string; roles: readonly string[] }[] } | null }) {
  const [rows, setRows] = useState<Waiting[]>([]);
  useEffect(() => {
    let alive = true;
    const load = () => { waitingOutbox().then(r => { if (alive) setRows(r); }).catch(() => {}); };
    load(); window.addEventListener('registration-outbox', load);
    return () => { alive = false; window.removeEventListener('registration-outbox', load); };
  }, [me?.id]);
  const manager = (clinicId: string) => !!me?.clinics.find(c => c.id === clinicId)?.roles.some(r => r === 'ceo' || r === 'administrator');
  const shown = rows.filter(w => w.userId !== me?.id || w.blocked);
  if (!shown.length) return null;
  return <div className="offline-waiting">{shown.map(w => {
    const name = w.name || t('registration.offline.someone');
    return w.blocked && manager(w.clinicId)
      ? <p key={w.owner} role="alert" className="error">{t('registration.offline.blocked', { count: w.count, name })}</p>
      : w.userId !== me?.id && <p key={w.owner} role="status" className="notice">{t('registration.offline.waiting', { count: w.count, name })}</p>;
  })}</div>;
}
