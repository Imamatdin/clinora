import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiFailure, type Request } from '../api.js';
import { errorText, t } from '../i18n/index.js';

export type DeviceInfo = { enrolled: true; clinicName: string; label: string; staff: { userId: string; name: string; locked: boolean }[] } | { enrolled: false };

/**
 * Lock screen of an enrolled clinic computer: pick your name, enter your PIN.
 * The server decides everything (device token, PIN, lockout); this only collects input.
 */
export function LockScreen({ device, request, onUnlocked, onPassword, notice }: {
  device: Extract<DeviceInfo, { enrolled: true }>; request: Request; onUnlocked: () => Promise<void>; onPassword: () => void; notice: string;
}) {
  const [person, setPerson] = useState<{ userId: string; name: string } | null>(null);
  const [pin, setPin] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (person) input.current?.focus(); }, [person]);
  const choose = (p: { userId: string; name: string } | null) => { setPerson(p); setPin(''); setError(''); };
  async function unlock(e?: FormEvent) {
    e?.preventDefault();
    if (!person || !/^[0-9]{4,6}$/.test(pin)) return;
    setBusy(true); setError('');
    try { await request('/api/device/unlock', { userId: person.userId, pin }); setPin(''); await onUnlocked(); }
    catch (err) {
      const code = err instanceof ApiFailure ? err.code : 'SERVICE_UNAVAILABLE';
      setPin(''); setError(code === 'UNAUTHENTICATED' ? t('access.device.wrongPin') : code === 'RATE_LIMITED' ? t('access.device.locked') : errorText(code));
      input.current?.focus();
    } finally { setBusy(false); }
  }
  const press = (digit: string) => { setError(''); setPin(p => (p + digit).slice(0, 6)); input.current?.focus(); };
  return <main className="lock" aria-labelledby="lock-title">
    <p className="fine">{t('access.device.computer', { label: device.label, clinic: device.clinicName })}</p>
    <h1 id="lock-title">{person ? t('access.device.pinFor', { name: person.name }) : t('access.device.title')}</h1>
    <div aria-live="polite">{notice && !person && <p role="status" className="notice">{notice}</p>}{error && <p role="alert" className="error">{error}</p>}</div>
    {!person ? <>
      <p className="muted">{t('access.device.lead')}</p>
      {device.staff.length === 0 ? <p className="empty">{t('access.device.empty')}</p> :
        <ul className="people" aria-label={t('access.device.people')}>{device.staff.map(s => <li key={s.userId}>
          <button className="person-button" disabled={s.locked} onClick={() => choose(s)}>{s.name}{s.locked && <small>{t('access.device.lockedChip')}</small>}</button>
        </li>)}</ul>}
      <p className="fine">{t('access.device.notListed')}</p>
      <button className="link" onClick={onPassword}>{t('access.device.passwordSignIn')}</button>
    </> : <form onSubmit={unlock} className="pin-form">
      <label>{t('access.device.pin')}<input ref={input} name="pin" type="password" inputMode="numeric" autoComplete="off" pattern="[0-9]{4,6}" maxLength={6}
        value={pin} onChange={e => { setError(''); setPin(e.target.value.replace(/\D/g, '').slice(0, 6)); }} required /></label>
      <div className="pinpad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(d => <button type="button" key={d} aria-label={t('access.device.digit', { digit: d })} disabled={busy} onClick={() => press(d)}>{d}</button>)}
        <button type="button" aria-label={t('access.device.erase')} disabled={busy || !pin} onClick={() => setPin(p => p.slice(0, -1))}>⌫</button>
        <button type="button" aria-label={t('access.device.digit', { digit: '0' })} disabled={busy} onClick={() => press('0')}>0</button>
        <button className="primary" disabled={busy || pin.length < 4}>{busy ? t('app.wait') : t('access.device.unlock')}</button>
      </div>
      <button type="button" className="link" onClick={() => choose(null)}>{t('access.device.backToList')}</button>
    </form>}
  </main>;
}

/** Locks a shared-PC session after `minutes` without keyboard, pointer or touch input. */
export function useIdleLock(minutes: number | null, lock: () => void) {
  const latest = useRef(lock); latest.current = lock;
  useEffect(() => {
    if (!minutes) return;
    let timer = setTimeout(() => latest.current(), minutes * 60000);
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => latest.current(), minutes * 60000); };
    const events = ['pointerdown', 'keydown', 'touchstart', 'wheel'] as const;
    events.forEach(e => window.addEventListener(e, reset, { passive: true }));
    return () => { clearTimeout(timer); events.forEach(e => window.removeEventListener(e, reset)); };
  }, [minutes]);
}
