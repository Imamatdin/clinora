import { useState } from 'react';
import { currentLocale,useLocale } from '../i18n/locale.js';
import type { Download } from '../../modules/reports/exports.js';
import { ceo } from '../i18n/ceo.uz-Cyrl.js';
import { ceoUzLatn } from '../i18n/ceo.uz-Latn.js';
import { ceoRu } from '../i18n/ceo.ru.js';
export type Key=keyof typeof ceo;
const dictionaries={'uz-Cyrl':ceo,'uz-Latn':ceoUzLatn,ru:ceoRu};
export const t=(key:Key)=>dictionaries[currentLocale()][key];
/** Reports follow the shell's single interface language (header switch). */
export const useReportLocale=useLocale;
export const money=(value:string|bigint)=>BigInt(value).toLocaleString('ru-RU');
export const metric=(key:string)=>t(`ceo.${key}` as Key);
export function saveFile(file:Download) {
  const raw=atob(file.base64),bytes=Uint8Array.from(raw,c=>c.charCodeAt(0));
  saveBlob(new Blob([bytes],{type:file.mime}),file.name);
}
export function saveBlob(blob:Blob,name:string) {
  const url=URL.createObjectURL(blob),a=document.createElement('a');
  a.href=url;a.download=name;a.hidden=true;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);
}
export function Dates({from,to,onChange,onSubmit,busy}:{from:string;to:string;onChange:(from:string,to:string)=>void;onSubmit:()=>void;busy:boolean}) {
  return <form className="ceo-dates" onSubmit={e=>{e.preventDefault();onSubmit();}}>
    <label>{t('ceo.from')}<input type="date" required max={to} value={from} onChange={e=>onChange(e.target.value,to)} /></label>
    <label>{t('ceo.to')}<input type="date" required min={from} value={to} onChange={e=>onChange(from,e.target.value)} /></label>
    <button className="ceo-primary" disabled={busy}>{t('ceo.show')}</button>
  </form>;
}
export function Confirm({text,label=text,onConfirm,busy}:{text:string;label?:string;onConfirm:()=>void;busy:boolean}) {
  const [open,setOpen]=useState(false);
  return <>{!open?<button className="ceo-primary" disabled={busy} onClick={()=>setOpen(true)}>{label}</button>:<div className="ceo-confirm" role="group" aria-label={text}><p>{text}</p><button className="ceo-primary" disabled={busy} onClick={()=>{setOpen(false);onConfirm();}}>{t('ceo.confirm')}</button><button disabled={busy} onClick={()=>setOpen(false)}>{t('ceo.cancel')}</button></div>}</>;
}
