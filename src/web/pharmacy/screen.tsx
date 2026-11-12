import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ModuleProps, WebModule } from '../modules.js';
import { errorText } from '../i18n/index.js';
import { ApiFailure } from '../api.js';
import { languages, translator, type Locale } from './i18n.js';
type Item = { id:string; name:string; on_hand:string; threshold:number; unit:string };
export type Choice = { id:string; name:string; admission_id?:string|null };
type Movement = { id:string; qty:number; reason:'receipt'|'dispense'|'adjustment'|'return'; note:string|null; created_at:string };
export function Pharmacy({ clinic, request, setDirty }:ModuleProps) {
  const [locale,setLocale] = useState<Locale>('uz-Cyrl'), t = translator(locale);
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
  return <section><h2>{t('pharmacy.title')}</h2><label>{t('pharmacy.language')}<select style={{minHeight:48}} aria-label={t('pharmacy.language')} value={locale} onChange={e=>setLocale(e.target.value as Locale)}>{languages.map(l=><option key={l.id} value={l.id}>{l.label}</option>)}</select></label>
    {error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}{busy&&<p role="status">{t('pharmacy.loading')}</p>}
    <button style={{minHeight:48}} disabled={busy} onClick={()=>{setBusy(true);load().catch(()=>setError(errorText('SERVICE_UNAVAILABLE'))).finally(()=>setBusy(false));}}>{t('pharmacy.refresh')}</button>
    {!busy&&!items.length&&<p>{t('pharmacy.empty')}</p>}
    <h3>{t('pharmacy.low')}</h3><ul>{items.filter(i=>BigInt(i.on_hand)<=BigInt(i.threshold)).map(i=><li key={i.id}>{i.name}: {i.on_hand} {i.unit}</li>)}</ul>
    <form onSubmit={submit} onChange={()=>{key.current=crypto.randomUUID();setDirty(true);}}><fieldset disabled={busy} style={{border:0,padding:0,margin:0,minWidth:0}}>
      <label>{t('pharmacy.item')}<select style={{minHeight:48}} aria-label={t('pharmacy.item')} required value={item} onChange={e=>setItem(e.target.value)}>{items.map(i=><option key={i.id} value={i.id}>{i.name}</option>)}</select></label>
      {selected&&<p>{t('pharmacy.onHand')}: {selected.on_hand} {selected.unit}</p>}
      <label>{t('pharmacy.title')}<select style={{minHeight:48}} aria-label={t('pharmacy.title')} value={mode} onChange={e=>setMode(e.target.value as typeof mode)}>{(['receipt','dispense','adjust','threshold'] as const).map(m=><option key={m} value={m}>{t(`pharmacy.${m}`)}</option>)}</select></label>
      <label>{t(mode==='threshold'?'pharmacy.threshold':'pharmacy.qty')}<input style={{minHeight:48}} name="qty" type="number" step="1" min={mode==='adjust'?undefined:mode==='threshold'?0:1} required /></label>
      {mode==='receipt'&&<><label>{t('pharmacy.cost')}<input style={{minHeight:48}} name="cost" inputMode="numeric" pattern="[0-9]+" required /></label><label>{t('pharmacy.supplier')}<input style={{minHeight:48}} name="supplier" required maxLength={1000}/></label></>}
      {mode==='dispense'&&<label>{t('pharmacy.visit')}<select style={{minHeight:48}} aria-label={t('pharmacy.visit')} name="visit" required>{visits.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>}
      {['receipt','adjust'].includes(mode)&&<label>{t('pharmacy.note')}<input style={{minHeight:48}} name="note" required={mode==='adjust'} maxLength={1000}/></label>}
      {['dispense','adjust'].includes(mode)&&clinic.roles.some(r=>['ceo','administrator'].includes(r))&&<label>{t('pharmacy.override')}<input style={{minHeight:48}} name="override" maxLength={1000}/></label>}
      <button style={{minHeight:48}} disabled={busy||!item}>{t('pharmacy.save')}</button>
    </fieldset></form>
    <h3>{t('pharmacy.history')}</h3><ul>{moves.map(m=><li key={m.id}>{new Date(m.created_at).toLocaleString(locale)} — {t(`pharmacy.${m.reason}Reason`)}: {m.qty}{m.note&&` — ${m.note}`}</li>)}</ul>
  </section>;
}
export const pharmacyModule:WebModule={id:'pharmacy',roles:['ceo','administrator','pharmacy'],label:'pharmacy.title',Screen:Pharmacy};
