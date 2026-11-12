import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ModuleProps, WebModule } from '../modules.js';
import { errorText } from '../i18n/index.js';
import { ApiFailure } from '../api.js';
import { formatUzs, uzs } from '../../modules/billing/money.js';
import { DtError, type DtExtract } from '../../modules/import1c/dt.js';
import { FIELDS_FOR, guessMapping, MAPPABLE, rowsFromTable, TableError, type ColumnMapping, type Mappable } from '../../modules/import1c/table.js';
import { SERVICE_KINDS, type ImportRow, type ServiceKind } from '../../modules/import1c/model.js';
import { contentHash, pages, readDtInBrowser, readTableInBrowser, supported } from './files.js';
import { hasKey, languages, pickName, translator, type CatalogKey, type Locale, type Names } from './i18n.js';

const LISTS = ['service', 'department', 'serviceGroup', 'doctor', 'district', 'mahalla', 'roomType', 'expenseType'] as const;
type List = (typeof LISTS)[number];
type Item = {
  id: string; list: List; names: Names & { uzCyrl: string }; code: string | null; active: boolean;
  departmentId?: string | null; groupId?: string | null; districtId?: string | null; kind?: ServiceKind; unit?: string; trackStock?: boolean;
  priceUzs?: string | null; specialty?: string | null; linkedUserId?: string | null; linkedUserName?: string | null; serviceIds?: string[];
};
type Ref = { id: string; names: Names & { uzCyrl: string } };
type Options = { departments: Ref[]; groups: (Ref & { departmentId: string | null })[]; districts: Ref[]; doctors: { userId: string; fullName: string }[] };
type Counts = { new: number; changed: number; unchanged: number; rejected: number; pricesNew: number };
type PlanRow = { seq: number; object: string; source: string; code: string | null; kind: string | null; names: Names; service: string | null; priceUzs: string | null; outcome: string; reason: string | null };
type Preview = { batch: { id: string; received: number; totalRows: number; status: string };
  plan: null | { objects: Record<string, Counts>; pricesNew: number; samples: Record<string, PlanRow[]>; rejected: PlanRow[]; rejectedTotal: number } };
type T = ReturnType<typeof translator>;

const money = (v: string | null | undefined) => v === null || v === undefined ? null : formatUzs(uzs(v));
const listKey = (l: string) => `catalog.list.${l}` as CatalogKey;
const kindKey = (k: string) => `catalog.kind.${k}` as CatalogKey;

export function Catalog({ clinic, request, setDirty }: ModuleProps) {
  const [locale, setLocale] = useState<Locale>('uz-Cyrl'), t = translator(locale);
  const [tab, setTab] = useState<'lists' | 'import'>('lists');
  const base = `/api/clinics/${clinic.id}/catalog`;
  return <section className="catalog">
    <div className="catalog-head">
      <h2>{t('catalog.title')}</h2>
      <label className="catalog-lang">{t('catalog.language')}
        <select value={locale} onChange={e => setLocale(e.target.value as Locale)}>{languages.map(l => <option key={l.id} value={l.id}>{l.label}</option>)}</select>
      </label>
    </div>
    <div className="catalog-tabs" role="tablist">
      {(['lists', 'import'] as const).map(id => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => setTab(id)}>{t(`catalog.tab.${id}`)}</button>)}
    </div>
    {tab === 'lists' ? <Lists base={base} request={request} t={t} locale={locale} setDirty={setDirty} /> : <Import base={base} request={request} t={t} locale={locale} setDirty={setDirty} />}
  </section>;
}

type ViewProps = { base: string; request: ModuleProps['request']; t: T; locale: Locale; setDirty: ModuleProps['setDirty'] };
function useRunner() {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const locked = useRef(false);
  async function run(work: () => Promise<void>) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(''); setNotice('');
    try { await work(); } catch (e) { setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE')); }
    finally { setBusy(false); locked.current = false; }
  }
  return { busy, error, setError, notice, setNotice, run };
}

type Panel = { mode: 'edit' | 'new' | 'price' | 'link' | 'services'; item: Item | null } | null;
function Lists({ base, request, t, locale, setDirty }: ViewProps) {
  const [list, setList] = useState<List>('service');
  const [query, setQuery] = useState(''), [inactive, setInactive] = useState(false);
  const [items, setItems] = useState<Item[] | null>(null), [more, setMore] = useState(false);
  const [options, setOptions] = useState<Options | null>(null);
  const [panel, setPanel] = useState<Panel>(null);
  const r = useRunner();

  async function load(offset = 0, q = query, l = list, inc = inactive) {
    const res = await request<{ items: Item[]; more: boolean }>(`${base}/search`, { list: l, query: q.trim(), includeInactive: inc, offset });
    setItems(prev => offset ? [...(prev ?? []), ...res.items] : res.items); setMore(res.more);
  }
  async function reload() { setOptions(await request<Options>(`${base}/options`)); await load(); }
  useEffect(() => { void r.run(reload); }, [base]);
  const choose = (l: List) => { setList(l); setPanel(null); setItems(null); void r.run(() => load(0, query, l)); };
  const close = async (notice?: string) => { setPanel(null); setDirty(false); await load(); if (notice) r.setNotice(notice); };
  const nameOf = (refs: Ref[] | undefined, id: string | null | undefined) => { const hit = refs?.find(x => x.id === id); return hit ? pickName(hit.names, locale) : ''; };

  return <div aria-busy={r.busy}>
    <div className="catalog-lists" role="group" aria-label={t('catalog.tab.lists')}>
      {LISTS.map(l => <button key={l} type="button" className={l === list ? 'on' : ''} aria-pressed={l === list} onClick={() => choose(l)}>{t(listKey(l))}</button>)}
    </div>
    <form className="catalog-search" role="search" onSubmit={e => { e.preventDefault(); void r.run(() => load()); }}>
      <label>{t('catalog.search')}<input value={query} onChange={e => setQuery(e.target.value)} /></label>
      <button type="submit">{t('catalog.find')}</button>
    </form>
    <label className="choice"><input type="checkbox" checked={inactive} onChange={e => { setInactive(e.target.checked); void r.run(() => load(0, query, list, e.target.checked)); }} />{t('catalog.showInactive')}</label>
    {r.error && <p role="alert" className="error">{r.error}</p>}
    {r.notice && <p role="status" className="notice">{r.notice}</p>}
    <button type="button" className="primary" onClick={() => setPanel({ mode: 'new', item: null })}>{t('catalog.new')}</button>
    {panel && options && <div className="catalog-panel">
      {(panel.mode === 'new' || panel.mode === 'edit') && <EditForm {...{ base, request, t, locale, setDirty, list, options }} item={panel.item} onDone={close} />}
      {panel.mode === 'price' && panel.item && <PriceForm {...{ base, request, t, locale, setDirty }} item={panel.item} onDone={close} />}
      {panel.mode === 'link' && panel.item && <LinkForm {...{ base, request, t, locale, setDirty, options }} item={panel.item} onDone={close} />}
      {panel.mode === 'services' && panel.item && <DoctorServices {...{ base, request, t, locale, setDirty }} item={panel.item} onDone={close} />}
    </div>}
    {!items && <p>{t('catalog.loading')}</p>}
    {items && !items.length && <p className="empty">{t('catalog.empty')}</p>}
    {items && items.length > 0 && <ul className="catalog-items">{items.map(item => <li key={item.id} className={item.active ? '' : 'off'}>
      <div className="catalog-item-main">
        <strong>{pickName(item.names, locale)}</strong>
        <span className="muted">{[item.code, item.kind && t(kindKey(item.kind)), item.specialty, nameOf(options?.departments, item.departmentId),
          nameOf(options?.groups, item.groupId), nameOf(options?.districts, item.districtId)].filter(Boolean).join(' · ')}</span>
        {list === 'service' && <span className="catalog-price">{money(item.priceUzs) ?? t('catalog.noPrice')}</span>}
        {list === 'doctor' && <span>{item.linkedUserName ? t('catalog.link.linked', { name: item.linkedUserName }) : t('catalog.link.none')}</span>}
        {!item.active && <span className="badge">{t('catalog.inactive')}</span>}
      </div>
      <div className="catalog-actions">
        {list === 'service' && item.active && <button type="button" onClick={() => setPanel({ mode: 'price', item })}>{t('catalog.setPrice')}</button>}
        <button type="button" onClick={() => setPanel({ mode: 'edit', item })}>{t('catalog.edit')}</button>
        {list === 'doctor' && <button type="button" onClick={() => setPanel({ mode: 'link', item })}>{t('catalog.link')}</button>}
        {list === 'doctor' && item.linkedUserId && <button type="button" onClick={() => setPanel({ mode: 'services', item })}>{t('catalog.services')}</button>}
        <button type="button" onClick={() => void r.run(async () => {
          await request(`${base}/active`, { list, id: item.id, active: !item.active, idempotencyKey: crypto.randomUUID() }); await load(); r.setNotice(t('catalog.saved'));
        })}>{item.active ? t('catalog.deactivate') : t('catalog.activate')}</button>
      </div>
    </li>)}</ul>}
    {more && <button type="button" onClick={() => void r.run(() => load(items?.length ?? 0))}>{t('catalog.more')}</button>}
  </div>;
}

type FormProps = Omit<ViewProps, 'setDirty'> & { setDirty: ModuleProps['setDirty']; item: Item; onDone: (notice?: string) => Promise<void> };

function EditForm({ base, request, t, locale, setDirty, list, options, item, onDone }: Omit<FormProps, 'item'> & { list: List; options: Options; item: Item | null }) {
  const [f, setF] = useState({
    nameUzCyrl: item?.names.uzCyrl ?? '', nameUzLatn: item?.names.uzLatn ?? '', nameRu: item?.names.ru ?? '', code: item?.code ?? '',
    departmentId: item?.departmentId ?? '', groupId: item?.groupId ?? '', districtId: item?.districtId ?? '',
    kind: (item?.kind ?? 'procedure') as ServiceKind, unit: item?.unit ?? 'дона', trackStock: item?.trackStock ?? false, specialty: item?.specialty ?? ''
  });
  const key = useRef(crypto.randomUUID()), r = useRunner();
  const set = (patch: Partial<typeof f>) => { setF(v => ({ ...v, ...patch })); setDirty(true); key.current = crypto.randomUUID(); };
  const doctor = list === 'doctor';
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!f.nameUzCyrl.trim()) { r.setError(t('catalog.err.nameRequired')); return; }
    if (list === 'mahalla' && !f.districtId) { r.setError(t('catalog.err.districtRequired')); return; }
    await r.run(async () => {
      const body: Record<string, unknown> = { list, nameUzCyrl: f.nameUzCyrl, nameUzLatn: doctor ? null : f.nameUzLatn || null, nameRu: doctor ? null : f.nameRu || null,
        code: f.code || null, idempotencyKey: key.current };
      if (item) body.id = item.id;
      if (['service', 'serviceGroup', 'doctor'].includes(list)) body.departmentId = f.departmentId || null;
      if (list === 'service') { body.groupId = f.groupId || null; body.unit = f.unit || 'дона'; body.trackStock = f.trackStock; if (!item) body.kind = f.kind; }
      if (list === 'mahalla') body.districtId = f.districtId;
      if (doctor) body.specialty = f.specialty || null;
      await request(`${base}/items`, body);
      await onDone(t('catalog.saved'));
    });
  }
  const select = (label: CatalogKey, value: string, refs: Ref[], onChange: (v: string) => void) => <label>{t(label)}
    <select value={value} onChange={e => onChange(e.target.value)}><option value="">{t('catalog.form.none')}</option>
      {refs.map(x => <option key={x.id} value={x.id}>{pickName(x.names, locale)}</option>)}</select></label>;
  return <form onSubmit={submit}>
    <h3>{t(item ? 'catalog.form.title.edit' : 'catalog.form.title.new')} · {t(listKey(list))}</h3>
    <label>{t(doctor ? 'catalog.form.fullName' : 'catalog.form.nameUzCyrl')}<input required value={f.nameUzCyrl} onChange={e => set({ nameUzCyrl: e.target.value })} /></label>
    {!doctor && <label>{t('catalog.form.nameUzLatn')}<input value={f.nameUzLatn} onChange={e => set({ nameUzLatn: e.target.value })} /></label>}
    {!doctor && <label>{t('catalog.form.nameRu')}<input value={f.nameRu} onChange={e => set({ nameRu: e.target.value })} /></label>}
    {doctor && <label>{t('catalog.form.specialty')}<input value={f.specialty} onChange={e => set({ specialty: e.target.value })} /></label>}
    {['service', 'serviceGroup', 'doctor'].includes(list) && select('catalog.form.department', f.departmentId, options.departments, v => set({ departmentId: v }))}
    {list === 'service' && select('catalog.form.group', f.groupId, options.groups, v => set({ groupId: v }))}
    {list === 'mahalla' && select('catalog.form.district', f.districtId, options.districts, v => set({ districtId: v }))}
    {list === 'service' && <label>{t('catalog.form.kind')}
      <select value={f.kind} disabled={!!item} onChange={e => set({ kind: e.target.value as ServiceKind, trackStock: ['medicine', 'good'].includes(e.target.value) })}>
        {SERVICE_KINDS.map(k => <option key={k} value={k}>{t(kindKey(k))}</option>)}</select>
      <span className="muted">{t('catalog.form.kindFixed')}</span></label>}
    {list === 'service' && <label>{t('catalog.form.unit')}<input value={f.unit} onChange={e => set({ unit: e.target.value })} /></label>}
    {list === 'service' && <label className="choice"><input type="checkbox" checked={f.trackStock} onChange={e => set({ trackStock: e.target.checked })} />{t('catalog.form.trackStock')}</label>}
    <label>{t('catalog.form.code')}<input value={f.code} onChange={e => set({ code: e.target.value })} /></label>
    {r.error && <p role="alert" className="error">{r.error}</p>}
    <button type="submit" className="primary" disabled={r.busy}>{t('catalog.save')}</button>
    <button type="button" onClick={() => void onDone()}>{t('catalog.cancel')}</button>
  </form>;
}

function PriceForm({ base, request, t, locale, setDirty, item, onDone }: FormProps) {
  const [amount, setAmount] = useState(''), [when, setWhen] = useState<'now' | 'date'>('now'), [date, setDate] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [history, setHistory] = useState<{ id: string; priceUzs: string; effectiveFrom: string; setBy: string }[]>([]);
  const key = useRef(crypto.randomUUID()), r = useRunner();
  useEffect(() => { void r.run(async () => setHistory(await request(`${base}/services/${item.id}/prices`))); }, [item.id]);
  const digits = amount.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  function check(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{1,15}$/.test(digits)) { r.setError(t('catalog.err.price')); return; }
    if (when === 'date' && (!date || date < new Date().toISOString().slice(0, 10))) { r.setError(t('catalog.err.dateFuture')); return; }
    r.setError(''); setConfirming(true);
  }
  const save = () => r.run(async () => {
    await request(`${base}/prices`, { serviceId: item.id, priceUzs: digits, ...(when === 'date' ? { effectiveFrom: `${date}T00:00:00+05:00` } : {}), idempotencyKey: key.current });
    await onDone(t('catalog.price.set'));
  });
  return <form onSubmit={check}>
    <h3>{t('catalog.price.title', { name: pickName(item.names, locale) })}</h3>
    <label>{t('catalog.price.amount')}<input inputMode="numeric" autoComplete="off" value={amount} onChange={e => { setAmount(e.target.value); setConfirming(false); setDirty(true); key.current = crypto.randomUUID(); }} /></label>
    <fieldset className="catalog-when"><legend>{t('catalog.price.from')}</legend>
      <label className="choice"><input type="radio" name="when" checked={when === 'now'} onChange={() => { setWhen('now'); setConfirming(false); }} />{t('catalog.price.now')}</label>
      <label className="choice"><input type="radio" name="when" checked={when === 'date'} onChange={() => { setWhen('date'); setConfirming(false); }} />{t('catalog.price.date')}</label>
      {when === 'date' && <input type="date" value={date} onChange={e => { setDate(e.target.value); setConfirming(false); }} />}
    </fieldset>
    <p className="muted">{t('catalog.price.rule')}</p>
    {r.error && <p role="alert" className="error">{r.error}</p>}
    {!confirming && <button type="submit" className="primary">{t('catalog.setPrice')}</button>}
    {confirming && <div className="catalog-confirm" role="alertdialog" aria-labelledby="catalog-price-confirm">
      <p id="catalog-price-confirm"><strong>{t('catalog.price.confirm', { amount: money(digits)! })}</strong></p>
      <button type="button" className="primary" disabled={r.busy} onClick={() => void save()}>{t('catalog.save')}</button>
      <button type="button" onClick={() => setConfirming(false)}>{t('catalog.cancel')}</button>
    </div>}
    <button type="button" onClick={() => void onDone()}>{t('catalog.cancel')}</button>
    {history.length > 0 && <><h4>{t('catalog.price.history')}</h4><ul className="catalog-history">{history.map(h =>
      <li key={h.id}>{t('catalog.price.row', { amount: money(h.priceUzs)!, date: new Date(h.effectiveFrom).toLocaleString(locale === 'ru' ? 'ru' : 'uz'), who: h.setBy })}</li>)}</ul></>}
  </form>;
}

function LinkForm({ base, request, t, setDirty, options, item, onDone }: FormProps & { options: Options }) {
  const [userId, setUserId] = useState(item.linkedUserId ?? ''), key = useRef(crypto.randomUUID()), r = useRunner();
  return <form onSubmit={e => { e.preventDefault(); void r.run(async () => {
    await request(`${base}/doctor-link`, { catalogDoctorId: item.id, userId: userId || null, idempotencyKey: key.current }); await onDone(t('catalog.saved'));
  }); }}>
    <h3>{t('catalog.link.title', { name: item.names.uzCyrl })}</h3>
    <label>{t('catalog.link.staff')}<select value={userId} onChange={e => { setUserId(e.target.value); setDirty(true); key.current = crypto.randomUUID(); }}>
      <option value="">{t('catalog.link.none')}</option>
      {options.doctors.map(d => <option key={d.userId} value={d.userId}>{d.fullName}</option>)}</select></label>
    <p className="muted">{t('catalog.link.note')}</p>
    {r.error && <p role="alert" className="error">{r.error}</p>}
    <button type="submit" className="primary" disabled={r.busy}>{t('catalog.save')}</button>
    <button type="button" onClick={() => void onDone()}>{t('catalog.cancel')}</button>
  </form>;
}

function DoctorServices({ base, request, t, locale, setDirty, item, onDone }: FormProps) {
  const [chosen, setChosen] = useState<Set<string>>(new Set(item.serviceIds ?? []));
  const [query, setQuery] = useState(''), [found, setFound] = useState<Item[]>([]), key = useRef(crypto.randomUUID()), r = useRunner();
  const search = (q: string) => r.run(async () => setFound((await request<{ items: Item[] }>(`${base}/search`, { list: 'service', query: q })).items));
  useEffect(() => { void search(''); }, []);
  if (!item.linkedUserId) return <p>{t('catalog.link.needLink')}</p>;
  const toggle = (id: string) => { setChosen(s => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); setDirty(true); key.current = crypto.randomUUID(); };
  return <form onSubmit={e => { e.preventDefault(); void r.run(async () => {
    await request(`${base}/doctor-services`, { userId: item.linkedUserId, serviceIds: [...chosen], idempotencyKey: key.current }); await onDone(t('catalog.saved'));
  }); }}>
    <h3>{t('catalog.doctorServices.title', { name: item.names.uzCyrl })}</h3>
    <div className="catalog-search"><label>{t('catalog.search')}<input value={query} onChange={e => setQuery(e.target.value)} /></label>
      <button type="button" onClick={() => void search(query)}>{t('catalog.find')}</button></div>
    <p>{t('catalog.doctorServices.count', { count: chosen.size })}</p>
    <ul className="catalog-checks">{found.map(s => <li key={s.id}><label className="choice"><input type="checkbox" checked={chosen.has(s.id)} onChange={() => toggle(s.id)} />
      {pickName(s.names, locale)} <span className="muted">{money(s.priceUzs) ?? ''}</span></label></li>)}</ul>
    {r.error && <p role="alert" className="error">{r.error}</p>}
    <button type="submit" className="primary" disabled={r.busy}>{t('catalog.save')}</button>
    <button type="button" onClick={() => void onDone()}>{t('catalog.cancel')}</button>
  </form>;
}

type Step = 'choose' | 'reading' | 'mapping' | 'uploading' | 'preview' | 'done';
type TableList = keyof typeof FIELDS_FOR;
function Import({ base, request, t, locale, setDirty }: ViewProps) {
  const [step, setStep] = useState<Step>('choose');
  const [source, setSource] = useState<'dt' | 'xlsx' | 'csv'>('dt');
  const [extract, setExtract] = useState<DtExtract | null>(null);
  const [table, setTable] = useState<string[][] | null>(null), [fileName, setFileName] = useState('');
  const [tableList, setTableList] = useState<TableList>('service'), [headerRow, setHeaderRow] = useState(true);
  const [kind, setKind] = useState<ServiceKind>('procedure'), [mapping, setMapping] = useState<ColumnMapping>({});
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [preview, setPreview] = useState<Preview | null>(null), [confirming, setConfirming] = useState(false), [result, setResult] = useState('');
  const r = useRunner();
  const reset = () => { setStep('choose'); setExtract(null); setTable(null); setPreview(null); setConfirming(false); setResult(''); setDirty(false); r.setError(''); };
  const fileError = (e: unknown) => r.setError(e instanceof DtError || e instanceof TableError ? t(`catalog.err.${e.code}` as CatalogKey) : t('catalog.err.CORRUPT'));

  async function pick(file: File | undefined) {
    if (!file) return;
    reset();
    if (!supported()) { r.setError(t('catalog.err.browser')); return; }
    const ext = /\.(dt|xlsx|csv)$/i.exec(file.name)?.[1]?.toLowerCase() as 'dt' | 'xlsx' | 'csv' | undefined;
    if (!ext) { r.setError(t('catalog.err.unsupportedFile')); return; }
    setSource(ext); setFileName(file.name); setStep('reading'); setDirty(true);
    try {
      if (ext === 'dt') { setExtract(await readDtInBrowser(file)); setStep('mapping'); }
      else { const rows = await readTableInBrowser(file); setTable(rows); setMapping(guessMapping(rows[0] ?? [])); setStep('mapping'); }
    } catch (e) { fileError(e); setStep('choose'); }
  }
  function importRows(): ImportRow[] {
    if (extract) return extract.rows;
    if (!table) return [];
    return rowsFromTable(table, tableList, mapping, { headerRow, kind, source: fileName.slice(0, 80) || source });
  }
  async function upload() {
    const rows = importRows();
    if (!rows.length) { r.setError(t('catalog.import.noRows')); return; }
    if (rows.length > 50000) { r.setError(t('catalog.import.tooMany', { count: rows.length })); return; }
    await r.run(async () => {
      setStep('uploading'); setProgress({ done: 0, total: rows.length });
      const batch = await request<{ id: string }>(`${base}/imports`, { source, contentSha256: await contentHash(rows), totalRows: rows.length, idempotencyKey: crypto.randomUUID() });
      for (const page of pages(rows)) {
        await request(`${base}/imports/${batch.id}/rows`, page);
        setProgress({ done: page.offset + page.rows.length, total: rows.length });
      }
      setPreview(await request<Preview>(`${base}/imports/${batch.id}`)); setStep('preview');
    });
    setStep(s => s === 'uploading' ? 'mapping' : s);
  }
  /** Records added or changed; price rows are counted separately as new prices. */
  const totals = (p: { objects: Record<string, Counts> }) => Object.entries(p.objects).filter(([o]) => o !== 'price').map(([, c]) => c).reduce((a, c) => ({ new: a.new + c.new, changed: a.changed + c.changed }), { new: 0, changed: 0 });
  async function commit() {
    if (!preview) return;
    await r.run(async () => {
      const done = await request<{ summary: { objects: Record<string, Counts>; pricesNew: number } }>(`${base}/imports/${preview.batch.id}/commit`, { idempotencyKey: crypto.randomUUID() });
      const sum = totals(done.summary);
      setResult(t('catalog.import.committed', { new: sum.new, changed: sum.changed, prices: done.summary.pricesNew })); setStep('done'); setDirty(false);
    });
  }
  async function discard() {
    if (!preview) return;
    await r.run(async () => { await request(`${base}/imports/${preview.batch.id}/discard`, { idempotencyKey: crypto.randomUUID() }); setResult(t('catalog.import.discarded')); setStep('done'); setDirty(false); });
  }
  const reasonText = (reason: string | null) => reason && hasKey(`catalog.reason.${reason}`) ? t(`catalog.reason.${reason}` as CatalogKey) : reason ?? '';
  const header = table && headerRow ? table[0] ?? [] : (table?.[0] ?? []).map((_c, i) => t('catalog.import.columnN', { n: i + 1 }));

  return <div aria-busy={r.busy}>
    {r.error && <p role="alert" className="error">{r.error}</p>}
    {step === 'choose' && <>
      <p>{t('catalog.import.intro')}</p>
      <label>{t('catalog.import.file')}<input type="file" accept=".dt,.xlsx,.csv" onChange={e => void pick(e.target.files?.[0])} /></label>
    </>}
    {step === 'reading' && <p role="status">{t('catalog.import.reading')}</p>}
    {step === 'mapping' && extract && <>
      <p role="status">{t('catalog.import.found', { count: extract.rows.length })}</p>
      <h3>{t('catalog.import.objects')}</h3>
      <ul className="catalog-objects">{extract.objects.map((o, i) => <li key={i}>{o.name}: {o.mode === 'skipped' ? t('catalog.import.skipped') : t('catalog.import.records', { count: o.records ?? 0 })}</li>)}</ul>
      <button type="button" className="primary" disabled={r.busy} onClick={() => void upload()}>{t('catalog.import.upload')}</button>
      <button type="button" onClick={reset}>{t('catalog.import.again')}</button>
    </>}
    {step === 'mapping' && table && <>
      <h3>{t('catalog.import.mapping')}</h3>
      <label>{t('catalog.import.listType')}<select value={tableList} onChange={e => setTableList(e.target.value as TableList)}>
        {(Object.keys(FIELDS_FOR) as TableList[]).map(l => <option key={l} value={l}>{t(listKey(l))}</option>)}</select></label>
      <label className="choice"><input type="checkbox" checked={headerRow} onChange={e => setHeaderRow(e.target.checked)} />{t('catalog.import.headerRow')}</label>
      {tableList === 'service' && <label>{t('catalog.import.defaultKind')}<select value={kind} onChange={e => setKind(e.target.value as ServiceKind)}>
        {SERVICE_KINDS.map(k => <option key={k} value={k}>{t(kindKey(k))}</option>)}</select></label>}
      <div className="catalog-mapping">{MAPPABLE.filter(m => FIELDS_FOR[tableList].includes(m)).map((m: Mappable) => <label key={m}>{t(fieldKey(m, tableList))}
        <select value={mapping[m] ?? ''} onChange={e => setMapping(v => { const n = { ...v }; if (e.target.value === '') delete n[m]; else n[m] = Number(e.target.value); return n; })}>
          <option value="">{t('catalog.import.columnNone')}</option>
          {header.map((h, i) => <option key={i} value={i}>{h || t('catalog.import.columnN', { n: i + 1 })}</option>)}</select></label>)}</div>
      <h4>{t('catalog.import.sampleRows')}</h4>
      <div className="catalog-table"><table><tbody>{table.slice(0, 6).map((row, i) => <tr key={i}>{row.map((c, j) => <td key={j}>{c}</td>)}</tr>)}</tbody></table></div>
      <button type="button" className="primary" disabled={r.busy} onClick={() => void upload()}>{t('catalog.import.upload')}</button>
      <button type="button" onClick={reset}>{t('catalog.import.again')}</button>
    </>}
    {step === 'uploading' && <p role="status">{t('catalog.import.uploading', progress)}</p>}
    {step === 'preview' && preview?.plan && <>
      <h3>{t('catalog.import.preview')}</h3>
      <p className="muted">{t('catalog.import.previewNote')}</p>
      <div className="catalog-table"><table>
        <thead><tr><th>{t('catalog.col.name')}</th><th>{t('catalog.import.col.new')}</th><th>{t('catalog.import.col.changed')}</th><th>{t('catalog.import.col.unchanged')}</th>
          <th>{t('catalog.import.col.rejected')}</th><th>{t('catalog.import.col.prices')}</th></tr></thead>
        <tbody>{Object.entries(preview.plan.objects).map(([o, c]) => <tr key={o}><th>{t(listKey(o))}</th><td>{c.new}</td><td>{c.changed}</td><td>{c.unchanged}</td><td>{c.rejected}</td><td>{c.pricesNew}</td></tr>)}</tbody>
      </table></div>
      {Object.entries(preview.plan.samples).map(([o, rows]) => <details key={o} className="catalog-more"><summary>{t('catalog.import.samples', { list: t(listKey(o)) })}</summary>
        <ul>{rows.map(row => <li key={row.seq}>{pickName(row.names, locale) || row.service} {row.kind && `· ${t(kindKey(row.kind))}`} {money(row.priceUzs) && `· ${money(row.priceUzs)}`}
          {' '}<span className="badge">{t(`catalog.import.outcome.${row.outcome}` as CatalogKey)}</span></li>)}</ul></details>)}
      {preview.plan.rejectedTotal > 0 && <details className="catalog-more" open><summary>{t('catalog.import.rejectedTitle', { count: preview.plan.rejectedTotal })}</summary>
        <ul>{preview.plan.rejected.map(row => <li key={row.seq}>{row.code ?? row.source} {pickName(row.names, locale) || row.service || ''} — <strong>{reasonText(row.reason)}</strong></li>)}</ul></details>}
      {totals(preview.plan).new + totals(preview.plan).changed + preview.plan.pricesNew === 0 && <p className="notice" role="status">{t('catalog.import.nothing')}</p>}
      {!confirming && <button type="button" className="primary" onClick={() => setConfirming(true)}>{t('catalog.import.commit')}</button>}
      {confirming && <div className="catalog-confirm" role="alertdialog" aria-labelledby="catalog-import-confirm">
        <p id="catalog-import-confirm"><strong>{t('catalog.import.commitConfirm', { new: totals(preview.plan).new, changed: totals(preview.plan).changed, prices: preview.plan.pricesNew })}</strong></p>
        <button type="button" className="primary" disabled={r.busy} onClick={() => void commit()}>{t('catalog.import.commit')}</button>
        <button type="button" onClick={() => setConfirming(false)}>{t('catalog.cancel')}</button>
      </div>}
      <button type="button" disabled={r.busy} onClick={() => void discard()}>{t('catalog.import.discard')}</button>
    </>}
    {step === 'done' && <>
      <p role="status" className="notice">{result}</p>
      <button type="button" className="primary" onClick={reset}>{t('catalog.import.again')}</button>
    </>}
  </div>;
}

function fieldKey(m: Mappable, list: TableList): CatalogKey {
  if (m === 'nameUzCyrl' && list === 'doctor') return 'catalog.form.fullName';
  if (m === 'priceUzs') return 'catalog.col.price';
  return `catalog.form.${m}` as CatalogKey;
}

export const catalogModule: WebModule = { id: 'catalog', roles: ['administrator'], label: 'module.catalog', Screen: Catalog };
