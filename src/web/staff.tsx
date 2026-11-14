import { useEffect, useState, type FormEvent } from 'react';
import type { StaffView } from '../contracts/clinic.js';
import { ROLES, type Role } from '../modules/identity/roles.js';
import { ApiFailure, type Request } from './api.js';
import { errorText, t, type UiKey } from './i18n/index.js';
import { AccessActions, CeoAccessPanel } from './access/staff-access.js';

const roleLabel = (role: Role) => t(`role.${role}` as UiKey);

function RolePicker({ name, selected, onChange, canGrantCeo, disabled }: { name: string; selected: Role[]; onChange: (r: Role[]) => void; canGrantCeo: boolean; disabled: boolean }) {
  return <fieldset className="roles"><legend>{t('staff.roles')}</legend>
    {ROLES.map(role => <label key={role} className="check"><input type="checkbox" name={name} value={role} checked={selected.includes(role)}
      disabled={disabled || (role === 'ceo' && !canGrantCeo)}
      onChange={e => onChange(e.target.checked ? [...selected, role] : selected.filter(r => r !== role))} />{roleLabel(role)}</label>)}
  </fieldset>;
}

/** Staff management for CEO and administrator. Temporary passwords are shown once and never kept in state after dismissal. */
export function Staff({ clinicId, request, myId, myRoles }: { clinicId: string; request: Request; myId: string; myRoles: Role[] }) {
  const [staff, setStaff] = useState<StaffView[] | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [adding, setAdding] = useState(false), [newRoles, setNewRoles] = useState<Role[]>([]);
  const [open, setOpen] = useState(''), [editRoles, setEditRoles] = useState<Role[]>([]);
  const [secret, setSecret] = useState<{ name: string; login: string | null; password: string } | null>(null);
  const isCeo = myRoles.includes('ceo'), base = `/api/clinics/${clinicId}/staff`;
  const run = async (work: () => Promise<void>) => {
    setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE')); } finally { setBusy(false); }
  };
  const load = async () => setStaff(await request<StaffView[]>(base));
  useEffect(() => { setStaff(null); void run(load); }, [clinicId]);
  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault(); const f = new FormData(e.currentTarget), form = e.currentTarget;
    await run(async () => {
      const phone = String(f.get('phone') ?? '').trim();
      const r = await request<{ staff: StaffView; temporaryPassword: string }>(base, { fullName: f.get('fullName'), login: f.get('login'), phone: phone || null, roles: newRoles });
      form.reset(); setNewRoles([]); setAdding(false);
      setSecret({ name: r.staff.fullName, login: r.staff.login, password: r.temporaryPassword });
      setNotice(t('staff.created', { name: r.staff.fullName })); await load();
    });
  }
  const touchesCeo = (s: StaffView) => s.roles.includes('ceo') && !isCeo;
  return <section className="staff" aria-labelledby="staff-heading">
    <div className="section-heading"><h1 id="staff-heading">{t('staff.title')}</h1>
      {!adding && <button className="primary" disabled={busy} onClick={() => { setAdding(true); setError(''); }}>{t('staff.add')}</button>}</div>
    <div aria-live="polite">{error && <p role="alert" className="error">{error}</p>}{notice && <p role="status" className="notice">{notice}</p>}</div>
    {secret && <div className="secret" role="dialog" aria-labelledby="secret-title"><h2 id="secret-title">{t('staff.tempTitle')}</h2>
      <p>{t('staff.tempLead', { name: secret.name })}</p>{secret.login && <p>{t('staff.tempLogin', { login: secret.login })}</p>}
      <p className="password" data-testid="temporary-password">{secret.password}</p>
      <button className="primary" onClick={() => setSecret(null)}>{t('staff.tempDone')}</button></div>}
    {adding && <form className="panel" onSubmit={create}>
      <h2>{t('staff.add')}</h2>
      <label>{t('staff.fullName')}<input name="fullName" required maxLength={160} autoComplete="off" /></label>
      <label>{t('staff.login')}<input name="login" required minLength={3} maxLength={40} pattern="[A-Za-z0-9._\-]*[A-Za-z][A-Za-z0-9._\-]*" autoComplete="off" autoCapitalize="none" spellCheck={false} /></label>
      <label>{t('staff.phone')} <small>{t('staff.optional')}</small><input name="phone" type="tel" inputMode="tel" maxLength={32} autoComplete="off" /></label>
      <RolePicker name="new-role" selected={newRoles} onChange={setNewRoles} canGrantCeo={isCeo} disabled={busy} />
      <div className="actions"><button className="primary big" disabled={busy || !newRoles.length}>{t('staff.create')}</button><button type="button" disabled={busy} onClick={() => { setAdding(false); setNewRoles([]); }}>{t('app.cancel')}</button></div>
    </form>}
    {staff === null ? <p role="status" className="empty">{t('staff.loading')}</p> : !staff.length ? <p className="empty">{t('staff.empty')}</p> :
    <ul className="staff-list">{staff.map(s => <li key={s.userId} className={s.status === 'blocked' ? 'blocked' : ''}>
      <div className="staff-row">
        <div><strong className="name">{s.fullName}</strong><span className="fine">{[s.login, s.phone].filter(Boolean).join(' · ')}</span>
          <span className="chips">{s.roles.length ? s.roles.map(r => <span className="chip" key={r}>{roleLabel(r)}</span>) : <span className="chip">{t('staff.noRoles')}</span>}
            <span className={`chip ${s.status}`}>{t(`staff.status.${s.status}` as UiKey)}</span>{s.mustChangePassword && <span className="chip">{t('staff.mustChange')}</span>}</span></div>
        {s.userId === myId ? <span className="fine">{t('staff.you')}</span> :
          <button className="quiet" disabled={busy || touchesCeo(s)} aria-expanded={open === s.userId} onClick={() => { setOpen(open === s.userId ? '' : s.userId); setEditRoles(s.roles); setError(''); }}>{t('staff.manage')}</button>}
      </div>
      {open === s.userId && <div className="staff-manage">
        <RolePicker name={`roles-${s.userId}`} selected={editRoles} onChange={setEditRoles} canGrantCeo={isCeo} disabled={busy} />
        <div className="actions">
          <button className="primary" disabled={busy || !editRoles.length} onClick={() => void run(async () => { await request(`${base}/${s.userId}/roles`, { roles: editRoles }); setNotice(t('staff.rolesSaved')); await load(); })}>{t('staff.saveRoles')}</button>
          {s.status === 'active'
            ? <button disabled={busy} onClick={() => { if (confirm(t('staff.blockConfirm', { name: s.fullName }))) void run(async () => { await request(`${base}/${s.userId}/status`, { status: 'blocked' }); setNotice(t('staff.blocked')); await load(); }); }}>{t('staff.block')}</button>
            : <button disabled={busy} onClick={() => void run(async () => { await request(`${base}/${s.userId}/status`, { status: 'active' }); setNotice(t('staff.unblocked')); await load(); })}>{t('staff.unblock')}</button>}
          {s.managed
            ? <button disabled={busy} onClick={() => { if (confirm(t('staff.resetConfirm', { name: s.fullName }))) void run(async () => { const r = await request<{ temporaryPassword: string } | { pendingConfirmation: true }>(`${base}/${s.userId}/password-reset`, {});
              // Task 022: an administrator's reset of a doctor's password first goes to the CEO for confirmation.
              if ('pendingConfirmation' in r) setNotice(t('access.pendingCeo')); else setSecret({ name: s.fullName, login: s.login, password: r.temporaryPassword }); await load(); }); }}>{t('staff.reset')}</button>
            : <p className="fine">{t('staff.notManaged')}</p>}
        </div>
        <AccessActions clinicId={clinicId} userId={s.userId} name={s.fullName} request={request} canManage={s.managed && !touchesCeo(s)} />
      </div>}
    </li>)}</ul>}
    {isCeo && <CeoAccessPanel clinicId={clinicId} request={request} />}
  </section>;
}
