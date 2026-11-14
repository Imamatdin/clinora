// Task 028: abr (ikat), drawn the way it is woven. Every shape is a row of thin vertical warp threads whose ends are
// stepped and slightly uneven, so colour ends in a feathered edge instead of a border. Decorative only: text never
// sits on the busy part, and structure must still read with it removed (docs/DESIGN.md).
import { useLayoutEffect, useMemo, useRef, useState } from 'react';

const rng = (seed: number) => () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;
const step = (v: number, s: number) => Math.round(v / s) * s;
type Edge = (x: number) => number;
function threads(x0: number, x1: number, top: Edge, bottom: Edge, seed: number, jitter: number, w = 3) {
  const r = rng(seed); let d = '';
  for (let x = x0; x < x1; x += w) { const t = top(x) + (r() - .5) * 2 * jitter, b = bottom(x) + (r() - .5) * 2 * jitter; if (b > t) d += `M${x} ${t.toFixed(1)}h${w}V${b.toFixed(1)}h${-w}z`; }
  return d;
}
/** A stepped lozenge (the ikat "eye"): its half-height shrinks in steps away from the centre. */
const lozenge = (cx: number, cy: number, W: number, H: number, seed: number, jitter = 5, s = 6) =>
  threads(cx - W, cx + W, x => cy - step(H * (1 - Math.abs(x - cx) / W), s), x => cy + step(H * (1 - Math.abs(x - cx) / W), s), seed, jitter);
const zig = (amp: number, period: number) => (x: number) => step(amp * Math.abs((((x / period) % 1) + 1) % 1 * 2 - 1), 4);

function useSize() {
  const ref = useRef<SVGSVGElement>(null), [size, setSize] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current; if (!el) return;
    const read = () => { const r = el.getBoundingClientRect(), w = Math.round(r.width), h = Math.round(r.height); setSize(old => old.w === w && old.h === h ? old : { w, h }); };
    read(); const observer = new ResizeObserver(read); observer.observe(el); return () => observer.disconnect();
  }, []);
  return [ref, size] as const;
}

/** The tinted field behind a screen's one focal thing: feathered top and bottom edges and one quiet motif in the corner. */
export function AbrField({ tone = 'a' }: { tone?: 'a' | 'ok' | 'attn' }) {
  const [ref, { w, h }] = useSize();
  const paths = useMemo(() => {
    if (!w || !h) return null;
    const z = zig(18, 78), cx = w - 58, cy = 66;
    return { field: threads(0, w, x => 6 + z(x), x => h - 6 - z(x + 39), 5, 6),
      motif: w >= 560 && h >= 240 ? [lozenge(cx, cy, 46, 52, 3), lozenge(cx, cy, 33, 37, 4), lozenge(cx, cy, 21, 24, 8), lozenge(cx, cy, 11, 13, 6, 1.5, 4)] : null };
  }, [w, h]);
  return <svg ref={ref} className={`abr abr-${tone}`} aria-hidden="true" focusable="false">{paths && <>
    <path className="a" d={paths.field} />
    {paths.motif && <><path className="b" d={paths.motif[0]} /><path className="a" d={paths.motif[1]} /><path className="b" d={paths.motif[2]} /><path className="c" d={paths.motif[3]} /></>}
  </>}</svg>;
}

/** The full-colour band of the signed-out screens: indigo ground, a row of eyes, a feathered lower edge. The one loud moment. */
export function AbrBand() {
  const [ref, { w, h }] = useSize();
  const paths = useMemo(() => {
    if (!w || !h) return null;
    const pitch = 130, count = Math.ceil(w / pitch) + 1, start = (w - (count - 1) * pitch) / 2, cy = h * .59, k = Math.min(1, h / 300);
    const eyes = Array.from({ length: count }, (_, i) => start + i * pitch);
    return { ground: threads(0, w, () => -20, x => h - 30 - zig(24, 65)(x), 7, 8),
      eyes: eyes.map((x, i) => [lozenge(x, cy, 60 * k, 70 * k, 11 + i), lozenge(x, cy, 46 * k, 54 * k, 21 + i), lozenge(x, cy, 32 * k, 37 * k, 31 + i), lozenge(x, cy, 19 * k, 22 * k, 41 + i)]),
      seeds: eyes.slice(0, -1).map((x, i) => lozenge(x + pitch / 2, cy, 9, 22 * k, 51 + i)) };
  }, [w, h]);
  return <svg ref={ref} className="abr" aria-hidden="true" focusable="false">{paths && <>
    <path className="i" d={paths.ground} />
    {paths.seeds.map((d, i) => <path key={`s${i}`} className="s" d={d} />)}
    {paths.eyes.map((e, i) => <g key={i}><path className="g" d={e[0]} /><path className="c" d={e[1]} /><path className="g" d={e[2]} /><path className={i % 2 ? 's' : 'r'} d={e[3]} /></g>)}
  </>}</svg>;
}

/** The queue number as a ticket: the same object in registration, the doctor's queue, the cashier and on paper. */
export function Ticket({ children, kind = '' }: { children: React.ReactNode; kind?: '' | 'big' | 'done' | 'wide' | 'big wide' | 'done wide' }) {
  return <span className={`ticket ${kind}`}>{children}</span>;
}
