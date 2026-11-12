export const inpatient = {
  'inpatient.title':'Стационар — палаталар', 'inpatient.admit':'Беморни ётқизиш', 'inpatient.visit':'Бемор ташрифи',
  'inpatient.department':'Бўлим', 'inpatient.doctor':'Даволовчи шифокор', 'inpatient.bed':'Бўш ўрин', 'inpatient.expected':'Кутилаётган чиқиш санаси',
  'inpatient.choose':'Танланг', 'inpatient.free':'Бўш', 'inpatient.occupied':'Банд', 'inpatient.room':'Палата',
  'inpatient.daily':'Кунлик тўловларни ҳисоблаш', 'inpatient.through':'Қайси санагача (кечаги кунгача)',
  'inpatient.dailyHelp':'Фақат тугаган кунлар ҳисобланади. Кўчирилган куни биринчи ўрин нархи олинади. Бугунги тўлов чиқаришда ҳисобланади.',
  'inpatient.refresh':'Янгилаш', 'inpatient.loading':'Юкланмоқда…', 'inpatient.empty':'Ҳозирча беморлар йўқ',
  'inpatient.saved':'Сақланди', 'inpatient.saving':'Сақланмоқда…', 'inpatient.select':'Беморни очиш', 'inpatient.transfer':'Бошқа ўринга кўчириш',
  'inpatient.service':'Хизмат ёки дори', 'inpatient.quantity':'Миқдор', 'inpatient.addService':'Хизматни қўшиш',
  'inpatient.medicineHelp':'Дори учун фақат тўлов ёзилади. Омбордан чиқариш ҳали уланмаган.',
  'inpatient.caretaker':'Қаровчи', 'inpatient.name':'Қаровчининг тўлиқ исми', 'inpatient.phone':'Телефон (+998…)',
  'inpatient.dailyService':'Қаровчи учун кунлик хизмат (ихтиёрий)', 'inpatient.noCharge':'Тўловсиз', 'inpatient.addCaretaker':'Қаровчини қўшиш',
  'inpatient.discharge':'Беморни чиқариш', 'inpatient.confirmDischarge':'Якуний ҳисобни текширинг. Чиқариш ўринни бўшатади ва янги хизмат қўшишни тўхтатади.',
  'inpatient.confirm':'Чиқаришни тасдиқлаш', 'inpatient.cancel':'Бекор қилиш', 'inpatient.invoice':'Стационар якуний ҳисоби',
  'inpatient.print':'А4 PDFни очиш ва чоп этиш', 'inpatient.value':'Хизматлар қиймати', 'inpatient.discount':'Чегирма',
  'inpatient.payable':'Тўланиши керак', 'inpatient.paid':'Тўланган', 'inpatient.due':'Қарз', 'inpatient.uzs':'сўм',
  'inpatient.rule':'Ўрин куни қоидаси (ўзгариш эртадан)', 'inpatient.admissionDay':'Келган кун ҳисобланади',
  'inpatient.dischargeDay':'Чиққан кун ҳисобланади', 'inpatient.minimum':'Энг кам кун', 'inpatient.saveRule':'Қоидани сақлаш',
  'inpatient.admitted':'Ётқизилган', 'inpatient.discharged':'Чиқарилган', 'inpatient.allPatients':'Барча беморлар', 'inpatient.myPatients':'Менинг беморларим',
  'inpatient.language':'Тил', 'inpatient.ruleNotice':'Янги қоида эртадан амал қилади', 'inpatient.printHelp':'PDF очилди. Чоп этишни PDF кўрувчисидан танланг.'
} as const;
export type InpatientKey=keyof typeof inpatient;
