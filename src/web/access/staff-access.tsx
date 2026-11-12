import { useEffect, useState, type FormEvent } from 'react';
import qrcode from 'qrcode-generator';
import { ApiFailure, type Request } from '../api.js';
import { errorText, formatDate, t } from '../i18n/index.js';
import { waitingOutbox } from '../registration/outbox.js';

export type StaffAccessRow = { userId: string; telegramLinked: boolean; invitePending: boolean; pinSet: boolean; pinLocked: boolean; loginUnlockAt: string | null };
export type Invite = { link: string; expiresAt: string };

/** QR code drawn as SVG rectangles: no data: URLs or inline HTML, so the CSP stays strict. */
export function Qr({ value, label }: { value: string; label: string }) {
  const qr = qrcode(0, 'M'); qr.addData(value); qr.make();
  const n = qr.getModuleCount(), cells: string[] = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) cells.push(`M${c + 4} ${r + 4}h1v1h-1z`);
  return <svg className="qr" role="img" aria-label={label} viewBox={`0 0 ${n + 8} ${n + 8}`} shapeRendering="crispEdges">
    <rect width={n + 8} height={n + 8} fill="#fff" /><path d={cells.join('')} fill="#000" /></svg>;
}

export function InvitePanel({ invite, name, onDone }: { invite: Invite; name: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  const date = new Intl.DateTimeFormat('uz-Cyrl', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(invite.expiresAt));
  return <div className="secret invite" role="dialog" aria-labelledby="invite-title">
    <h2 id="invite-title">{t('access.inviteTitle')}</h2>
    <p>{t('access.inviteLead', { name })}</p>
    <Qr value={invite.link} label={t('access.qr')} />
    <p className="invite-link" data-testid="invite-link">{invite.link}</p>
    <p className="fine">{t('access.inviteExpires', { date })}</p>
    <div className="actions">
      <button onClick={() => { void navigator.clipboard?.writeText(invite.link).then(() => setCopied(true), () => {}); }}>{t('access.copy')}</button>
      <button className="primary" onClick={onDone}>{t('staff.tempDone')}</button>
    </div>
    {copied && <p role="status" className="notice">{t('access.copied')}</p>}
  </div>;
}

/** Telegram and PIN actions for one staff member, shown inside the staff "Manage" panel. */
export function AccessActions({ clinicId, userId, name, request, canManage }: { clinicId: string; userId: string; name: string; request: Request; canManage: boolean }) {
  const [row, setRow] = useState<StaffAccessRow | null>(null), [invite, setInvite] = useState<Invite | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const base = `/api/clinics/${clinicId}/staff`;
  const load = async () => setRow((await request<StaffAccessRow[]>(`${base}/access`)).find(r => r.userId === userId) ?? null);
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE')); } finally { setBusy(false); }
  };
  useEffect(() => { void run(load); }, [userId]);
  if (!row) return <p className="fine" role="status">{error || t('access.loading')}</p>;
  return <div className="access-actions">
    <h3>{t('access.title')}</h3>
    <span className="chips">
      <span className={`chip ${row.telegramLinked ? 'ok' : ''}`}>{row.telegramLinked ? t('access.linked') : row.invitePending ? t('access.pending') : t('access.notLinked')}</span>
      <span className={`chip ${row.pinLocked ? 'blocked' : row.pinSet ? 'ok' : ''}`}>{row.pinLocked ? t('access.pinLocked') : row.pinSet ? t('access.pinSet') : t('access.noPin')}</span>
    </span>
    {row.loginUnlockAt && <p role="status">{t('access.loginLockedUntil', { time: new Date(row.loginUnlockAt).toLocaleTimeString('uz-Cyrl', { hour: '2-digit', minute: '2-digit', hour12: false }) })}</p>}
    {canManage && <div className="actions">
      {row.loginUnlockAt && <button disabled={busy} onClick={() => void run(async () => { await request(`${base}/${userId}/login-unlock`, {}); setNotice(t('access.loginUnlocked')); await load(); })}>{t('access.unlockLogin')}</button>}
      <button disabled={busy} onClick={() => void run(async () => { setInvite(await request<Invite>(`${base}/${userId}/telegram-invite`, {})); await load(); })}>{t('access.invite')}</button>
      {row.telegramLinked && <button disabled={busy} onClick={() => { if (confirm(t('access.unlinkConfirm', { name }))) void run(async () => { await request(`${base}/${userId}/telegram-unlink`, {}); setNotice(t('access.unlinked')); await load(); }); }}>{t('access.unlink')}</button>}
      {row.pinLocked && <button disabled={busy} onClick={() => void run(async () => { await request(`${base}/${userId}/pin-unlock`, {}); setNotice(t('access.pinUnlocked')); await load(); })}>{t('access.unlockPin')}</button>}
    </div>}
    <div aria-live="polite">{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}</div>
    {invite && <InvitePanel invite={invite} name={name} onDone={() => setInvite(null)} />}
  </div>;
}

type DeviceRow = { id: string; label: string; createdAt: string; createdBy: string; revokedAt: string | null; activeSessions: number };

/** Clinic computers: enrol this computer, see and revoke enrolled ones. Managers only (server-enforced). */
export function Devices({ clinicId, request, onEnrolled }: { clinicId: string; request: Request; onEnrolled: () => void }) {
  const [devices, setDevices] = useState<DeviceRow[] | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const base = `/api/clinics/${clinicId}/devices`;
  const load = async () => setDevices(await request<DeviceRow[]>(base));
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE')); } finally { setBusy(false); }
  };
  useEffect(() => { setDevices(null); void run(load); }, [clinicId]);
  /** Revocation is the only path that deletes queued offline registrations; name their count when this browser holds them. */
  async function revoke(d: DeviceRow) {
    const count = (await waitingOutbox().catch(() => [])).filter(w => w.deviceId === d.id).reduce((n, w) => n + w.count, 0);
    if (!confirm(count ? t('access.devices.revokeOffline', { label: d.label, count }) : t('access.devices.revokeConfirm', { label: d.label }))) return;
    await run(async () => { await request(`${base}/${d.id}/revoke`, {}); setNotice(t('access.devices.revokedNotice')); await load(); });
  }
  function enroll(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const label = String(new FormData(e.currentTarget).get('label') ?? '').trim();
    if (!label || !confirm(t('access.devices.enrollConfirm', { label }))) return;
    void run(async () => { await request(`${base}/enroll`, { label }); onEnrolled(); });
  }
  return <section className="devices" aria-labelledby="devices-heading">
    <h2 id="devices-heading">{t('access.devices.title')}</h2>
    <p className="muted">{t('access.devices.lead')}</p>
    <form className="enroll" onSubmit={enroll}>
      <label>{t('access.devices.label')}<input name="label" required maxLength={80} placeholder={t('access.devices.labelHint')} autoComplete="off" /></label>
      <button className="primary big" disabled={busy}>{t('access.devices.enroll')}</button>
    </form>
    <div aria-live="polite">{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}</div>
    {devices === null ? <p role="status" className="empty">{t('access.devices.loading')}</p> : !devices.length ? <p className="empty">{t('access.devices.empty')}</p> :
      <ul className="staff-list">{devices.map(d => <li key={d.id} className={d.revokedAt ? 'blocked' : ''}><div className="staff-row">
        <div><strong>{d.label}</strong><span className="fine">{t('access.devices.added', { date: formatDate(d.createdAt.slice(0, 10)), name: d.createdBy })}</span>
          <span className="chips">{d.revokedAt ? <span className="chip blocked">{t('access.devices.revoked')}</span> : <span className="chip">{t('access.devices.active', { count: d.activeSessions })}</span>}</span></div>
        {!d.revokedAt && <button disabled={busy} onClick={() => void revoke(d)}>{t('access.devices.revoke')}</button>}
      </div></li>)}</ul>}
  </section>;
}

/** The signed-in person's own PIN and Telegram link. Not offered on a shared PC session. */
export function MyAccess({ clinicId, name, request, onBack }: { clinicId: string; name: string; request: Request; onBack: () => void }) {
  const [state, setState] = useState<{ telegramLinked: boolean; pinSet: boolean; pinLocked: boolean } | null>(null);
  const [invite, setInvite] = useState<Invite | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const load = async () => setState(await request(`/api/clinics/${clinicId}/access/me`));
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE')); } finally { setBusy(false); }
  };
  useEffect(() => { void run(load); }, [clinicId]);
  function savePin(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form = e.currentTarget, f = new FormData(form);
    if (f.get('pin') !== f.get('repeat')) { setError(t('access.me.pinMismatch')); return; }
    void run(async () => { await request('/api/auth/pin', { pin: f.get('pin') }); form.reset(); setNotice(t('access.me.pinSaved')); await load(); });
  }
  return <main className="page my-access" aria-labelledby="me-title">
    <h1 id="me-title">{t('access.me.title')}</h1><p className="muted">{t('access.me.lead')}</p>
    <div aria-live="polite">{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}</div>
    {!state ? <p role="status" className="empty">{t('access.loading')}</p> : <>
      <section className="panel"><h2>{t('access.me.pinTitle')}</h2>
        <p>{state.pinLocked ? t('access.me.pinStatusLocked') : state.pinSet ? t('access.me.pinStatusSet') : t('access.me.pinStatusNone')}</p>
        <p className="fine">{t('access.me.pinLead')}</p>
        <form onSubmit={savePin}>
          <label>{t('access.me.pinNew')}<input name="pin" type="password" inputMode="numeric" pattern="[0-9]{4,6}" minLength={4} maxLength={6} autoComplete="off" required /></label>
          <label>{t('access.me.pinRepeat')}<input name="repeat" type="password" inputMode="numeric" pattern="[0-9]{4,6}" minLength={4} maxLength={6} autoComplete="off" required /></label>
          <button className="primary big" disabled={busy}>{t('access.me.pinSave')}</button>
        </form></section>
      <section className="panel"><h2>{t('access.me.telegramTitle')}</h2>
        <p>{state.telegramLinked ? t('access.me.telegramLinked') : t('access.me.telegramNone')}</p>
        <div className="actions">
          <button disabled={busy} onClick={() => void run(async () => setInvite(await request<Invite>(`/api/clinics/${clinicId}/access/me/telegram-invite`, {})))}>{t('access.me.telegramInvite')}</button>
          {state.telegramLinked && <button disabled={busy} onClick={() => void run(async () => { await request(`/api/clinics/${clinicId}/access/me/telegram-unlink`, {}); await load(); })}>{t('access.me.telegramUnlink')}</button>}
        </div>
        {invite && <InvitePanel invite={invite} name={name} onDone={() => { setInvite(null); void run(load); }} />}
      </section>
    </>}
    <button className="big" onClick={onBack}>{t('access.me.back')}</button>
  </main>;
}
