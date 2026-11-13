import { useEffect, useState } from 'react';
import { t } from '../i18n/index.js';
import { telegramActive } from './telegram.js';

/*
 * Installed app: service worker registration and the install hint.
 * The service worker caches the app shell only; it never stores API responses (see public/sw.js).
 */

type InstallPrompt = Event & { prompt(): Promise<void> };

export function registerServiceWorker() {
  if (telegramActive || !('serviceWorker' in navigator) || !window.isSecureContext) return;
  window.addEventListener('load', () => { void navigator.serviceWorker.register('/sw.js').catch(() => {}); });
}

const standalone = () => window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
const iosSafari = () => /iP(hone|ad|od)/.test(navigator.userAgent) && !/CriOS|FxiOS|EdgiOS/.test(navigator.userAgent);

// The browser offers installation once, early; keep the offer so Settings can use it whenever the person opens it.
let offer: InstallPrompt | null = null;
const waiting = new Set<() => void>();
if (typeof window !== 'undefined') window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); offer = e as InstallPrompt; for (const fn of waiting) fn(); });

/**
 * Task 028: installing the app is done once, so it lives in Settings, not as a banner on every screen.
 * Android Chrome / desktop Edge and Chrome: an Install button. iPhone and iPad: Add to Home Screen steps.
 */
export function InstallHint() {
  const [, bump] = useState(0);
  useEffect(() => { const fn = () => bump(n => n + 1); waiting.add(fn); return () => { waiting.delete(fn); }; }, []);
  if (telegramActive || standalone() || (!offer && !iosSafari())) return null;
  return <section className="setting" aria-labelledby="install-title">
    <div><h3 id="install-title">{t('access.install.title')}</h3><p className="fine">{offer ? t('access.install.lead') : t('access.install.iosLead')}</p></div>
    {offer && <button onClick={() => { const o = offer!; void o.prompt().finally(() => { offer = null; bump(n => n + 1); }); }}>{t('access.install.button')}</button>}
  </section>;
}
