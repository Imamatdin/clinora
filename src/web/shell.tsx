// Task 025: phone layout pieces shared by every role — a tab row that moves what does not fit into a
// "More" menu, and the dismiss behaviour of the small header and tab menus.
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { t } from './i18n/index.js';

/** Close a popup on Escape (focus returns to its toggle) or on a click or tap outside it. */
export function useDismiss(open: boolean, close: () => void, root: RefObject<HTMLElement | null>, toggle: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); toggle.current?.focus(); } };
    const onDown = (e: PointerEvent) => { if (root.current && !root.current.contains(e.target as Node)) close(); };
    document.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onDown);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown); };
  }, [open]);
}

export type Tab = { id: string; label: string };
/**
 * One row of navigation tabs. Tabs that do not fit the row's width go into a "More" menu; the current tab is
 * always in the row (phones; from 900 px the row wraps). A hidden copy of the row measures each tab, so the split follows the language and width.
 */
export function Tabs({ tabs, current, onSelect, disabled, label }: { tabs: Tab[]; current: string; onSelect: (id: string) => void; disabled?: boolean; label: string }) {
  const nav = useRef<HTMLElement>(null), measure = useRef<HTMLDivElement>(null), toggle = useRef<HTMLButtonElement>(null), more = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(tabs.length), [open, setOpen] = useState(false);
  const key = tabs.map(x => `${x.id}:${x.label}`).join('|');
  useLayoutEffect(() => {
    const row = nav.current, copy = measure.current;
    if (!row || !copy) return;
    const compute = () => {
      const style = getComputedStyle(row), gap = parseFloat(style.columnGap) || 0;
      const room = row.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      const items = Array.from(copy.children) as HTMLElement[], widths = items.slice(0, -1).map(el => el.getBoundingClientRect().width);
      const moreWidth = items[items.length - 1]!.getBoundingClientRect().width;
      const total = widths.reduce((n, w) => n + w + gap, -gap);
      // From 900 px the row wraps instead (style.css); the "More" menu is for phones only.
      if (total <= room + 0.5 || matchMedia('(min-width: 900px)').matches) { setFit(tabs.length); return; }
      // The current tab and the "More" button are reserved first; other tabs follow in order while they fit.
      const currentIndex = Math.max(0, tabs.findIndex(x => x.id === current));
      let used = moreWidth + widths[currentIndex]! + gap, n = 0;
      for (let i = 0; i < widths.length; i++) {
        if (i === currentIndex) continue;
        if (used + widths[i]! + gap > room + 0.5) break;
        used += widths[i]! + gap; n++;
      }
      setFit(n);
    };
    compute();
    const observer = new ResizeObserver(compute); observer.observe(row); observer.observe(copy);
    return () => observer.disconnect();
  }, [key, current]);
  useDismiss(open, () => setOpen(false), more, toggle);
  // `fit` counts the other tabs that fit beside the current one; the row keeps the original order.
  const others = tabs.filter(x => x.id !== current).slice(0, fit).map(x => x.id);
  const shown = fit >= tabs.length ? tabs : tabs.filter(x => x.id === current || others.includes(x.id));
  const hidden = tabs.filter(x => !shown.includes(x));
  const button = (x: Tab, extra = {}) => <button key={x.id} type="button" className={x.id === current ? 'current' : ''} aria-current={x.id === current ? 'page' : undefined} disabled={disabled}
    onClick={() => { setOpen(false); onSelect(x.id); }} {...extra}>{x.label}</button>;
  return <nav ref={nav} className="sections" aria-label={label}>
    {shown.map(x => button(x))}
    {hidden.length > 0 && <div className="tabs-more" ref={more}>
      <button ref={toggle} type="button" aria-expanded={open} aria-haspopup="true" disabled={disabled} onClick={() => setOpen(o => !o)}>{t('app.more')} <span aria-hidden="true">▾</span></button>
      {open && <div className="tabs-menu" role="group" aria-label={t('app.more')}>{hidden.map(x => button(x))}</div>}
    </div>}
    <div className="tabs-measure" aria-hidden="true"><div ref={measure}>
      {tabs.map(x => <button key={x.id} type="button" tabIndex={-1} className={x.id === current ? 'current' : ''}>{x.label}</button>)}
      <button type="button" tabIndex={-1}>{t('app.more')} <span>▾</span></button>
    </div></div>
  </nav>;
}

/**
 * Header items that move into a menu on phones (below 900 px): from 900 px the wrapper takes no box of its own
 * (display: contents), so the full header stays exactly as before.
 */
export function HeaderMenu({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false), root = useRef<HTMLDivElement>(null), toggle = useRef<HTMLButtonElement>(null);
  useDismiss(open, () => setOpen(false), root, toggle);
  return <div className="header-menu" ref={root} data-open={open}>
    <button ref={toggle} type="button" className="header-menu-toggle" aria-expanded={open} aria-controls="header-menu-panel" onClick={() => setOpen(o => !o)}>
      <span aria-hidden="true">☰</span> {t('app.menu')}</button>
    <div className="header-menu-panel" id="header-menu-panel">{children}</div>
  </div>;
}
