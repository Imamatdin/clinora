// The Telegram bridge reads the launch parameters from the URL hash; it must load before anything clears it.
import { setTelegramBack, startTelegram, telegramActive, telegramInitData } from './access/telegram.js';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClinicMembershipView, CurrentDayView } from '../contracts/clinic.js';
import { MANAGERS, ROLES, type Role } from '../modules/identity/roles.js';
import { ApiFailure, createRequest } from './api.js';
import { DayPanel, DayPill } from './day.js';
import { currentLocale, errorText, LOCALE_LABELS, LOCALES, setLocale, t, useLocale, type UiKey } from './i18n/index.js';
import { modulesFor, plannedFor, type ModuleProps } from './modules.js';
import { AssistantPanel } from './assistant/panel.js';
import { registerVisitPanel } from './doctor/panels.js';
import { Staff } from './staff.js';
import { LockScreen, useIdleLock, type DeviceInfo } from './access/device.js';
import { Devices, MyAccess } from './access/staff-access.js';
import { InstallHint, registerServiceWorker } from './access/install.js';
import { lockOutbox } from './registration/outbox.js';
import { OfflineWaiting } from './registration/waiting.js';
import { HelpPage, helpRole } from './help/page.js';
import './style.css';
import './ceo/style.css';

// Task 003C assistant inside the task 010 visit screen (one line per visit panel).
registerVisitPanel({ id: 'assistant', Panel: ({ onChanged, ...p }) => <AssistantPanel {...p} onApproved={onChanged} /> });

type Me = { id: string; name: string; csrf: string; mustChangePassword: boolean; clinics: ClinicMembershipView[]; professionalVerification: { status: string };
  session: { via: 'password' | 'telegram' | 'device'; deviceId: string | null; deviceLabel: string | null; idleMinutes: number | null } };
type Section = Role | 'staff';
const sectionLabel = (s: Section) => s === 'staff' ? t('nav.staff') : t(`role.${s}` as UiKey);

/** Registered feature screens for one role (src/web/modules.ts). Renders nothing until a feature registers. */
function RoleModules({ role, busy, guard, props }: { role: Role; busy: boolean; guard: (action: () => void) => void; props: ModuleProps }) {
  const modules = modulesFor(role);
  const [current, setCurrent] = useState(props.reportDayId ? 'reports' : '');
  if (!modules.length) return null;
  const active = modules.find(m => m.id === current) ?? modules[0]!;
  return <section className="role-modules">
    {modules.length > 1 && <nav className="sections" aria-label={t('app.navigation')}>{modules.map(m => <button key={m.id} className={m === active ? 'current' : ''} aria-current={m === active ? 'page' : undefined} disabled={busy} onClick={() => guard(() => { props.setDirty(false); setCurrent(m.id); })}>{t(m.label)}</button>)}</nav>}
    <active.Screen {...props} />
  </section>;
}

/** One language switch for the whole app, in the header on every screen (task 017). */
function LanguageSwitch() {
  const locale = useLocale();
  return <div className="lang-switch" role="group" aria-label={t('app.language')}>{LOCALES.map(l =>
    <button key={l} type="button" lang={l} className={l === locale ? 'current' : ''} aria-pressed={l === locale} onClick={() => { setLocale(l); document.title = t('app.title'); }}>{LOCALE_LABELS[l]}</button>)}</div>;
}

function Planned({ role }: { role: Role }) {
  return <ul className="planned">{plannedFor(role).map(key => <li key={key} aria-disabled="true"><span>{t(key)}</span><small>{t('app.comingSoon')}</small></li>)}</ul>;
}

function App() {
  useLocale(); // re-render every screen when the interface language changes
  const [reportDayId] = useState(() => new URLSearchParams(location.search).get('report'));
  const [me, setMe] = useState<Me | null>(null), [loading, setLoading] = useState(true), [mode, setMode] = useState<'login' | 'register'>('login');
  const [clinicId, setClinicId] = useState(''), [section, setSection] = useState<Section | ''>('');
  const [day, setDay] = useState<CurrentDayView | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false), [pending, setPending] = useState<(() => void) | null>(null);
  const [invite, setInvite] = useState(() => new URLSearchParams(location.hash.slice(1)).get('invite') ?? '');
  const [device, setDevice] = useState<DeviceInfo | null>(null), [passwordOnDevice, setPasswordOnDevice] = useState(false);
  const [tgState, setTgState] = useState<'' | 'signing' | 'blocked' | 'reopen' | 'unavailable'>(''), [showMe, setShowMe] = useState(false);
  const csrf = useRef('');
  const request = useMemo(() => createRequest(() => csrf.current), []);
  const clinic = me?.clinics.find(c => c.id === clinicId);
  const roles = useMemo(() => ROLES.filter(r => clinic?.roles.includes(r)), [clinic]);
  const manager = roles.some(r => MANAGERS.includes(r));
  const sections: Section[] = [...roles, ...(manager ? ['staff' as const] : [])];
  const active: Section | undefined = sections.includes(section as Section) ? section as Section : sections[0];
  const guard = (action: () => void) => { if (dirty) setPending(() => action); else action(); };
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) {
      const code = e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE';
      setError(e instanceof ApiFailure && e.unlockAt ? t('access.loginLockedUntil', { time: new Date(e.unlockAt).toLocaleTimeString('uz-Cyrl', { hour: '2-digit', minute: '2-digit', hour12: false }) }) : errorText(code));
      if (code === 'UNAUTHENTICATED') { setMe(null); csrf.current = ''; void refreshDevice(); }
      if (code === 'FORBIDDEN' || code === 'INVALID_TRANSITION') void refreshMe().catch(() => {});
    } finally { setBusy(false); }
  };
  async function refreshMe() {
    const user = await request<Me>('/api/auth/me'); csrf.current = user.csrf; setMe(user);
    setClinicId(old => user.clinics.some(c => c.id === old) ? old : user.clinics[0]?.id ?? '');
  }
  async function refreshDevice() {
    if (telegramActive) return;
    try { setDevice(await request<DeviceInfo>('/api/device')); } catch { setDevice(null); }
  }
  /** Mini App: exchange Telegram's signed launch data for a normal server session, once. */
  async function telegramSignIn() {
    if (!telegramInitData) { setTgState('reopen'); return; }
    setTgState('signing');
    try { await request('/api/telegram/session', { initData: telegramInitData }); await refreshMe(); setTgState(''); }
    catch (e) {
      const code = e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE';
      setTgState(code === 'FORBIDDEN' ? 'blocked' : code === 'INTEGRATION_UNAVAILABLE' ? 'unavailable' : 'reopen');
    }
  }
  /** Shared PC: end this person's session and return to the name list. */
  async function lock(notice = '') {
    try {
      // Start the request with its CSRF proof, then hide data immediately. Queued offline
      // registrations stay locked to their owner and sync at that person's next sign-in (task 020).
      await Promise.all([request('/api/auth/logout', {}), Promise.resolve(lockOutbox())]);
    } catch { /* the server may already have ended it */ }
    setMe(null); csrf.current = ''; setDirty(false); setSection(''); setDay(null); setShowMe(false); setPasswordOnDevice(false);
    setError(''); setNotice(notice); await refreshDevice();
  }
  async function refreshDay(id = clinicId) {
    if (!id) { setDay(null); return; }
    setDay(await request<CurrentDayView>(`/api/clinics/${id}/business-days/current`));
  }
  useEffect(() => {
    document.documentElement.lang = currentLocale(); document.title = t('app.title');
    history.replaceState(null, '', location.pathname);
    startTelegram();
    refreshMe().catch(async e => {
      if (!(e instanceof ApiFailure && e.code === 'UNAUTHENTICATED')) { setError(errorText('SERVICE_UNAVAILABLE')); return; }
      if (telegramActive) await telegramSignIn(); else await refreshDevice();
    }).finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    setDay(null);
    if (!me || me.mustChangePassword || !clinicId || !clinic?.roles.length) return;
    refreshDay(clinicId).catch(() => setDay(null));
    // Keep the header honest when another device opens or closes the day.
    const onFocus = () => { refreshDay(clinicId).catch(() => {}); };
    window.addEventListener('focus', onFocus); return () => window.removeEventListener('focus', onFocus);
  }, [me?.id, me?.mustChangePassword, clinicId, clinic?.roles.join()]);
  useIdleLock(me?.session?.idleMinutes ?? null, () => { void lock(t('access.device.idleLocked')); });
  useEffect(() => {
    const ended = () => { setMe(null); csrf.current = ''; setDirty(false); setDay(null); setSection(''); void refreshDevice(); };
    const identity = (event: Event) => {
      if (me && (event as CustomEvent).detail !== `${me.id}:${me.session.deviceId}:`) ended();
    };
    window.addEventListener('registration-session-ended', ended);
    window.addEventListener('registration-session-identity', identity);
    return () => { window.removeEventListener('registration-session-ended', ended); window.removeEventListener('registration-session-identity', identity); };
  }, [me?.id, me?.session.deviceId]);
  // Telegram's native back button: from a secondary screen back to the person's main screen.
  useEffect(() => setTelegramBack(me && (showMe || (active && active !== sections[0])) ? () => guard(() => { setDirty(false); setShowMe(false); setSection(''); }) : null),
    [me?.id, showMe, active, sections[0], dirty]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  async function signIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await run(async () => {
      if (mode === 'register') {
        await request('/api/auth/register', { email: f.get('email'), displayName: f.get('name'), password: f.get('password') });
        setMode('login'); setNotice(t('auth.registered'));
      } else { await request('/api/auth/login', { identifier: f.get('identifier'), password: f.get('password') }); await refreshMe(); setPasswordOnDevice(false); }
    });
  }
  async function changePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    if (f.get('newPassword') !== f.get('repeat')) { setError(t('password.mismatch')); return; }
    await run(async () => { await request('/api/auth/password', { currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') }); await refreshMe(); setNotice(t('password.saved')); });
  }
  const signOut = () => guard(() => void run(async () => { await Promise.all([request('/api/auth/logout', {}), Promise.resolve(lockOutbox())]); setMe(null); csrf.current = ''; setDirty(false); setClinicId(''); setSection(''); setDay(null); setShowMe(false); await refreshDevice(); }));
  const onDevice = me?.session?.via === 'device', inTelegram = me?.session?.via === 'telegram' || telegramActive;
  const banners = <div className="banners" aria-live="polite">{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}<OfflineWaiting me={me} /></div>;

  if (loading) return <main className="auth"><p role="status">{t('app.loading')}</p></main>;
  return <div className="app">
    <header className="topbar">
      <div className="brand">{t('app.brand')}<span>{t('app.brandTag')}</span></div>
      {clinic && <strong className="clinic-name">{clinic.name}</strong>}
      {clinic && clinic.roles.length > 0 && !me?.mustChangePassword && <DayPill day={day} />}
      <LanguageSwitch />
      {me && <div className="account"><span className="person">{me.name}</span>
        {onDevice ? <button className="primary" disabled={busy} onClick={() => guard(() => void lock())}>{t('access.device.switchUser')}</button>
          : <>{!me.mustChangePassword && clinic && <button className="quiet" disabled={busy} onClick={() => guard(() => { setDirty(false); setShowMe(true); })}>{t('access.me.button')}</button>}
            {!inTelegram && <button className="quiet" disabled={busy} onClick={signOut}>{t('app.signOut')}</button>}</>}</div>}
      {onDevice && <span className="fine device-note">{t('access.device.sessionNote', { minutes: me?.session.idleMinutes ?? 10 })}</span>}
    </header>
    {!me && telegramActive ? <main className="auth tg-gate">
      {tgState === 'signing' || tgState === '' ? <p role="status">{t('access.tg.signingIn')}</p> : tgState === 'blocked' ? <><h1>{t('access.tg.blockedTitle')}</h1><p>{t('access.tg.blockedLead')}</p></>
        : tgState === 'unavailable' ? <><h1>{t('access.tg.blockedTitle')}</h1><p>{t('access.tg.telegramUnavailable')}</p></> : <><h1>{t('access.tg.reopenTitle')}</h1><p>{t('access.tg.reopenLead')}</p></>}
    </main> :
    !me && device?.enrolled && !passwordOnDevice ? <><OfflineWaiting me={null} /><LockScreen device={device} request={request} notice={notice} onPassword={() => { setPasswordOnDevice(true); setNotice(''); }}
      onUnlocked={async () => { setNotice(''); await refreshMe(); }} /></> :
    !me ? <main className="auth"><p className="eyebrow">{t('auth.eyebrow')}</p><h1>{mode === 'login' ? t('auth.welcome') : t('auth.createTitle')}</h1><p className="muted">{t('auth.lead')}</p>
      <form onSubmit={signIn}>
        {mode === 'login'
          ? <label>{t('auth.identifier')}<input name="identifier" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={254} /></label>
          : <><label>{t('auth.email')}<input name="email" type="email" autoComplete="username" required maxLength={254} /></label><label>{t('auth.fullName')}<input name="name" required maxLength={160} autoComplete="name" /></label></>}
        <label>{t('auth.password')}<input name="password" type="password" required minLength={mode === 'register' ? 12 : 1} maxLength={128} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
        <button disabled={busy} className="primary big">{busy ? t('app.wait') : mode === 'login' ? t('auth.signIn') : t('auth.createUnprivileged')}</button>
      </form>
      <p className="fine">{t('auth.staffNote')}</p>
      <button className="link" disabled={busy} onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}>{mode === 'login' ? t('auth.toRegister') : t('auth.toLogin')}</button>
      {mode === 'register' && <p className="fine">{t('auth.registrationNote')}</p>}
      {device?.enrolled && <button className="link" onClick={() => { setPasswordOnDevice(false); setError(''); }}>{t('access.device.backToList')}</button>}
      {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}</main> :
    me.mustChangePassword ? <main className="auth"><h1>{t('password.title')}</h1><p className="muted">{t('password.lead')}</p>
      <form onSubmit={changePassword}>
        <label>{t('password.current')}<input name="currentPassword" type="password" required maxLength={128} autoComplete="current-password" /></label>
        <label>{t('password.new')}<input name="newPassword" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>
        <label>{t('password.repeat')}<input name="repeat" type="password" required minLength={12} maxLength={128} autoComplete="new-password" /></label>
        <button className="primary big" disabled={busy}>{busy ? t('app.wait') : t('password.submit')}</button>
      </form>{error && <p role="alert" className="error">{error}</p>}</main> :
    <>
      {me.clinics.length > 1 && <div className="clinicbar"><label>{t('app.clinic')}<select aria-label={t('app.clinic')} value={clinicId} disabled={busy} onChange={e => { const id = e.target.value; guard(() => { setDirty(false); setClinicId(id); setSection(''); }); }}>{me.clinics.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select></label></div>}
      {sections.length > 1 && <nav className="sections" aria-label={t('app.navigation')}>{sections.map(s => <button key={s} className={s === active ? 'current' : ''} aria-current={s === active ? 'page' : undefined} disabled={busy} onClick={() => guard(() => { setDirty(false); setSection(s); })}>{sectionLabel(s)}</button>)}</nav>}
      {banners}
      {!onDevice && <InstallHint />}
      {(!clinic || invite) && <section className="pending"><h1>{t('notebook.pendingTitle')}</h1><p>{t('notebook.pendingLead')}</p><p className="fine">{t('app.verification', { status: t(`verification.${me.professionalVerification.status}` as UiKey) })}</p>
        <form onSubmit={e => { e.preventDefault(); void run(async () => { await request('/api/invitations/accept', { token: invite }); setInvite(''); await refreshMe(); setNotice(t('notebook.inviteAccepted')); }); }}>
          <label>{t('notebook.inviteToken')}<input value={invite} onChange={e => setInvite(e.target.value)} required autoComplete="off" /></label><button className="primary" disabled={busy}>{t('notebook.acceptInvite')}</button>
        </form></section>}
      {showMe && clinic && <MyAccess clinicId={clinic.id} name={me.name} request={request} onBack={() => setShowMe(false)} />}
      {!showMe && clinic && active === 'staff' && <main className="page"><Staff clinicId={clinic.id} request={request} myId={me.id} myRoles={roles} />
        {!onDevice && !inTelegram && <Devices clinicId={clinic.id} request={request} onEnrolled={() => { setMe(null); csrf.current = ''; setSection(''); setDay(null); setNotice(t('access.devices.enrolled')); void refreshDevice(); }} />}</main>}
      {!showMe && clinic && active && active !== 'staff' && <>
        <main className="page home" data-role={active}>
          <h1>{t(`home.${active}.title` as UiKey)}</h1><p className="muted">{t(`home.${active}.lead` as UiKey)} <a className="help-link" href={`/help/${active}`} target="_blank" rel="noopener">{t('app.help')}</a></p>
          {(active === 'ceo' || active === 'administrator') && <DayPanel day={day} busy={busy} compact={active==='ceo'}
            onOpen={() => void run(async () => { try { await request(`/api/clinics/${clinic.id}/business-days/open`, {}); setNotice(t('day.openedNotice')); } finally { await refreshDay().catch(() => {}); } })}
            onClose={(id, date) => { if (confirm(t('day.closeConfirm', { date }))) void run(async () => { try {
              // Task 023: visits where nothing was performed can be marked as no-shows before the close.
              const absent = await request<{ visitId: string; patient: string }[]>(`/api/clinics/${clinic.id}/business-days/${id}/no-show`);
              if (absent.length && confirm(t('day.noShowConfirm', { count: String(absent.length), names: absent.slice(0, 10).map(v => v.patient).join(', ') })))
                await request(`/api/clinics/${clinic.id}/business-days/${id}/no-show`, { idempotencyKey: crypto.randomUUID(), visitIds: absent.map(v => v.visitId) });
              await request(`/api/clinics/${clinic.id}/business-days/${id}/close`, {}); setNotice(t('day.closedNotice')); } finally { await refreshDay().catch(() => {}); } }); }}
            onReopen={roles.includes('ceo') ? (id) => { const reason = prompt(t('day.reopenReason'))?.trim(); if (reason) void run(async () => { try { await request(`/api/clinics/${clinic.id}/business-days/${id}/reopen`, { reason }); setNotice(t('day.reopenedNotice')); } finally { await refreshDay().catch(() => {}); } }); } : undefined} />}
          <RoleModules key={`${clinic.id}:${active}`} role={active} busy={busy} guard={guard} props={{ clinic, request, day, myId: me.id, offlineDeviceId: onDevice ? me.session.deviceId : null, setDirty, reportDayId }} />
          <Planned role={active} />
        </main>
      </>}
      {clinic && !sections.length && !invite && <main className="page"><p className="empty">{t('staff.noRoles')}</p></main>}
    </>}
    {pending && <div className="modal-backdrop"><section role="alertdialog" aria-modal="true" aria-labelledby="dirty-title" className="modal" onKeyDown={e => {
      const buttons = e.currentTarget.querySelectorAll('button');
      if (e.key === 'Escape') { setPending(null); requestAnimationFrame(() => document.getElementById('note-reported')?.focus()); }
      if (e.key === 'Tab' && ((e.shiftKey && document.activeElement === buttons[0]) || (!e.shiftKey && document.activeElement === buttons[buttons.length - 1]))) { e.preventDefault(); (e.shiftKey ? buttons[buttons.length - 1] : buttons[0])?.focus(); }
    }}><h2 id="dirty-title">{t('notebook.keepTitle')}</h2><p>{t('notebook.keepLead')}</p>
      <button autoFocus onClick={() => { setPending(null); requestAnimationFrame(() => document.getElementById('note-reported')?.focus()); }}>{t('notebook.keepEditing')}</button>
      <button onClick={() => { const action = pending; setPending(null); setDirty(false); action(); }}>{t('notebook.discardContinue')}</button></section></div>}
    <footer>{t('app.footer')}</footer>
  </div>;
}
registerServiceWorker();
// Task 017: /help/<role> is a printable cheat sheet, not the signed-in app.
const onHelp = location.pathname.startsWith('/help/');
createRoot(document.getElementById('root')!).render(onHelp ? <HelpPage role={helpRole(location.pathname)} /> : <App />);
