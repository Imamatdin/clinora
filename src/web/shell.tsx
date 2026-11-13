// Task 028 shell: a left rail on desktop, a bottom bar on phones, sheets for secondary actions.
// One navigation list, flat: a person sees every screen their roles allow, once.
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
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

/** One line-icon set: 24 px grid, 1.5 px stroke, round caps (docs/DESIGN.md). Decorative: always beside a text label. */
const ICONS = {
  today: 'M4 19V11M10 19V5M16 19v-6M21 19H3',
  queue: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  register: 'M15 19a6 6 0 0 0-12 0M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M16 11h6',
  cash: 'M3 7h18v11H3zM3 11h18M7 15h3',
  ward: 'M3 18v-7h13a4 4 0 0 1 4 4v3M3 20v-2h18v2M3 11V6M7 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4',
  lab: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M8 15h8',
  pharmacy: 'M10.5 20.5a4.95 4.95 0 0 1-7-7l7-7a4.95 4.95 0 0 1 7 7zM7 10l7 7',
  surgery: 'M12 4v16M4 12h16',
  catalog: 'M4 5h16M4 10h16M4 15h10M17 14v6M14 17h6',
  reports: 'M6 3h9l4 4v14H6zM14 3v5h5M9 13h7M9 17h7',
  payroll: 'M12 3v18M16 7.5c0-1.7-1.8-3-4-3s-4 1.3-4 3 1.8 2.6 4 3 4 1.300 4 3-1.8 3-4 3-4-1.300-4-3',
  export: 'M12 4v11M8 11l4 4 4-4M4 20h16',
  staff: 'M16 19a5 5 0 0 0-10 0M11 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7M21 19a4 4 0 0 0-3-3.900M16 4.300a3.500 3.500 0 0 1 0 6.400',
  settings: 'M4 7h9M17 7h3M4 17h3M11 17h9M15 9.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5M9 19.500a2.500 2.500 0 1 0 0-5 2.500 2.500 0 0 0 0 5',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  eye: 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  eyeOff: 'M4 4l16 16M9.9 5.800A9.300 9.300 0 0 1 12 5.500c6 0 9.500 6.500 9.500 6.500a17 17 0 0 1-2.700 3.500M14.100 14.100a3 3 0 0 1-4.200-4.200M6.300 7.400A16.500 16.500 0 0 0 2.500 12S6 18.500 12 18.500a9.200 9.200 0 0 0 3.700-.800',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M20 20l-4-4',
  close: 'M6 6l12 12M18 6L6 18',
  back: 'M14.500 5.500L8 12l6.500 6.500',
  print: 'M7 8V4h10v4M7 17H5a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2M7 14h10v6H7z',
  check: 'M5 12.500l4.500 4.500L19 7.500',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M20 12a8 8 0 1 1-2.300-5.600M20 4v4h-4',
} as const;
export type IconName = keyof typeof ICONS;
export function Icon({ name }: { name: IconName }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d={ICONS[name]} /></svg>;
}

export type Destination = { id: string; label: string; icon: IconName; group: number };

/** Desktop: the slim left rail. Destinations in groups, settings at the bottom. */
export function Rail({ items, current, onSelect, disabled, end }: { items: Destination[]; current: string; onSelect: (id: string) => void; disabled: boolean; end: Destination[] }) {
  const button = (x: Destination) => <button key={x.id} type="button" className="nav-item" aria-current={x.id === current ? 'page' : undefined} disabled={disabled} onClick={() => onSelect(x.id)}><Icon name={x.icon} />{x.label}</button>;
  return <nav className="rail" aria-label={t('app.navigation')}>
    <div className="brand">{t('app.brand')}</div>
    {items.map((x, i) => [i > 0 && items[i - 1]!.group !== x.group && <div key={`gap-${x.id}`} className="nav-gap" />, button(x)])}
    <div className="rail-end">{end.map(button)}</div>
  </nav>;
}

/** Phones: up to five places in the bottom bar; when there are more, the last one is "More" and opens the rest as a sheet. */
export function BottomBar({ items, current, onSelect, disabled, more, onMore }: { items: Destination[]; current: string; onSelect: (id: string) => void; disabled: boolean; more: boolean; onMore: () => void }) {
  const fits = items.length <= 5, shown = fits ? items : items.slice(0, 4), inMore = !fits && !shown.some(x => x.id === current);
  return <nav className="bottombar" aria-label={t('app.navigation')}>
    {shown.map(x => <button key={x.id} type="button" className="bar-item" aria-current={x.id === current ? 'page' : undefined} disabled={disabled} onClick={() => onSelect(x.id)}><Icon name={x.icon} /><span>{x.label}</span></button>)}
    {!fits && <button type="button" className="bar-item more-toggle" aria-expanded={more} aria-haspopup="dialog" aria-current={inMore && !more ? 'true' : undefined} disabled={disabled} onClick={onMore}><Icon name="more" /><span>{t('app.more')}</span></button>}
  </nav>;
}

/** A sheet: slides up from the bottom on phones, a centred dialog on desktop. Escape or a tap outside closes it. */
export function Sheet({ title, onClose, children, className = '' }: { title: string; onClose: () => void; children: ReactNode; className?: string }) {
  const root = useRef<HTMLElement>(null), opener = useRef<Element | null>(null);
  useEffect(() => {
    opener.current = document.activeElement;
    root.current?.querySelector<HTMLElement>('[autofocus], button, input, select, textarea')?.focus();
    return () => { (opener.current as HTMLElement | null)?.focus?.(); };
  }, []);
  return <div className="sheet-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) onClose(); }}>
    <section ref={root} className={`sheet ${className}`} role="dialog" aria-modal="true" aria-label={title} onKeyDown={e => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const focusable = [...e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary')].filter(el => el.offsetParent !== null);
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }}>
      <div className="sheet-head"><h2>{title}</h2><button type="button" className="icon-button" aria-label={t('app.close')} onClick={onClose}><Icon name="close" /></button></div>
      {children}
    </section>
  </div>;
}

/** Segmented control: one choice of a few, all visible. */
export function Seg<V extends string>({ label, value, options, onChange, disabled }: { label: string; value: V; options: readonly (readonly [V, string])[]; onChange: (v: V) => void; disabled?: boolean }) {
  return <div className="seg" role="group" aria-label={label}>{options.map(([id, text]) =>
    <button key={id} type="button" aria-pressed={id === value} disabled={disabled} onClick={() => onChange(id)}>{text}</button>)}</div>;
}
