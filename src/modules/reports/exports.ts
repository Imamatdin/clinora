import PDFDocument from 'pdfkit';
import { zipSync, strToU8, Zip, ZipDeflate } from 'fflate';
import { once } from 'node:events';
import type { StreamResult } from '../../server/routes/types.js';
import { join } from 'node:path';
import { requireRole, recordAudit, type ClinicContext } from '../../server/roles.js';
import { DomainError } from '../identity/access.js';
import type { Report } from './actions.js';

export type Download = {name:string;mime:string;base64:string};
export const csv = (rows:unknown[][]) => '\ufeff'+rows.map(r=>r.map(v=>{
  const raw=typeof v==='object'?JSON.stringify(v):String(v??'');
  // Spreadsheet programs must never interpret exported patient/staff input as a formula.
  return '"'+(/^[=+@\-\t\r]/.test(raw)?"'"+raw:raw).replaceAll('"','""')+'"';
}).join(',')).join('\r\n');
const xml=(v:unknown)=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
/** Minimal standards-based XLSX. All values are explicit strings so UZS never loses precision. */
export function xlsx(rows:unknown[][]):Buffer {
  const files:Record<string,Uint8Array>={}; const put=(p:string,s:string)=>files[p]=strToU8(s);
  put('[Content_Types].xml','<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>');
  put('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>');
  put('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Clinora" sheetId="1" r:id="rId1"/></sheets></workbook>');
  put('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>');
  put('xl/worksheets/sheet1.xml','<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews><cols><col min="1" max="20" width="28" customWidth="1"/></cols><sheetData>'+rows.map((r,i)=>`<row r="${i+1}">`+r.map(v=>`<c t="inlineStr"><is><t xml:space="preserve">${xml(v)}</t></is></c>`).join('')+'</row>').join('')+'</sheetData></worksheet>');
  return Buffer.from(zipSync(files));
}
export async function pdf(title:string,rows:unknown[][],thermal=false):Promise<Buffer> {
  const doc=new PDFDocument({size:thermal?[226.77,841.89]:'A4',margin:thermal?14:42,bufferPages:true});
  doc.registerFont('body',join(process.cwd(),'assets/fonts/DejaVuSans.ttf'));
  doc.registerFont('bold',join(process.cwd(),'assets/fonts/DejaVuSans-Bold.ttf'));
  const chunks:Buffer[]=[]; const done=new Promise<Buffer>((resolve,reject)=>{doc.on('data',c=>chunks.push(c));doc.on('end',()=>resolve(Buffer.concat(chunks)));doc.on('error',reject);});
  const margin=thermal?14:42,width=doc.page.width-margin*2,bottom=doc.page.height-margin-25;
  const heading=()=>{doc.font('bold').fontSize(9).fillColor('#8b5036').text('CLINORA');doc.moveDown(.4).fontSize(thermal?13:19).fillColor('#50344d').text(title).moveDown(.8);};
  heading();let section=true,rowIndex=0;
  for(const row of rows){
    if(!row.length){doc.y+=10;section=true;continue;}
    const values=row.map(v=>{const s=String(v??'');return /^-?\d+$/.test(s)?BigInt(s).toLocaleString('ru-RU'):s;});
    const weights=values.length===2?[.62,.38]:values.length===3?[.5,.25,.25]:values.length===4?[.25,.16,.42,.17]:values.map(()=>1/values.length);
    const sizes=weights.map(n=>n*width),fontSize=thermal?8.5:9;
    doc.font(section?'bold':'body').fontSize(fontSize);
    const height=Math.max(...values.map((v,i)=>doc.heightOfString(v,{width:sizes[i]!-12})),13)+14;
    if(doc.y+height+(section?50:0)>bottom){doc.addPage();heading();}
    doc.font(section?'bold':'body').fontSize(fontSize);
    const y=doc.y;let x=margin;
    if(section||rowIndex%2===0)doc.rect(margin,y,width,height).fill(section?'#e9e1e7':'#f7f4ef');
    doc.fillColor('#302934');
    values.forEach((value,i)=>{doc.text(value,x+6,y+7,{width:sizes[i]!-12,align:i>0&&/^-?[\d\s\u00a0]+$/.test(value)?'right':'left'});x+=sizes[i]!;});
    doc.y=y+height;doc.moveTo(margin,doc.y).lineTo(margin+width,doc.y).lineWidth(.4).strokeColor('#ddd5ce').stroke();
    section=false;rowIndex++;
  }
  const pages=doc.bufferedPageRange();
  for(let i=pages.start;i<pages.start+pages.count;i++){doc.switchToPage(i);doc.font('body').fontSize(8).fillColor('#71656d').text(`Clinora  |  ${i+1} / ${pages.count}`,margin,doc.page.height-margin-12,{width,lineBreak:false,align:'right'});}
  doc.end();return done;
}
export const download=(name:string,mime:string,data:Buffer):Download=>({name,mime,base64:data.toString('base64')});
export const LABELS:Record<string,string>={patients:'Беморлар',new:'Янги беморлар',returning:'Қайта келганлар',outpatient:'Амбулатор',inpatient:'Стационар',value:'Хизматлар қиймати',discounts:'Чегирмалар',outstanding:'Қолдиқ қарз',collected:'Тушум',cash:'Нақд',card:'Карта',transfer:'Ўтказма',refunds:'Қайтарилган',cashOuts:'Касса харажатлари',net:'Соф тушум',lab:'Лаборатория тушуми',ward:'Стационар тушуми'};
export async function reportExport(c:ClinicContext,report:Report,format:'pdf'|'xlsx'|'thermal',cashPrint=false) {
  await requireRole(c.tx,c.actorId,c.clinicId,cashPrint?['ceo','administrator','cashier']:['ceo']);
  const rows:unknown[][]=[[report.clinic,report.from,report.to],...Object.entries(report.totals).map(([k,v])=>[LABELS[k],v]),[],['Шифокор','Тушум, сўм'],...report.doctors.map(d=>[d.name,d.amount]),[],['Бўлим','Тушум, сўм'],...report.departments.map(d=>[d.name,d.amount])];
  if(report.needsReview?.length)rows.push([],['Текшириш керак'],...report.needsReview.map(v=>[v.id,v.label]));
  for(const s of report.cashShifts??[])rows.push([],['Кассир',s.cashier,s.date],['Смена',s.id],['Бошланғич нақд',s.opening],['Кутилаётган нақд',s.expected],['Саналган нақд',s.counted??'Қайд этилмаган'],['Фарқ',s.difference??'Қайд этилмаган']);
  if(format!=='thermal')for(const [key,lines]of Object.entries(report.details))rows.push([],[LABELS[key],'Сана','Манба','Миқдор'],...lines.map(l=>[l.id,l.date,l.label,l.amount]));
  await recordAudit(c.tx,c.actorId,c.clinicId,'reports.exported',c.clinicId,{format,from:report.from,to:report.to});
  return format==='xlsx'?download('clinora-report.xlsx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xlsx(rows)):download('clinora-report.pdf','application/pdf',await pdf('Касса ва клиника ҳисоботи',rows,format==='thermal'));
}
/** Clinical/operational allowlist. Authentication tokens, passwords, invite codes, provider
 * credentials and replay caches never belong in a portable clinic archive. */
const EXPORT_TABLES=['clinics','patients','patient_assignments','patient_duplicate_overrides','encounters','documents','document_versions','note_approvals','assistant_captures','assistant_transcripts','assistant_segments','assistant_drafts','assistant_extraction_runs','assistant_proposals','assistant_field_versions','assistant_approvals','visits','business_days','departments','services','service_groups','service_prices','doctor_profiles','catalog_doctors','doctor_services','queue_points','queue_tickets','charge_lines','discounts','payments','payment_allocations','cashier_allocation_adjustments','receipts','cash_desks','cash_shifts','expense_types','cash_outs','admissions','rooms','room_types','beds','bed_assignments','bed_day_charges','caretakers','caretaker_day_charges','lab_results','surgeries','stock_movements','pharmacy_settings','doctor_split_rules','payroll_periods','payroll_lines','clinic_settings','districts','mahallas','membership_roles','audit_events'];
const EXCLUDED_COLUMNS:Record<string,string[]>={assistant_captures:['lease_token','lease_until','client_key','telegram_file_id']};
/** Rows fetched per cursor round trip; bounds memory regardless of clinic size. */
export const EXPORT_BATCH=2000;
/**
 * Full clinic archive, streamed (task 024): the request transaction checks the role and records the
 * audit event; app.ts then runs `write` in one READ ONLY REPEATABLE READ snapshot, which rechecks the
 * role, reads each table through a cursor and deflates CSV into the ZIP as it goes.
 */
export async function fullExport(c:ClinicContext):Promise<StreamResult> {
  await requireRole(c.tx,c.actorId,c.clinicId,['ceo']);
  await recordAudit(c.tx,c.actorId,c.clinicId,'reports.full_export',c.clinicId,{tables:EXPORT_TABLES.length+1});
  const {actorId,clinicId}=c;
  return {contentType:'application/zip',filename:'clinora-clinic.zip',write:async(tx,out)=>{
    // Access revoked since the request is refused here too (plain read: the snapshot is read-only).
    const still=(await tx.query(`SELECT 1 FROM memberships m JOIN membership_roles r ON r.clinic_id=m.clinic_id AND r.user_id=m.user_id
      WHERE m.clinic_id=$1 AND m.user_id=$2 AND m.status='active' AND r.role='ceo'`,[clinicId,actorId])).rowCount;
    if(!still)throw new DomainError('FORBIDDEN');
    let failed:Error|null=null;
    const zip=new Zip((error,chunk,final)=>{if(error){failed=error;return;}out.write(chunk);if(final)failed??=null;});
    const drain=async()=>{if(failed)throw failed;if(out.writableNeedDrain)await once(out,'drain');};
    const file=async(name:string,header:string[],rows:AsyncIterable<unknown[][]>)=>{
      const entry=new ZipDeflate(name,{level:6});zip.add(entry);
      entry.push(strToU8(csv([header])));
      for await(const batch of rows)if(batch.length){entry.push(strToU8('\r\n'+csv(batch).slice(1)));await drain();}
      entry.push(new Uint8Array(0),true);await drain();
    };
    const projections=(await tx.query(`SELECT table_name,column_name,data_type FROM information_schema.columns WHERE table_schema=current_schema() AND table_name=ANY($1::text[]) ORDER BY ordinal_position`,[EXPORT_TABLES])).rows;
    for(const table of EXPORT_TABLES){
      const columns=projections.filter(r=>r.table_name===table && !(EXCLUDED_COLUMNS[table]??[]).includes(r.column_name));
      // bigint as text (exact UZS); timestamps in the same ISO form the archive always used.
      const select=columns.map(r=>r.data_type==='bigint'?`"${r.column_name}"::text`:r.data_type==='timestamp with time zone'?`to_json("${r.column_name}")#>>'{}' "${r.column_name}"`:`"${r.column_name}"`);
      await tx.query(`DECLARE export_rows NO SCROLL CURSOR FOR SELECT ${select.join(',')} FROM ${table} WHERE ${table==='clinics'?'id':'clinic_id'}=$1`,[clinicId]);
      const names=columns.map(r=>r.column_name as string);
      await file(`${table}.csv`,names,(async function*(){
        for(;;){const rows=(await tx.query(`FETCH ${EXPORT_BATCH} FROM export_rows`)).rows;if(!rows.length)break;yield rows.map(r=>names.map(k=>r[k]));}
      })());
      await tx.query('CLOSE export_rows');
    }
    const staff=(await tx.query(`SELECT a.id,a.display_name,a.login,a.phone,m.status FROM accounts a JOIN memberships m ON m.user_id=a.id WHERE m.clinic_id=$1`,[clinicId])).rows;
    await file('staff.csv',['id','display_name','login','phone','status'],(async function*(){yield staff.map(a=>[a.id,a.display_name,a.login,a.phone,a.status]);})());
    const readme=new ZipDeflate('README.txt',{level:6});zip.add(readme);
    readme.push(strToU8('Clinora clinic data export. UTF-8 CSV; integer UZS. Authentication secrets excluded. Sensitive clinical data: store with restricted access.'),true);
    zip.end();await drain();
  }};
}
