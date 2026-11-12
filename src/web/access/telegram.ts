/*
 * Minimal Telegram Mini App bridge, written here instead of loading telegram.org's script so the
 * Content-Security-Policy keeps script-src 'self'. It must be imported before anything strips the
 * URL hash: Telegram passes the launch parameters there (tgWebAppData, tgWebAppThemeParams, ...).
 *
 * Outgoing events: TelegramWebviewProxy.postEvent (mobile and desktop apps), or postMessage to
 * the parent frame (Telegram Web). Incoming events: Telegram.WebView.receiveEvent (apps) or a
 * message event from https://web.telegram.org.
 */

type Listener = (data: unknown) => void;
type TelegramWindow = Window & {
  TelegramWebviewProxy?: { postEvent(type: string, data: string): void };
  Telegram?: { WebView?: { receiveEvent(type: string, data: unknown): void } };
};
const w = window as TelegramWindow;
const WEB_ORIGIN = 'https://web.telegram.org';
const FLAG = 'clinora.telegram';

const launch = new URLSearchParams(location.hash.slice(1));
const initData = launch.get('tgWebAppData') ?? '';
let remembered = false;
try { if (initData) sessionStorage.setItem(FLAG, launch.get('tgWebAppThemeParams') ?? '{}'); remembered = sessionStorage.getItem(FLAG) !== null; } catch { /* storage may be blocked */ }

/** True inside Telegram, including after a reload that dropped the launch hash. */
export const telegramActive = Boolean(initData) || remembered;
/** Signed launch data; sent once to the server, which validates it. Empty after a reload. */
export const telegramInitData = initData;

const listeners = new Map<string, Set<Listener>>();
function dispatch(type: string, data: unknown) { listeners.get(type)?.forEach(fn => fn(data)); }
if (telegramActive) {
  w.Telegram = { ...(w.Telegram ?? {}), WebView: { receiveEvent: dispatch } };
  window.addEventListener('message', event => {
    if (event.origin !== WEB_ORIGIN || typeof event.data !== 'string') return;
    try { const { eventType, eventData } = JSON.parse(event.data); if (typeof eventType === 'string') dispatch(eventType, eventData); } catch { /* ignore */ }
  });
}

export function postEvent(type: string, data: Record<string, unknown> = {}) {
  if (!telegramActive) return;
  try {
    if (w.TelegramWebviewProxy) w.TelegramWebviewProxy.postEvent(type, JSON.stringify(data));
    else if (window.parent !== window) window.parent.postMessage(JSON.stringify({ eventType: type, eventData: data }), WEB_ORIGIN);
  } catch { /* the app keeps working without native controls */ }
}
export function onTelegramEvent(type: string, fn: Listener): () => void {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type)!.add(fn);
  return () => { listeners.get(type)?.delete(fn); };
}

const COLOR = /^#[0-9a-fA-F]{6}$/;
const THEME_VARS: Record<string, string> = {
  bg_color: '--tg-bg', secondary_bg_color: '--tg-secondary-bg', text_color: '--tg-text', hint_color: '--tg-hint',
  link_color: '--tg-link', button_color: '--tg-button', button_text_color: '--tg-button-text', destructive_text_color: '--tg-destructive'
};
/** Applies Telegram's theme colours as CSS variables (validated hex only). */
export function applyTelegramTheme(theme: unknown) {
  if (!theme || typeof theme !== 'object') return;
  for (const [key, variable] of Object.entries(THEME_VARS)) {
    const value = (theme as Record<string, unknown>)[key];
    if (typeof value === 'string' && COLOR.test(value)) document.documentElement.style.setProperty(variable, value);
  }
}

/** Call once at start-up inside Telegram: theme, ready, full height, live theme changes. */
export function startTelegram() {
  if (!telegramActive) return;
  document.documentElement.classList.add('tg');
  try { applyTelegramTheme(JSON.parse(launch.get('tgWebAppThemeParams') ?? sessionStorage.getItem(FLAG) ?? '{}')); } catch { /* default colours */ }
  onTelegramEvent('theme_changed', data => applyTelegramTheme((data as { theme_params?: unknown })?.theme_params));
  postEvent('web_app_ready');
  postEvent('web_app_expand');
}

/** Shows Telegram's native back button while `onBack` is set; hides it otherwise. */
export function setTelegramBack(onBack: (() => void) | null): () => void {
  if (!telegramActive) return () => {};
  postEvent('web_app_setup_back_button', { is_visible: Boolean(onBack) });
  if (!onBack) return () => {};
  const off = onTelegramEvent('back_button_pressed', onBack);
  return () => { off(); postEvent('web_app_setup_back_button', { is_visible: false }); };
}
