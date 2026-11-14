import { ROLES, type Role } from '../../modules/identity/roles.js';
import { LOCALE_LABELS, LOCALES, setLocale, t, useLocale, type UiKey } from '../i18n/index.js';
import './help.css';

/** Button labels the steps quote, always from the live dictionary so a sheet never names a button that does not exist. */
const LABELS: Record<string, UiKey> = {
  openDay: 'day.openButton', closeDay: 'day.closeButton', staff: 'nav.staff', catalog: 'module.catalog', payroll: 'module.payroll',
  newPatient: 'registration.new', admitFlag: 'registration.admit', printTickets: 'registration.print',
  callNext: 'doctor.callNext', start: 'doctor.start', save: 'doctor.save', approve: 'doctor.approve', complete: 'doctor.complete',
  labSave: 'lab.save', labConfirm: 'lab.confirm', openShift: 'cashier.open', take: 'cashier.take', closeShift: 'cashier.close',
  admit: 'inpatient.admit', addService: 'inpatient.addService', transfer: 'inpatient.transfer', daily: 'inpatient.daily', discharge: 'inpatient.discharge',
  receipt: 'pharmacy.receipt', dispense: 'pharmacy.dispense', pharmSave: 'pharmacy.save', low: 'pharmacy.low'
};
export const helpRole = (path: string): Role | null => { const m = /^\/help\/([a-z]+)\/?$/.exec(path); return m && (ROLES as readonly string[]).includes(m[1]!) ? m[1] as Role : null; };

/** Task 017: printable one-page cheat sheet per role at /help/<role>. Generic steps only: no clinic or patient data. */
export function HelpPage({ role }: { role: Role | null }) {
  const locale = useLocale();
  if (!role) return <main className="help-sheet"><p>{t('help.unknown')}</p><a href="/">{t('help.open')}</a></main>;
  const vars = Object.fromEntries(Object.entries(LABELS).map(([k, key]) => [k, t(key)]));
  const name = t(`role.${role}` as UiKey);
  document.title = t('help.title', { role: name });
  return <main className="help-sheet" lang={locale}>
    <div className="help-tools">
      <div className="seg lang-switch" role="group" aria-label={t('app.language')}>{LOCALES.map(l =>
        <button key={l} type="button" lang={l} className={l === locale ? 'current' : ''} aria-pressed={l === locale} onClick={() => setLocale(l)}>{LOCALE_LABELS[l]}</button>)}</div>
      <button type="button" className="primary" onClick={() => window.print()}>{t('help.print')}</button>
      <a className="help-link" href="/">{t('help.open')}</a>
    </div>
    <p className="help-brand">{t('app.brand')} · {t('app.brandTag')}</p>
    <h1>{t('help.title', { role: name })}</h1>
    <p className="help-lead">{t('help.lead')}</p>
    <div className="help-body">
      <ol>{[1, 2, 3, 4, 5].map(n => <li key={n}>{t(`help.${role}.${n}` as UiKey, vars)}</li>)}</ol>
      <figure><img src={`/help/${role}.png`} alt={t('help.screenshot', { role: name })} width={360} /><figcaption>{t('help.screenshot', { role: name })}</figcaption></figure>
    </div>
    <p className="help-footer">{t('help.footer')}</p>
  </main>;
}
