/**
 * Fixed synthetic evaluation set for slice A1: 10 short fictional GP consultations (Uzbek, Russian, mixed),
 * to be read aloud by two real people on a phone microphone. Each case lists the medical terms whose
 * recognition is scored and the form fields a correct draft must contain. Includes a negation, a
 * correction, numbers, an examination not done and code-switching. Not clinical validation.
 */
export type EvalCase = { id: string; language: 'uz' | 'ru' | 'mixed'; lines: [speaker: 'D' | 'P', text: string][]; terms: string[]; fields: string[] };
export const EVAL_SET: EvalCase[] = [
  { id: 'E01', language: 'uz', terms: ['ҳарорат', 'йўтал', 'парацетамол'], fields: ['complaints', 'hpi', 'diagnosis', 'plan'], lines: [
    ['D', 'Нима безовта қиляпти?'], ['P', 'Икки кундан бери ҳароратим 38, йўтал бор.'], ['D', 'Диагноз: ўткир респиратор инфекция.'], ['D', 'Парацетамол 500 миллиграмм, кунига уч марта.']] },
  { id: 'E02', language: 'ru', terms: ['давление', 'эналаприл', 'гипертония'], fields: ['complaints', 'pastHistory', 'examination', 'diagnosis', 'plan'], lines: [
    ['D', 'На что жалуетесь?'], ['P', 'Голова болит по утрам, давление поднимается.'], ['P', 'Гипертония пять лет, пью эналаприл.'], ['D', 'Давление сто шестьдесят на сто.'], ['D', 'Диагноз: гипертоническая болезнь. Увеличим эналаприл до двадцати миллиграмм.']] },
  { id: 'E03', language: 'mixed', terms: ['аллергия', 'пенициллин', 'фарингит'], fields: ['complaints', 'pastHistory', 'diagnosis', 'labOrders'], lines: [
    ['P', 'Томоғим оғрияпти, глотать больно.'], ['D', 'Аллергия борми?'], ['P', 'Пенициллинга аллергия бор.'], ['D', 'Острый фарингит. Умумий қон таҳлили топширинг.']] },
  { id: 'E04', language: 'uz', terms: ['кўкрак', 'ЭКГ', 'юрак'], fields: ['complaints', 'examination', 'plan'], lines: [
    ['P', 'Юрганда кўкрагим сиқилади.'], ['D', 'Юрак уриши 92, тўғри ритм.'], ['D', 'ЭКГ ва кардиолог маслаҳати керак.']] },
  { id: 'E05', language: 'ru', terms: ['глюкоза', 'гликированный', 'жажда'], fields: ['complaints', 'labOrders', 'followUp'], lines: [
    ['P', 'Постоянная жажда, часто хожу в туалет.'], ['D', 'Сдайте глюкозу крови и гликированный гемоглобин.'], ['D', 'Придите через семь дней с результатами.']] },
  { id: 'E06', language: 'mixed', terms: ['температура', 'хириллаш', 'ўпка'], fields: ['complaints', 'examination'], lines: [
    ['P', 'Температура йўқ, лекин ҳолсизман.'], ['D', 'Ўпкада хириллаш йўқ.'], ['D', 'Нет, подождите, справа внизу есть хрипы.']] },
  { id: 'E07', language: 'uz', terms: ['қорин', 'кўнгил айниши'], fields: ['complaints', 'examination'], lines: [
    ['P', 'Қорним оғрияпти, кўнгил айнияпти.'], ['D', 'Бугун қоринни кўрмадим, кўрик ўтказилмади.']] },
  { id: 'E08', language: 'ru', terms: ['креатинин', 'отёки', 'мочи'], fields: ['complaints', 'labOrders'], lines: [
    ['P', 'Отёки на ногах к вечеру.'], ['D', 'Креатинин и общий анализ мочи.']] },
  { id: 'E09', language: 'mixed', terms: ['щитовидка', 'ТТГ', 'ҳолсизлик'], fields: ['complaints', 'labOrders', 'followUp'], lines: [
    ['P', 'Доим ҳолсизлик, сочларим тўкиляпти.'], ['D', 'Щитовидкани текширамиз, ТТГ топширинг.'], ['D', 'Икки ҳафтадан кейин қайта келинг.']] },
  { id: 'E10', language: 'uz', terms: ['бош айланиши', 'гемоглобин', 'ферритин'], fields: ['complaints', 'labOrders', 'plan'], lines: [
    ['P', 'Бошим айланади, тез чарчайман.'], ['D', 'Гемоглобин ва ферритинни текширамиз.'], ['D', 'Темирга бой овқат, кўпроқ дам олинг.']] }
];
