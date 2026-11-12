// Synthetic demo catalog for one clinic (task 008). Every person and price here is invented.
// Names are written in Uzbek Cyrillic and Russian; Uzbek Latin is transliterated from the Cyrillic.
import { randomUUID } from 'node:crypto';
import type { Tx } from '../src/server/database.ts';

const LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'yo', ж: 'j', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n',
  о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'x', ц: 's', ч: 'ch', ш: 'sh', ъ: 'ʼ', ь: '', э: 'e', ю: 'yu',
  я: 'ya', ў: 'oʻ', қ: 'q', ғ: 'gʻ', ҳ: 'h', ы: 'i'
};
/** Uzbek Cyrillic -> Latin (official 1995 alphabet; е is "ye" at the start of a word). */
export function toLatin(text: string): string {
  return text.replace(/[\p{Script=Cyrillic}]/gu, (ch, offset: number) => {
    const lower = ch.toLowerCase(), upper = ch !== lower;
    const atWordStart = offset === 0 || !/\p{L}/u.test(text[offset - 1]!);
    let out = lower === 'е' && atWordStart ? 'ye' : LATIN[lower] ?? ch;
    if (upper && out) out = out[0]!.toUpperCase() + out.slice(1);
    return out;
  });
}
const names = (uz: string, ru: string) => ({ name_uz_cyrl: uz, name_uz_latn: toLatin(uz), name_ru: ru });

export const DEPARTMENTS = [
  ['THER', 'Терапия бўлими', 'Терапевтическое отделение'],
  ['SURG', 'Жарроҳлик бўлими', 'Хирургическое отделение'],
  ['DIAG', 'Диагностика ва лаборатория', 'Диагностика и лаборатория']
] as const;

/** [department, full name (Cyrillic), specialty uz, specialty ru] — invented people. */
export const DOCTORS = [
  ['THER', 'Каримов Азиз Рустамович', 'Терапевт', 'Терапевт'],
  ['THER', 'Юсупова Нигора Баҳодировна', 'Кардиолог', 'Кардиолог'],
  ['THER', 'Тошматов Жасур Илҳомович', 'Невролог', 'Невролог'],
  ['THER', 'Раҳимова Дилноза Анваровна', 'Эндокринолог', 'Эндокринолог'],
  ['SURG', 'Холматов Шерзод Мирзаевич', 'Жарроҳ', 'Хирург'],
  ['SURG', 'Абдуллаева Мадина Шуҳратовна', 'Гинеколог', 'Гинеколог'],
  ['SURG', 'Назаров Отабек Ғайратович', 'Травматолог', 'Травматолог'],
  ['SURG', 'Эргашев Санжар Тўлқинович', 'ЛОР-шифокор', 'Оториноларинголог'],
  ['DIAG', 'Мирзаева Гулнора Акмаловна', 'УТТ шифокори', 'Врач УЗИ'],
  ['DIAG', 'Қодиров Бобур Фарҳодович', 'Рентгенолог', 'Рентгенолог']
] as const;

type Kind = 'consultation' | 'procedure' | 'lab' | 'diagnostic' | 'bed' | 'surgery' | 'medicine' | 'good' | 'caretaker' | 'other';
/** [code, kind, department, uz, ru, price UZS, doctor indexes who perform it]. 40 services. */
const GENERAL: [string, Kind, string, string, string, number, number[]][] = [
  ['C01', 'consultation', 'THER', 'Терапевт кўриги', 'Консультация терапевта', 100000, [0]],
  ['C02', 'consultation', 'THER', 'Кардиолог кўриги', 'Консультация кардиолога', 150000, [1]],
  ['C03', 'consultation', 'THER', 'Невролог кўриги', 'Консультация невролога', 150000, [2]],
  ['C04', 'consultation', 'THER', 'Эндокринолог кўриги', 'Консультация эндокринолога', 150000, [3]],
  ['C05', 'consultation', 'SURG', 'Жарроҳ кўриги', 'Консультация хирурга', 120000, [4]],
  ['C06', 'consultation', 'SURG', 'Гинеколог кўриги', 'Консультация гинеколога', 130000, [5]],
  ['C07', 'consultation', 'SURG', 'Травматолог кўриги', 'Консультация травматолога', 120000, [6]],
  ['C08', 'consultation', 'SURG', 'ЛОР кўриги', 'Консультация ЛОР-врача', 110000, [7]],
  ['C09', 'consultation', 'THER', 'Такрорий кўрик', 'Повторный приём', 60000, [0, 1, 2, 3]],
  ['C10', 'consultation', 'SURG', 'Такрорий жарроҳ кўриги', 'Повторный приём хирурга', 60000, [4, 5, 6, 7]],
  ['P01', 'procedure', 'THER', 'Томир ичига укол', 'Внутривенная инъекция', 25000, [0, 3]],
  ['P02', 'procedure', 'THER', 'Мушак ичига укол', 'Внутримышечная инъекция', 15000, [0, 3]],
  ['P03', 'procedure', 'THER', 'Томчи дори (капельница)', 'Капельница', 60000, [0, 1]],
  ['P04', 'procedure', 'SURG', 'Боғлов', 'Перевязка', 40000, [4, 6]],
  ['P05', 'procedure', 'SURG', 'Чок олиш', 'Снятие швов', 50000, [4, 6]],
  ['P06', 'procedure', 'SURG', 'Қулоқ ювиш', 'Промывание уха', 45000, [7]],
  ['P07', 'procedure', 'THER', 'Электрокардиограмма (ЭКГ)', 'Электрокардиограмма (ЭКГ)', 70000, [1]],
  ['D01', 'diagnostic', 'DIAG', 'Қорин бўшлиғи УТТ', 'УЗИ брюшной полости', 150000, [8]],
  ['D02', 'diagnostic', 'DIAG', 'Буйрак УТТ', 'УЗИ почек', 110000, [8]],
  ['D03', 'diagnostic', 'DIAG', 'Қалқонсимон без УТТ', 'УЗИ щитовидной железы', 100000, [8]],
  ['D04', 'diagnostic', 'DIAG', 'Юрак УТТ (ЭхоКГ)', 'ЭхоКГ', 200000, [8]],
  ['D05', 'diagnostic', 'DIAG', 'Кўкрак қафаси рентгени', 'Рентген грудной клетки', 90000, [9]],
  ['D06', 'diagnostic', 'DIAG', 'Умуртқа рентгени', 'Рентген позвоночника', 120000, [9]],
  ['B01', 'bed', 'THER', 'Умумий палата (1 кун)', 'Общая палата (сутки)', 200000, []],
  ['B02', 'bed', 'THER', 'Икки кишилик палата (1 кун)', 'Двухместная палата (сутки)', 350000, []],
  ['B03', 'bed', 'SURG', 'Люкс палата (1 кун)', 'Палата люкс (сутки)', 600000, []],
  ['S01', 'surgery', 'SURG', 'Аппендэктомия', 'Аппендэктомия', 4500000, [4]],
  ['S02', 'surgery', 'SURG', 'Грыжа операцияси', 'Грыжесечение', 5000000, [4]],
  ['S03', 'surgery', 'SURG', 'Бодомча безни олиб ташлаш', 'Тонзиллэктомия', 3500000, [7]],
  ['S04', 'surgery', 'SURG', 'Синиқни жойига солиш', 'Репозиция перелома', 2500000, [6]],
  ['G01', 'good', 'DIAG', 'Бир марталик шприц', 'Одноразовый шприц', 2000, []],
  ['G02', 'good', 'DIAG', 'Тиббий ниқоб', 'Медицинская маска', 1000, []],
  ['G03', 'good', 'SURG', 'Стерил боғлов тўплами', 'Стерильный перевязочный набор', 25000, []],
  ['K01', 'caretaker', 'THER', 'Қаровчи жойлашуви (1 кун)', 'Проживание ухаживающего (сутки)', 100000, []],
  ['K02', 'caretaker', 'THER', 'Қаровчи овқати (1 кун)', 'Питание ухаживающего (сутки)', 60000, []],
  ['O01', 'other', 'THER', 'Тиббий маълумотнома', 'Медицинская справка', 50000, [0]],
  ['O02', 'other', 'THER', 'Касаллик тарихидан кўчирма', 'Выписка из истории болезни', 30000, [0]],
  ['O03', 'other', 'DIAG', 'Натижани қайта чоп этиш', 'Повторная печать результата', 10000, []],
  ['O04', 'other', 'SURG', 'Операциядан олдинги маслаҳат', 'Предоперационная консультация', 100000, [4, 5, 6, 7]],
  ['O05', 'other', 'THER', 'Уйга чақирув', 'Вызов на дом', 200000, [0]]
];

/** [code, uz, ru, price]. 10 laboratory tests. */
const LAB: [string, string, string, number][] = [
  ['L01', 'Умумий қон таҳлили', 'Общий анализ крови', 45000],
  ['L02', 'Умумий сийдик таҳлили', 'Общий анализ мочи', 30000],
  ['L03', 'Қондаги қанд (глюкоза)', 'Глюкоза крови', 20000],
  ['L04', 'Гликирланган гемоглобин (HbA1c)', 'Гликированный гемоглобин (HbA1c)', 90000],
  ['L05', 'Биохимик таҳлил (АЛТ, АСТ)', 'Биохимия (АЛТ, АСТ)', 60000],
  ['L06', 'Креатинин', 'Креатинин', 30000],
  ['L07', 'Холестерин', 'Холестерин', 30000],
  ['L08', 'ТТГ гормони', 'Гормон ТТГ', 80000],
  ['L09', 'Коагулограмма', 'Коагулограмма', 70000],
  ['L10', 'Қон гуруҳи ва резус омил', 'Группа крови и резус-фактор', 40000]
];

/** [code, uz, ru, price, unit uz, opening stock, unit cost]. 15 medicines with stock. */
const MEDICINES: [string, string, string, number, string, number, number][] = [
  ['M01', 'Парацетамол 500 мг', 'Парацетамол 500 мг', 3000, 'таблетка', 500, 1500],
  ['M02', 'Ибупрофен 400 мг', 'Ибупрофен 400 мг', 4000, 'таблетка', 400, 2000],
  ['M03', 'Цефтриаксон 1 г', 'Цефтриаксон 1 г', 18000, 'флакон', 200, 11000],
  ['M04', 'Натрий хлорид 0,9% 200 мл', 'Натрия хлорид 0,9% 200 мл', 12000, 'флакон', 300, 7000],
  ['M05', 'Глюкоза 5% 200 мл', 'Глюкоза 5% 200 мл', 12000, 'флакон', 150, 7000],
  ['M06', 'Дротаверин 40 мг/2 мл', 'Дротаверин 40 мг/2 мл', 5000, 'ампула', 250, 2500],
  ['M07', 'Метамизол 50% 2 мл', 'Метамизол 50% 2 мл', 4000, 'ампула', 250, 2000],
  ['M08', 'Дексаметазон 4 мг', 'Дексаметазон 4 мг', 6000, 'ампула', 120, 3000],
  ['M09', 'Омепразол 20 мг', 'Омепразол 20 мг', 3500, 'капсула', 300, 1500],
  ['M10', 'Амоксициллин 500 мг', 'Амоксициллин 500 мг', 4500, 'капсула', 300, 2000],
  ['M11', 'Метформин 850 мг', 'Метформин 850 мг', 2500, 'таблетка', 400, 1000],
  ['M12', 'Эналаприл 10 мг', 'Эналаприл 10 мг', 1500, 'таблетка', 400, 600],
  ['M13', 'Лидокаин 2% 2 мл', 'Лидокаин 2% 2 мл', 5000, 'ампула', 200, 2500],
  ['M14', 'Гепарин 5000 ЕД', 'Гепарин 5000 ЕД', 35000, 'флакон', 60, 22000],
  ['M15', 'Фуросемид 1% 2 мл', 'Фуросемид 1% 2 мл', 4000, 'ампула', 150, 2000]
];

const ROOM_TYPES = [
  ['RT1', 'Умумий палата', 'Общая палата', 'B01', 4],
  ['RT2', 'Икки кишилик палата', 'Двухместная палата', 'B02', 2],
  ['RT3', 'Люкс палата', 'Палата люкс', 'B03', 1]
] as const;
/** [room name, department, room type code]. 8 rooms -> 4+4+4+2+2+2+1+1 = 20 beds. */
const ROOMS = [
  ['101', 'THER', 'RT1'], ['102', 'THER', 'RT1'], ['201', 'SURG', 'RT1'], ['103', 'THER', 'RT2'],
  ['104', 'THER', 'RT2'], ['202', 'SURG', 'RT2'], ['105', 'THER', 'RT3'], ['203', 'SURG', 'RT3']
] as const;

const DISTRICTS: [string, string, string, [string, string][]][] = [
  ['T01', 'Юнусобод тумани', 'Юнусабадский район', [['Боғишамол маҳалласи', 'махалля Богишамол'], ['Минор маҳалласи', 'махалля Минор']]],
  ['T02', 'Чилонзор тумани', 'Чиланзарский район', [['Қатортол маҳалласи', 'махалля Катартал'], ['Гулистон маҳалласи', 'махалля Гулистан']]],
  ['T03', 'Мирзо Улуғбек тумани', 'Мирзо-Улугбекский район', [['Олмазор маҳалласи', 'махалля Алмазар'], ['Ўзбекистон маҳалласи', 'махалля Узбекистан']]]
];

const EXPENSES = [
  ['E01', 'Хўжалик харажатлари', 'Хозяйственные расходы'], ['E02', 'Коммунал тўловлар', 'Коммунальные платежи'],
  ['E03', 'Таъмирлаш', 'Ремонт'], ['E04', 'Транспорт', 'Транспорт'], ['E05', 'Бошқа харажатлар', 'Прочие расходы']
] as const;

export type DemoCatalogResult = { departments: number; doctors: number; services: number; labTests: number; medicines: number; rooms: number; beds: number };

/**
 * Seeds the catalog shape into an existing clinic. `doctorIds` must be 10 accounts that are already
 * active members of the clinic with the doctor role; `actorId` is the CEO used for set_by/created_by.
 */
export async function seedDemoCatalog(tx: Tx, clinicId: string, actorId: string, doctorIds: string[]): Promise<DemoCatalogResult> {
  if (doctorIds.length !== DOCTORS.length) throw new Error(`Demo catalog needs ${DOCTORS.length} doctors`);
  const priceFrom = new Date('2026-01-01T00:00:00+05:00');
  const ins = (sql: string, values: unknown[]) => tx.query(sql, values);
  const dept: Record<string, string> = {};
  for (const [code, uz, ru] of DEPARTMENTS) {
    dept[code] = randomUUID();
    await ins('INSERT INTO departments(id,clinic_id,name_uz_cyrl,name_uz_latn,name_ru,code_1c) VALUES($1,$2,$3,$4,$5,$6)',
      [dept[code], clinicId, ...Object.values(names(uz, ru)), code]);
  }
  const groups: Record<string, string> = {};
  const group = async (department: string, kind: Kind) => {
    const key = `${department}:${kind}`;
    if (groups[key]) return groups[key];
    const label: Record<Kind, [string, string]> = {
      consultation: ['Кўриклар', 'Консультации'], procedure: ['Муолажалар', 'Процедуры'], lab: ['Лаборатория', 'Лаборатория'],
      diagnostic: ['Диагностика', 'Диагностика'], bed: ['Ётоқ кунлари', 'Койко-дни'], surgery: ['Операциялар', 'Операции'],
      medicine: ['Дори-дармонлар', 'Медикаменты'], good: ['Сарф материаллари', 'Расходные материалы'],
      caretaker: ['Қаровчилар', 'Ухаживающие'], other: ['Бошқа хизматлар', 'Прочие услуги']
    };
    const id = randomUUID(); groups[key] = id;
    await ins('INSERT INTO service_groups(id,clinic_id,department_id,name_uz_cyrl,name_uz_latn,name_ru,code_1c) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [id, clinicId, dept[department], ...Object.values(names(label[kind][0], label[kind][1])), `${department}-${kind}`]);
    return id;
  };
  const service: Record<string, string> = {};
  const addService = async (code: string, kind: Kind, department: string, uz: string, ru: string, price: number, unit = 'дона', trackStock = false) => {
    const id = randomUUID(); service[code] = id;
    await ins('INSERT INTO services(id,clinic_id,group_id,department_id,kind,name_uz_cyrl,name_uz_latn,name_ru,code_1c,unit,track_stock) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [id, clinicId, await group(department, kind), dept[department], kind, ...Object.values(names(uz, ru)), code, unit, trackStock]);
    await ins('INSERT INTO service_prices(id,clinic_id,service_id,price_uzs,effective_from,set_by) VALUES($1,$2,$3,$4,$5,$6)',
      [randomUUID(), clinicId, id, price, priceFrom, actorId]);
  };
  for (const [code, kind, department, uz, ru, price] of GENERAL) await addService(code, kind, department, uz, ru, price);
  for (const [code, uz, ru, price] of LAB) await addService(code, 'lab', 'DIAG', uz, ru, price);
  for (const [code, uz, ru, price, unit] of MEDICINES) await addService(code, 'medicine', 'DIAG', uz, ru, price, unit, true);

  for (const [i, [department, , specialtyUz, specialtyRu]] of DOCTORS.entries()) {
    const userId = doctorIds[i]!;
    await ins('INSERT INTO doctor_profiles(clinic_id,user_id,department_id,specialty_uz_cyrl,specialty_uz_latn,specialty_ru) VALUES($1,$2,$3,$4,$5,$6)',
      [clinicId, userId, dept[department], specialtyUz, toLatin(specialtyUz), specialtyRu]);
    for (const [code, , , , , , performers] of GENERAL) if (performers.includes(i))
      await ins('INSERT INTO doctor_services(clinic_id,user_id,service_id) VALUES($1,$2,$3)', [clinicId, userId, service[code]]);
    await ins(`INSERT INTO doctor_split_rules(id,clinic_id,user_id,doctor_share_bp,basis,discount_bearer,categories,effective_from,created_by)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), clinicId, userId, department === 'SURG' ? 4000 : 3000, i % 2 ? 'paid' : 'billed', 'clinic',
        department === 'SURG' ? ['consultation', 'procedure', 'surgery'] : ['consultation', 'procedure', 'diagnostic'], '2026-01-01', actorId]);
    await ins('INSERT INTO queue_points(id,clinic_id,kind,user_id,name_uz_cyrl,name_uz_latn,name_ru) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [randomUUID(), clinicId, 'doctor', userId, specialtyUz, toLatin(specialtyUz), specialtyRu]);
  }
  await ins('INSERT INTO queue_points(id,clinic_id,kind,service_group_id,name_uz_cyrl,name_uz_latn,name_ru) VALUES($1,$2,$3,$4,$5,$6,$7)',
    [randomUUID(), clinicId, 'service', await group('DIAG', 'lab'), ...Object.values(names('Лаборатория', 'Лаборатория'))]);

  const roomType: Record<string, string> = {};
  for (const [code, uz, ru] of ROOM_TYPES) {
    roomType[code] = randomUUID();
    await ins('INSERT INTO room_types(id,clinic_id,name_uz_cyrl,name_uz_latn,name_ru,code_1c) VALUES($1,$2,$3,$4,$5,$6)',
      [roomType[code], clinicId, ...Object.values(names(uz, ru)), code]);
  }
  let beds = 0;
  for (const [name, department, typeCode] of ROOMS) {
    const roomId = randomUUID(), type = ROOM_TYPES.find(t => t[0] === typeCode)!;
    await ins('INSERT INTO rooms(id,clinic_id,department_id,room_type_id,name) VALUES($1,$2,$3,$4,$5)', [roomId, clinicId, dept[department], roomType[typeCode], name]);
    for (let b = 1; b <= type[4]; b++, beds++)
      await ins('INSERT INTO beds(id,clinic_id,room_id,label,bed_service_id) VALUES($1,$2,$3,$4,$5)', [randomUUID(), clinicId, roomId, `${name}-${b}`, service[type[3]]]);
  }
  for (const [code, uz, ru, mahallas] of DISTRICTS) {
    const districtId = randomUUID();
    await ins('INSERT INTO districts(id,clinic_id,name_uz_cyrl,name_uz_latn,name_ru,code_1c) VALUES($1,$2,$3,$4,$5,$6)', [districtId, clinicId, ...Object.values(names(uz, ru)), code]);
    for (const [i, [mUz, mRu]] of mahallas.entries())
      await ins('INSERT INTO mahallas(id,clinic_id,district_id,name_uz_cyrl,name_uz_latn,name_ru,code_1c) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [randomUUID(), clinicId, districtId, ...Object.values(names(mUz, mRu)), `${code}-${i + 1}`]);
  }
  for (const [code, , , , , stock, cost] of MEDICINES)
    await ins(`INSERT INTO stock_movements(id,clinic_id,service_id,qty,reason,unit_cost_uzs,supplier,note,created_by) VALUES($1,$2,$3,$4,'receipt',$5,$6,$7,$8)`,
      [randomUUID(), clinicId, service[code], stock, cost, 'Синтетик таъминотчи', 'Демо бошланғич қолдиқ', actorId]);
  for (const [code, uz, ru] of EXPENSES)
    await ins('INSERT INTO expense_types(id,clinic_id,name_uz_cyrl,name_uz_latn,name_ru,code_1c) VALUES($1,$2,$3,$4,$5,$6)', [randomUUID(), clinicId, ...Object.values(names(uz, ru)), code]);
  for (const name of ['Касса 1', 'Касса 2'])
    await ins('INSERT INTO cash_desks(id,clinic_id,name) VALUES($1,$2,$3)', [randomUUID(), clinicId, name]);
  await ins(`UPDATE clinic_settings SET receipt_header=$2, updated_by=$3, updated_at=now() WHERE clinic_id=$1`,
    [clinicId, { name: 'Синтетик демо клиника', address: 'Тошкент ш., намуна кўчаси, 1 (сохта манзил)', phone: '+998000000000', taxId: 'DEMO' }, actorId]);
  return { departments: DEPARTMENTS.length, doctors: DOCTORS.length, services: GENERAL.length + LAB.length + MEDICINES.length,
    labTests: LAB.length, medicines: MEDICINES.length, rooms: ROOMS.length, beds };
}
