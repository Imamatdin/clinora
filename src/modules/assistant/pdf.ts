import PDFDocument from 'pdfkit';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Server-side A4 PDF of an approved assistant note (visit note with prescription and lab orders).
 * Rendered only from the stored approved document version; never from browser-supplied text.
 * DejaVu Sans covers Uzbek Cyrillic (Ўў Ққ Ғғ Ҳҳ), Uzbek Latin apostrophes (ʻ) and Russian.
 */
function fontDir(): string {
  // Works from source (tsx) and from the compiled dist tree.
  for (const up of ['../../../assets/fonts', '../../../../assets/fonts']) {
    const dir = fileURLToPath(new URL(up, import.meta.url));
    if (existsSync(join(dir, 'DejaVuSans.ttf'))) return dir;
  }
  return join(process.cwd(), 'assets/fonts');
}

const LABELS: Record<string, string> = {
  'gp.complaints': 'Шикоятлар', 'gp.hpi': 'Касаллик тарихи (anamnesis morbi)', 'gp.pastHistory': 'Ўтказилган касалликлар ва аллергия',
  'gp.examination': 'Кўрик', 'gp.diagnosis': 'Дастлабки ташхис (МКБ-10)', 'gp.plan': 'Даволаш режаси ва тавсиялар',
  'gp.labOrders': 'Лаборатория текширувлари', 'gp.followUp': 'Қайта кўрик санаси'
};
const ORDER = ['gp.complaints', 'gp.hpi', 'gp.pastHistory', 'gp.examination', 'gp.diagnosis', 'gp.plan', 'gp.labOrders', 'gp.followUp'];

export type ApprovedRow = {
  approval_id: string; approved_at: Date; approver: string; clinic: string; patient: string; mrn: string | null; date_of_birth: string | null;
  encounter: { occurrence: { precision: string; date?: string; at?: string; reason?: string }; location: { label: string } };
  version: { id: string; revision: number; fields: { key: string; value: string | number | boolean | null }[] };
};

export function visitDateText(o: ApprovedRow['encounter']['occurrence']): string {
  if (o.precision === 'date' && o.date) return o.date.split('-').reverse().join('.');
  if (o.precision === 'instant' && o.at) return new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Tashkent' }).format(new Date(o.at));
  return 'Сана номаълум' + (o.reason ? ` (${o.reason})` : '');
}

export function renderApprovedPdf(row: ApprovedRow): Promise<Buffer> {
  const dir = fontDir();
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: 'Clinora visit note', Producer: 'Clinora', Creator: 'Clinora' } });
  doc.registerFont('body', join(dir, 'DejaVuSans.ttf'));
  doc.registerFont('bold', join(dir, 'DejaVuSans-Bold.ttf'));
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
  const fields = new Map(row.version.fields.map(f => [f.key, f.value]));
  doc.font('bold').fontSize(16).text(row.clinic);
  doc.font('body').fontSize(12).text('Қабул хулосаси — терапевт (умумий амалиёт шифокори)');
  doc.moveDown(0.5).fontSize(10).fillColor('#444')
    .text(`Бемор: ${row.patient}${row.mrn ? ` · Карта № ${row.mrn}` : ''}${row.date_of_birth ? ` · Туғилган сана: ${row.date_of_birth.split('-').reverse().join('.')}` : ''}`)
    .text(`Қабул санаси: ${visitDateText(row.encounter.occurrence)} · ${row.encounter.location.label}`)
    .fillColor('#000');
  doc.moveDown();
  for (const key of ORDER) {
    const notExamined = key === 'gp.examination' && fields.get('gp.examination.notExamined') === true;
    const value = notExamined ? 'Кўрик ўтказилмаган' : fields.get(key);
    doc.font('bold').fontSize(11).text(LABELS[key]!);
    doc.font('body').fontSize(11).fillColor(value === undefined || value === null ? '#777' : '#000')
      .text(value === undefined || value === null ? 'Қайд этилмаган' : String(value), { paragraphGap: 8 }).fillColor('#000');
  }
  doc.moveDown();
  doc.font('body').fontSize(9).fillColor('#333')
    .text(`Тасдиқлади: ${row.approver} · ${new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Asia/Tashkent' }).format(row.approved_at)} (Asia/Tashkent)`)
    .text(`Ҳужжат версияси ${row.version.revision} · ${row.version.id} · тасдиқ ${row.approval_id}`)
    .moveDown(0.5)
    .text('Синов версияси: фақат сохта (синтетик) беморлар. Қоралама сунъий интеллект ёрдамида тайёрланган ва шифокор томонидан майдонма-майдон тасдиқланган. Клиник текширувдан ўтмаган.');
  doc.end();
  return done;
}
