import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ModuleProps, WebModule } from '../modules.js';
import { errorText } from '../i18n/index.js';
import { ApiFailure } from '../api.js';
import { translator } from './i18n.js';
import { useLocale } from '../i18n/locale.js';
import { AbrField } from '../abr.js';
import { Icon, Seg } from '../shell.js';
type Item = { id:string; name:string; on_hand:string; threshold:number; unit:string };
export type Choice = { id:string; name:string; admission_id?:string|null };
type Movement = { id:string; qty:number; reason:'receipt'|'dispense'|'adjustment'|'return'; note:string|null; created_at:string };
export function Pharmacy({ clinic, request, setDirty }:ModuleProps) {
  const locale = useLocale(), t = translator(locale);
  const [items,setItems] = useState<Item[]>([]), [visits,setVisits] = useState<Choice[]>([]), [moves,setMoves] = useState<Movement[]>([]);
  const [item,setItem] = useState(''), [mode,setMode] = useState<'receipt'|'dispense'|'adjust'|'threshold'>('receipt');
  const [busy,setBusy] = useState(true), [error,setError] = useState(''), [notice,setNotice] = useState('');
  const key = useRef(crypto.randomUUID()), base = `/api/clinics/${clinic.id}/pharmacy`;
  async function load() { const [stock,options] = await Promise.all([request<Item[]>(base+'/stock'),request<Choice[]>(base+'/visits')]); setItems(stock);setVisits(options);setItem(old => stock.some(i => i.id===old) ? old : stock[0]?.id ?? ''); }
  useEffect(() => { load().catch(e => setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE'))).finally(() => setBusy(false)); },[clinic.id]);
  useEffect(() => { setMoves([]); if (item) request<Movement[]>(`${base}/stock/${item}/history`).then(setMoves).catch(() => setError(errorText('SERVICE_UNAVAILABLE'))); },[item,notice]);
  async function submit(e:FormEvent<HTMLFormElement>) {
    e.preventDefault(); const form=e.currentTarget, f=new FormData(form);setBusy(true);setError('');setNotice('');
    const payload = { serviceId:item,idempotencyKey:key.current,
      ...(mode==='threshold' ? {threshold:Number(f.get('qty'))} : {qty:Number(f.get('qty'))}),
      ...(mode==='receipt' ? {unitCostUzs:String(f.get('cost')),supplier:String(f.get('supplier')),note:String(f.get('note'))||undefined}:{}),
      ...(mode==='adjust' ? {reason:String(f.get('note'))}:{}),
      ...(mode==='dispense' ? {visitId:String(f.get('visit'))}:{}),
      ...(['dispense','adjust'].includes(mode) ? {overrideReason:String(f.get('override'))||undefined}:{}) };
    try { await request(base+'/'+({receipt:'receipts',dispense:'dispense',adjust:'adjustments',threshold:'threshold'}[mode]),payload);key.current=crypto.randomUUID();setDirty(false);setNotice(t('pharmacy.saved'));form.reset();await load(); }
    catch(e) {setError(errorText(e instanceof ApiFailure ? e.code : 'SERVICE_UNAVAILABLE'));}finally{setBusy(false);}
  }
  const selected = items.find(i=>i.id===item);
  const low = items.filter(i=>BigInt(i.on_hand)<=BigInt(i.threshold));
  return <section className="pharmacy screen">
    <div className="banners" aria-live="polite">{error&&<p role="alert" className="error">{error}</p>}{notice&&<p role="status" className="notice">{notice}</p>}{busy&&<p role="status" className="sr-only">{t('pharmacy.loading')}</p>}</div>
    <div className="hero"><AbrField /><div className="hero-in ward-hero">
      <div><p className="hero-label">{t('pharmacy.low')}</p><p className={`hero-figure ${low.length?'attn':'okc'}`}>{low.length}</p></div>
      <button className="quiet" disabled={busy} onClick={()=>{setBusy(true);load().catch(()=>setError(errorText('SERVICE_UNAVAILABLE'))).finally(()=>setBusy(false));}}><Icon name="refresh" />{t('pharmacy.refresh')}</button>
    </div></div>
    {!busy&&!items.length&&<p className="empty">{t('pharmacy.empty')}</p>}
    {low.length>0&&<ul className="rows pharmacy-low">{low.map(i=><li key={i.id}><button type="button" className="row" aria-pressed={i.id===item} onClick={()=>setItem(i.id)}>
      <span className="row-title row-body">{i.name}</span><span className="row-end attn num">{i.on_hand} {i.unit}</span></button></li>)}</ul>}
    <form className="pharmacy-form" onSubmit={submit} onChange={()=>{key.current=crypto.randomUUID();setDirty(true);}}><fieldset disabled={busy}>
      <Seg label={t('pharmacy.title')} value={mode} onChange={setMode} options={(['receipt','dispense','adjust','threshold'] as const).map(m=>[m,t(`pharmacy.mode.${m}`)] as const)} />
      <label>{t('pharmacy.item')}<select aria-label={t('pharmacy.item')} required value={item} onChange={e=>setItem(e.target.value)}>{items.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
      {selected&&<p className="pharmacy-onhand">{t('pharmacy.onHand')}: {selected.on_hand} {selected.unit}</p>}
      <label>{t(mode==='threshold'?'pharmacy.threshold':'pharmacy.qty')}<input name="qty" type="number" step="1" min={mode==='adjust'?undefined:mode==='threshold'?0:1} required /></label>
      {mode==='receipt'&&<><label>{t('pharmacy.cost')}<input name="cost" inputMode="numeric" pattern="[0-9]+" required /></label><label>{t('pharmacy.supplier')}<input name="supplier" required maxLength={1000}/></label></>}
      {mode==='dispense'&&<label>{t('pharmacy.visit')}<select aria-label={t('pharmacy.visit')} name="visit" required>{visits.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>}
      {['receipt','adjust'].includes(mode)&&<label>{t('pharmacy.note')}<input name="note" required={mode==='adjust'} maxLength={1000}/></label>}
      {['dispense','adjust'].includes(mode)&&clinic.roles.some(r=>['ceo','administrator'].includes(r))&&<label>{t('pharmacy.override')}<input name="override" maxLength={1000}/></label>}
      <button className="primary big" disabled={busy||!item}>{t('pharmacy.save')}</button>
    </fieldset></form>
    <details className="ward-form"><summary>{t('pharmacy.history')}{moves.length>0&&` · ${moves.length}`}</summary><ul className="rows">{moves.map(m=><li key={m.id}><div className="row">
      <span className="row-body"><span className="row-title">{t(`pharmacy.${m.reason}Reason`)}</span><span className="row-meta">{new Date(m.created_at).toLocaleString(locale)}{m.note&&` · ${m.note}`}</span></span>
      <span className="row-end num">{m.qty}</span></div></li>)}</ul></details>
  </section>;
}
export const pharmacyModule:WebModule={id:'pharmacy',roles:['ceo','administrator','pharmacy'],label:'pharmacy.title',Screen:Pharmacy};
