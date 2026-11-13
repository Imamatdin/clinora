// Task 028: everything a person sets once lives here, not in the header: language, PIN, Telegram, installing the app.
import { useState } from 'react';
import type { Role } from '../modules/identity/roles.js';
import type { Request } from './api.js';
import { LOCALES, setLocale, t, useLocale, type Locale, type UiKey } from './i18n/index.js';
import { InstallHint } from './access/install.js';
import { MyAccess } from './access/staff-access.js';

/** Each language's own name, never translated. */
const LANGUAGE: Record<Locale, string> = { 'uz-Cyrl': 'Ўзбекча', 'uz-Latn': 'Oʻzbekcha', ru: 'Русский' };

/** Language choice. Signed in, the choice is saved to the account so it follows the person to every device. */
export function LanguageChoice({ request }: { request?: Request }) {
  const locale = useLocale(), [failed, setFailed] = useState(false);
  const choose = (next: Locale) => {
    setLocale(next); document.title = t('app.title'); setFailed(false);
    if (request) request('/api/auth/locale', { locale: next }).catch(() => setFailed(true));
  };
  return <><div className="seg lang-switch" role="group" aria-label={t('app.language')}>{LOCALES.map(l =>
    <button key={l} type="button" lang={l} aria-pressed={l === locale} onClick={() => choose(l)}>{LANGUAGE[l]}</button>)}</div>
    {failed && <p role="alert" className="error">{t('settings.languageNotSaved')}</p>}</>;
}

export function Settings({ name, clinicId, roles, request, access, onDevice, inTelegram, busy, onSignOut, onSwitchUser, idleMinutes }: {
  name: string; clinicId: string | null; roles: readonly Role[]; request: Request; access: boolean; onDevice: boolean; inTelegram: boolean; busy: boolean;
  onSignOut: () => void; onSwitchUser: () => void; idleMinutes: number }) {
  return <main className="page settings" aria-labelledby="settings-title">
    <h1 id="settings-title">{t('nav.settings')}</h1>
    <section className="setting" aria-labelledby="set-language"><div><h3 id="set-language">{t('app.language')}</h3></div><LanguageChoice request={request} /></section>
    {access && clinicId && <MyAccess clinicId={clinicId} name={name} request={request} />}
    {!onDevice && <InstallHint />}
    {roles.length > 0 && <section className="setting" aria-labelledby="set-help"><div><h3 id="set-help">{t('app.help')}</h3></div>
      <div className="actions">{roles.map(r => <a key={r} className="help-link" href={`/help/${r}`} target="_blank" rel="noopener">{t(`role.${r}` as UiKey)}</a>)}</div></section>}
    <section className="setting" aria-labelledby="set-account"><div><h3 id="set-account">{name}</h3>
      {onDevice && <p className="fine">{t('access.device.sessionNote', { minutes: idleMinutes })}</p>}</div>
      {onDevice ? <button disabled={busy} onClick={onSwitchUser}>{t('access.device.switchUser')}</button>
        : !inTelegram && <button disabled={busy} onClick={onSignOut}>{t('app.signOut')}</button>}</section>
    <p className="fine">{t('app.footer')}</p>
  </main>;
}
