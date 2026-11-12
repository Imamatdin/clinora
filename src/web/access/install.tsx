import { useEffect, useState } from 'react';
import { t } from '../i18n/index.js';
import { telegramActive } from './telegram.js';

/*
 * Installed app: service worker registration and the install hint.
 * The service worker caches the app shell only; it never stores API responses (see public/sw.js).
 */

type InstallPrompt = Event & { prompt(): Promise<void> };
const DISMISSED = 'clinora.installHintDismissed';

export function registerServiceWorker() {
  if (telegramActive || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const iosSafari = () => /iP(hone|ad|od)/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);

/** Android Chrome / desktop Edge and Chrome: an Install button. iPhone and iPad: Add to Home Screen steps. */
export function InstallHint() {
  const [prompt, setPrompt] = useState<InstallPrompt | null>(null);
  const [dismissed, setDismissed] = useState(() => { try { return localStorage.getItem(DISMISSED) === '1'; } catch { return false; } });
  useEffect(() => {
    const onPrompt = (e: Event) => { e.preventDefault(); setPrompt(e as InstallPrompt); };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  if (telegramActive || dismissed || standalone() || (!prompt && !iosSafari())) return null;
  const dismiss = () => { setDismissed(true); try { localStorage.setItem(DISMISSED, '1'); } catch { /* per-browser convenience only */ } };
  return <aside className="install" aria-labelledby="install-title">
    <div><strong id="install-title">{t('access.install.title')}</strong><p>{prompt ? t('access.install.lead') : t('access.install.iosLead')}</p></div>
    <div className="actions">
      {prompt && <button className="primary" onClick={() => { void prompt.prompt().finally(() => setPrompt(null)); }}>{t('access.install.button')}</button>}
      <button className="quiet" onClick={dismiss}>{t('access.install.dismiss')}</button>
    </div>
  </aside>;
}
