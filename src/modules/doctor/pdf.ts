import PDFDocument from 'pdfkit';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PrescriptionDocument } from './actions.js';

/**
 * Prescription sheet (retsept varaqasi), A4, rendered on the server from the approved document version only.
 * DejaVu Sans covers Uzbek Cyrillic and Latin and Russian. The approval and version ids are printed on the
 * sheet and stored in the PDF metadata so a printed copy can be traced to the exact approved version.
 */
function fontDir(): string {
  for (const up of ['../../../assets/fonts', '../../../../assets/fonts']) {
    const dir = fileURLToPath(new URL(up, import.meta.url));
    if (existsSync(join(dir, 'DejaVuSans.ttf'))) return dir;
  }
  return join(process.cwd(), 'assets/fonts');
}
const day = (iso: string) => iso.split('-').reverse().join('.');

export function renderPrescriptionPdf(d: PrescriptionDocument): Promise<Buffer> {
  const dir = fontDir();
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: 'Clinora prescription', Producer: 'Clinora', Creator: 'Clinora',
    Subject: `approval ${d.approvalId}`, Keywords: `version ${d.versionId} revision ${d.revision}` } });
  doc.registerFont('body', join(dir, 'DejaVuSans.ttf'));
  doc.registerFont('bold', join(dir, 'DejaVuSans-Bold.ttf'));
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const when = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: d.timezone }).format(new Date(d.approvedAt));

  doc.font('bold').fontSize(15).text(d.clinic.name);
  const contact = [d.clinic.address, d.clinic.phone].filter(Boolean).join(' · ');
  if (contact) doc.font('body').fontSize(9).fillColor('#444').text(contact).fillColor('#000');
  doc.moveDown(0.8).font('bold').fontSize(14).text('РЕЦЕПТ ВАРАҚАСИ', { align: 'center' });
  doc.moveDown(0.6).font('body').fontSize(11)
    .text(`Бемор: ${d.patient.name}${d.patient.patientNo ? ` · № ${d.patient.patientNo}` : ''}`)
    .text(`Туғилган сана: ${d.patient.birthDate ? day(d.patient.birthDate) : 'қайд этилмаган'}`)
    .text(`Шифокор: ${d.doctor.name}${d.doctor.specialty ? ` (${d.doctor.specialty})` : ''}`)
    .text(`Сана: ${when}`);
  doc.moveDown(0.6).font('bold').text('Ташхис');
  doc.font('body').fillColor(d.diagnosis ? '#000' : '#777').text(d.diagnosis ?? 'Қайд этилмаган').fillColor('#000');
  doc.moveDown(0.6).font('bold').text('Буюрилган дорилар');
  if (!d.lines.length) doc.font('body').fillColor('#777').text('Дори буюрилмаган').fillColor('#000');
  d.lines.forEach((l, i) => {
    doc.font('bold').fontSize(11).text(`${i + 1}. ${l.medicine}`, { continued: false });
    doc.font('body').fontSize(10).text(`Дозаси: ${l.dose} · Қабул: ${l.frequency} · Давомийлиги: ${l.duration}`, { indent: 14 });
    if (l.notes) doc.text(`Изоҳ: ${l.notes}`, { indent: 14 });
    doc.moveDown(0.3);
  });
  if (d.recommendations) { doc.moveDown(0.4).font('bold').fontSize(11).text('Тавсиялар'); doc.font('body').text(d.recommendations); }
  doc.moveDown(2).font('body').fontSize(11).text('Шифокор имзоси: ____________________', { align: 'right' });
  doc.moveDown(1.5).fontSize(8).fillColor('#555')
    .text(`Тасдиқланган версия ${d.revision} · ${d.versionId} · тасдиқ ${d.approvalId}`)
    .text('Синов версияси: фақат синтетик беморлар учун. Клиник текширувдан ўтмаган.');
  doc.end();
  return done;
}
