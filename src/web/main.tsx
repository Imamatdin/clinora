// The Telegram bridge reads the launch parameters from the URL hash; it must load before anything clears it.
import { setTelegramBack, startTelegram, telegramActive, telegramInitData } from './access/telegram.js';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClinicMembershipView, CurrentDayView } from '../contracts/clinic.js';
import { MANAGERS, ROLES, type Role } from '../modules/identity/roles.js';
import { ApiFailure, createRequest } from './api.js';
import { DayPanel, DayPill } from './day.js';
import { adoptLocale, currentLocale, errorText, t, useLocale, type UiKey } from './i18n/index.js';
import { modulesForRoles, NAV, type ModuleProps } from './modules.js';
import { AssistantPanel } from './assistant/panel.js';
import { registerVisitPanel } from './doctor/panels.js';
import { Staff } from './staff.js';
import { LockScreen, useIdleLock, type DeviceInfo } from './access/device.js';
import { AccountNotices, Devices, type AccountNotice } from './access/staff-access.js';
import { registerServiceWorker } from './access/install.js';
import { lockOutbox } from './registration/outbox.js';
import { OfflineWaiting } from './registration/waiting.js';
import { HelpPage, helpRole } from './help/page.js';
import { BottomBar, Icon, Rail, Sheet, type Destination } from './shell.js';
import { LanguageChoice, Settings } from './settings.js';
import { PasswordField } from './password.js';
import { AbrBand } from './abr.js';
import './style.css';

// Task 003C assistant inside the task 010 visit screen (one line per visit panel).
registerVisitPanel({ id: 'assistant', Panel: ({ onChanged, ...p }) => <AssistantPanel {...p} onApproved={onChanged} /> });

type Me = { id: string; name: string; csrf: string; locale?: 'uz-Cyrl' | 'uz-Latn' | 'ru' | null; mustChangePassword: boolean; pinChangeRequired?: boolean; notices?: AccountNotice[]; clinics: ClinicMembershipView[]; professionalVerification: { status: string };
  session: { via: 'password' | 'telegram' | 'device'; deviceId: string | null; deviceLabel: string | null; idleMinutes: number | null } };

/** How a colleague is addressed: name and patronymic. "Каримов Азиз Рустамович" → "Азиз Рустамович"; other shapes stay whole. */
const courtesyName = (name: string) => { const parts = name.trim().split(/\s+/); return parts.length === 3 ? `${parts[1]} ${parts[2]}` : name; };

function App() {
  useLocale(); // re-render every screen when the interface language changes
  const [reportDayId] = useState(() => new URLSearchParams(location.search).get('report'));
  const [me, setMe] = useState<Me | null>(null), [loading, setLoading] = useState(true);
  const [clinicId, setClinicId] = useState(''), [section, setSection] = useState(reportDayId ? 'reports' : '');
  const [more, setMore] = useState(false), [daySheet, setDaySheet] = useState(false);
  const [day, setDay] = useState<CurrentDayView | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [dirty, setDirty] = useState(false), [pending, setPending] = useState<(() => void) | null>(null);
  const [invite, setInvite] = useState(() => new URLSearchParams(location.hash.slice(1)).get('invite') ?? '');
  const [device, setDevice] = useState<DeviceInfo | null>(null), [passwordOnDevice, setPasswordOnDevice] = useState(false);
  const [tgState, setTgState] = useState<'' | 'signing' | 'blocked' | 'reopen' | 'unavailable'>('');
  const csrf = useRef('');
  const request = useMemo(() => createRequest(() => csrf.current), []);
  const clinic = me?.clinics.find(c => c.id === clinicId);
  const roles = useMemo(() => ROLES.filter(r => clinic?.roles.includes(r)), [clinic]);
  const manager = roles.some(r => MANAGERS.includes(r));
  // Task 028: one flat list of places. Every screen the person's roles allow, once; staff for managers; settings for everyone.
  const modules = useMemo(() => modulesForRoles(roles), [roles]);
  const places: Destination[] = [...modules.map(m => ({ id: m.id, label: t(m.label), ...NAV[m.id]! })), ...(manager ? [{ id: 'staff', label: t('nav.staff'), icon: 'staff' as const, group: 2 }] : [])];
  const settingsPlace: Destination = { id: 'settings', label: t('nav.settings'), icon: 'settings', group: 3 };
  const active = [...places, settingsPlace].some(x => x.id === section) ? section : places[0]?.id ?? 'settings';
  const showMe = active === 'settings', setShowMe = (on: boolean) => setSection(on ? 'settings' : '');
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
    adoptLocale(user.locale, user.clinics[0]?.defaultLocale); document.title = t('app.title');
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
    setMe(null); csrf.current = ''; setDirty(false); setSection(''); setDay(null); setMore(false); setDaySheet(false); setPasswordOnDevice(false);
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
  useEffect(() => setTelegramBack(me && active !== (places[0]?.id ?? 'settings') ? () => guard(() => { setDirty(false); setSection(''); }) : null),
    [me?.id, active, places[0]?.id, dirty]);
  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler);
  }, [dirty]);

  async function signIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    await run(async () => {
      // Task 022: no public self-registration; staff accounts are created by an administrator.
      await request('/api/auth/login', { identifier: f.get('identifier'), password: f.get('password') }); await refreshMe(); setPasswordOnDevice(false);
    });
  }
  async function changePassword(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget);
    if (f.get('newPassword') !== f.get('repeat')) { setError(t('password.mismatch')); return; }
    await run(async () => { await request('/api/auth/password', { currentPassword: f.get('currentPassword'), newPassword: f.get('newPassword') }); await refreshMe(); setNotice(t('password.saved')); });
  }
  const signOut = () => guard(() => void run(async () => { await Promise.all([request('/api/auth/logout', {}), Promise.resolve(lockOutbox())]); setMe(null); csrf.current = ''; setDirty(false); setClinicId(''); setSection(''); setDay(null); await refreshDevice(); }));
  const onDevice = me?.session?.via === 'device', inTelegram = me?.session?.via === 'telegram' || telegramActive;
  const banners = <div className="banners" aria-live="polite">{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}<OfflineWaiting me={me} /></div>;
  const go = (id: string) => guard(() => { setDirty(false); setMore(false); setSection(id); window.scrollTo(0, 0); });
  const ready = !!me && !me.mustChangePassword;
  const dayActions = clinic && {
    onOpen: () => void run(async () => { try { await request(`/api/clinics/${clinic.id}/business-days/open`, {}); setNotice(t('day.openedNotice')); setDaySheet(false); } finally { await refreshDay().catch(() => {}); } }),
    onClose: (id: string, date: string) => { if (confirm(t('day.closeConfirm', { date }))) void run(async () => { try {
      // Task 023: visits where nothing was performed can be marked as no-shows before the close.
      const absent = await request<{ visitId: string; patient: string }[]>(`/api/clinics/${clinic.id}/business-days/${id}/no-show`);
      if (absent.length && confirm(t('day.noShowConfirm', { count: String(absent.length), names: absent.slice(0, 10).map(v => v.patient).join(', ') })))
        await request(`/api/clinics/${clinic.id}/business-days/${id}/no-show`, { idempotencyKey: crypto.randomUUID(), visitIds: absent.map(v => v.visitId) });
      await request(`/api/clinics/${clinic.id}/business-days/${id}/close`, {}); setNotice(t('day.closedNotice')); setDaySheet(false); } finally { await refreshDay().catch(() => {}); } }); },
    onReopen: roles.includes('ceo') ? (id: string) => { const reason = prompt(t('day.reopenReason'))?.trim(); if (reason) void run(async () => { try { await request(`/api/clinics/${clinic.id}/business-days/${id}/reopen`, { reason }); setNotice(t('day.reopenedNotice')); setDaySheet(false); } finally { await refreshDay().catch(() => {}); } }); } : undefined
  };
  const screen = modules.find(m => m.id === active);

  if (loading) return <main className="auth"><p role="status">{t('app.loading')}</p></main>;
  if (!me || me.mustChangePassword) return <div className="app bare">
    <div className="auth-top"><AbrBand /><div className="brand">{t('app.brand')}</div></div>
    {!me && telegramActive ? <main className="auth tg-gate">
      {tgState === 'signing' || tgState === '' ? <p role="status">{t('access.tg.signingIn')}</p> : tgState === 'blocked' ? <><h1>{t('access.tg.blockedTitle')}</h1><p>{t('access.tg.blockedLead')}</p></>
        : tgState === 'unavailable' ? <><h1>{t('access.tg.blockedTitle')}</h1><p>{t('access.tg.telegramUnavailable')}</p></> : <><h1>{t('access.tg.reopenTitle')}</h1><p>{t('access.tg.reopenLead')}</p></>}
    </main> :
    !me && device?.enrolled && !passwordOnDevice ? <><OfflineWaiting me={null} /><LockScreen device={device} request={request} notice={notice} onPassword={() => { setPasswordOnDevice(true); setNotice(''); }}
      onUnlocked={async () => { setNotice(''); await refreshMe(); }} /></> :
    !me ? <main className="auth"><h1>{t('auth.welcome')}</h1>
      <form onSubmit={signIn}>
        <label>{t('auth.identifier')}<input name="identifier" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={254} /></label>
        <PasswordField label={t('auth.password')} name="password" required minLength={1} maxLength={128} autoComplete="current-password" />
        <button disabled={busy} className="primary big">{busy ? t('app.wait') : t('auth.signIn')}</button>
      </form>
      {error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}
      {device?.enrolled && <button className="link" onClick={() => { setPasswordOnDevice(false); setError(''); }}>{t('access.device.backToList')}</button>}
      <div className="auth-foot"><LanguageChoice /></div>
      <p className="fine">{t('auth.staffNote')}</p><p className="fine">{t('app.footer')}</p></main> :
    <main className="auth"><h1>{t('password.title')}</h1><p className="muted">{t('password.lead')}</p>
      <form onSubmit={changePassword}>
        <PasswordField label={t('password.current')} name="currentPassword" required maxLength={128} autoComplete="current-password" />
        <PasswordField label={t('password.new')} name="newPassword" required minLength={12} maxLength={128} autoComplete="new-password" />
        <PasswordField label={t('password.repeat')} name="repeat" required minLength={12} maxLength={128} autoComplete="new-password" />
        <button className="primary big" disabled={busy}>{busy ? t('app.wait') : t('password.submit')}</button>
      </form>{error && <p role="alert" className="error">{error}</p>}
      {!inTelegram && <button className="link" disabled={busy} onClick={signOut}>{t('app.signOut')}</button>}</main>}
  </div>;

  return <div className="app" data-home={active === places[0]?.id}>
    <Rail items={places} end={[settingsPlace]} current={active} disabled={busy} onSelect={go} />
    <div className="main-col">
      <header className="topbar">
        <div className="brand">{t('app.brand')}</div>
        {me.clinics.length > 1 ? <select className="clinic-pick" aria-label={t('app.clinic')} value={clinicId} disabled={busy} onChange={e => { const id = e.target.value; guard(() => { setDirty(false); setClinicId(id); setSection(''); }); }}>{me.clinics.map(c => <option value={c.id} key={c.id}>{c.name}</option>)}</select>
          : clinic && <strong className="clinic-name">{clinic.name}</strong>}
        {clinic && clinic.roles.length > 0 && (manager
          ? <button type="button" className="day day-toggle" aria-haspopup="dialog" aria-expanded={daySheet} aria-label={t('day.label')} disabled={busy} onClick={() => setDaySheet(true)}><DayPill day={day} /></button>
          : <DayPill day={day} />)}
        <div className="topbar-end">
          {onDevice && <button className="small" disabled={busy} onClick={() => guard(() => void lock())}>{t('access.device.switchUser')}</button>}
          <button type="button" className="person-menu" aria-current={showMe ? 'page' : undefined} disabled={busy} onClick={() => go('settings')}><span className="person">{me.name}</span><span className="sr-only"> · {t('nav.settings')}</span></button>
        </div>
      </header>
      <div className="page-notes">
        {banners}
        <AccountNotices notices={me.notices ?? []} pinChangeRequired={!!me.pinChangeRequired && !onDevice && !!clinic} request={request}
          onOpenPin={() => go('settings')} onDone={() => void refreshMe()} />
      </div>
      {(!clinic || invite) && <section className="pending"><h1>{t('notebook.pendingTitle')}</h1><p>{t('notebook.pendingLead')}</p><p className="fine">{t('app.verification', { status: t(`verification.${me.professionalVerification.status}` as UiKey) })}</p>
        <form onSubmit={e => { e.preventDefault(); void run(async () => { await request('/api/invitations/accept', { token: invite }); setInvite(''); await refreshMe(); setNotice(t('notebook.inviteAccepted')); }); }}>
          <label>{t('notebook.inviteToken')}<input value={invite} onChange={e => setInvite(e.target.value)} required autoComplete="off" /></label><button className="primary" disabled={busy}>{t('notebook.acceptInvite')}</button>
        </form></section>}
      {showMe && <Settings name={me.name} clinicId={clinic?.id ?? null} roles={roles} request={request} access={!onDevice && !!clinic} onDevice={onDevice} inTelegram={inTelegram} busy={busy}
        onSignOut={signOut} onSwitchUser={() => guard(() => void lock())} idleMinutes={me.session.idleMinutes ?? 10} />}
      {clinic && active === 'staff' && <main className="page"><Staff clinicId={clinic.id} request={request} myId={me.id} myRoles={roles} />
        {!onDevice && !inTelegram && <Devices clinicId={clinic.id} request={request} onEnrolled={() => { setMe(null); csrf.current = ''; setSection(''); setDay(null); setNotice(t('access.devices.enrolled')); void refreshDevice(); }} />}</main>}
      {clinic && screen && <main className="page home" data-screen={screen.id}>
        <h1 className="sr-only">{t(screen.label)}</h1>
        {screen.id === places[0]?.id && <p className="greeting">{t('app.greeting')} <b>{courtesyName(me.name)}</b></p>}
        {/* The one thing a manager must do before anyone can work: open the day. Closing lives behind the day status in the header. */}
        {manager && day && !day.openDay && day.day?.status !== 'closed' && <div className="day-bar"><p>{t('day.none')}</p><button className="primary big" disabled={busy} onClick={dayActions!.onOpen}>{t('day.openButton')}</button></div>}
        <screen.Screen key={`${clinic.id}:${screen.id}`} clinic={clinic} request={request} day={day} myId={me.id} offlineDeviceId={onDevice ? me.session.deviceId : null} setDirty={setDirty} reportDayId={reportDayId} />
      </main>}
      {clinic && !roles.length && !invite && !showMe && <main className="page"><p className="empty">{t('staff.noRoles')}</p></main>}
      <p className="demo-note">{t('app.demoMark')}</p>
    </div>
    <BottomBar items={[...places, settingsPlace]} current={active} disabled={busy} more={more} onSelect={go} onMore={() => setMore(true)} />
    {more && <Sheet title={t('app.more')} onClose={() => setMore(false)}>
      <nav aria-label={t('app.more')}>{[...places, settingsPlace].slice(4).map(x => <button key={x.id} type="button" className="nav-item" aria-current={x.id === active ? 'page' : undefined} onClick={() => go(x.id)}><Icon name={x.icon} />{x.label}</button>)}</nav>
    </Sheet>}
    {daySheet && dayActions && <Sheet title={t('day.label')} onClose={() => setDaySheet(false)}><DayPanel day={day} busy={busy} {...dayActions} /></Sheet>}
    {pending && <div className="modal-backdrop"><section role="alertdialog" aria-modal="true" aria-labelledby="dirty-title" className="modal" onKeyDown={e => {
      const buttons = e.currentTarget.querySelectorAll('button');
      if (e.key === 'Escape') { setPending(null); requestAnimationFrame(() => document.getElementById('note-reported')?.focus()); }
      if (e.key === 'Tab' && ((e.shiftKey && document.activeElement === buttons[0]) || (!e.shiftKey && document.activeElement === buttons[buttons.length - 1]))) { e.preventDefault(); (e.shiftKey ? buttons[buttons.length - 1] : buttons[0])?.focus(); }
    }}><h2 id="dirty-title">{t('notebook.keepTitle')}</h2><p>{t('notebook.keepLead')}</p>
      <div className="actions"><button autoFocus className="primary" onClick={() => { setPending(null); requestAnimationFrame(() => document.getElementById('note-reported')?.focus()); }}>{t('notebook.keepEditing')}</button>
      <button onClick={() => { const action = pending; setPending(null); setDirty(false); action(); }}>{t('notebook.discardContinue')}</button></div></section></div>}
  </div>;
}
registerServiceWorker();
// Task 017: /help/<role> is a printable cheat sheet, not the signed-in app.
const onHelp = location.pathname.startsWith('/help/');
createRoot(document.getElementById('root')!).render(onHelp ? <HelpPage role={helpRole(location.pathname)} /> : <App />);
