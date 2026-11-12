/*
 * Text the bot sends, in the three product languages. Staff names appear only in the
 * link confirmation (so the person can recognise their own account); never patient data.
 */

export const BOT_LOCALES = ['uz-Cyrl', 'uz-Latn', 'ru'] as const;
export type BotLocale = (typeof BOT_LOCALES)[number];

/** Telegram's language_code is a hint only. The clinic default (Uzbek Cyrillic) applies otherwise. */
export function botLocale(languageCode: string | null | undefined): BotLocale {
  return languageCode?.toLowerCase().startsWith('ru') ? 'ru' : 'uz-Cyrl';
}

const uzCyrl = {
  open: 'Clinora тизимини очиш',
  startInvalid: 'Бу таклиф ҳаволаси яроқсиз, ишлатилган ёки муддати ўтган. Администратордан янги ҳавола сўранг.',
  confirmQuestion: 'Сиз {name}мисиз ({clinic})? Тасдиқласангиз, ушбу Telegram ҳисоби Clinora тизимига боғланади.',
  confirmYes: 'Ҳа, бу менман',
  confirmNo: 'Йўқ, бу мен эмас',
  declined: 'Боғланмади. Ҳавола сизга тегишли бўлмаса, администраторга хабар беринг.',
  linked: 'Тайёр. Clinora тизимини очиш учун пастдаги тугмани босинг.',
  notLinked: 'Бу Telegram ҳисоби Clinora тизимига боғланмаган. Администратордан таклиф ҳаволасини сўранг.',
  welcomeBack: 'Clinora тизимини очиш учун пастдаги тугмани босинг.',
  telegramTaken: 'Бу Telegram ҳисоби бошқа ходимга боғланган. Администраторга мурожаат қилинг.'
};
type BotText = Record<keyof typeof uzCyrl, string>;
const uzLatn: BotText = {
  open: 'Clinora tizimini ochish',
  startInvalid: 'Bu taklif havolasi yaroqsiz, ishlatilgan yoki muddati oʻtgan. Administratordan yangi havola soʻrang.',
  confirmQuestion: 'Siz {name}misiz ({clinic})? Tasdiqlasangiz, ushbu Telegram hisobi Clinora tizimiga bogʻlanadi.',
  confirmYes: 'Ha, bu menman',
  confirmNo: 'Yoʻq, bu men emas',
  declined: 'Bogʻlanmadi. Havola sizga tegishli boʻlmasa, administratorga xabar bering.',
  linked: 'Tayyor. Clinora tizimini ochish uchun pastdagi tugmani bosing.',
  notLinked: 'Bu Telegram hisobi Clinora tizimiga bogʻlanmagan. Administratordan taklif havolasini soʻrang.',
  welcomeBack: 'Clinora tizimini ochish uchun pastdagi tugmani bosing.',
  telegramTaken: 'Bu Telegram hisobi boshqa xodimga bogʻlangan. Administratorga murojaat qiling.'
};
const ru: BotText = {
  open: 'Открыть Clinora',
  startInvalid: 'Ссылка-приглашение недействительна, уже использована или устарела. Попросите администратора выдать новую.',
  confirmQuestion: 'Вы — {name} ({clinic})? После подтверждения этот аккаунт Telegram будет привязан к Clinora.',
  confirmYes: 'Да, это я',
  confirmNo: 'Нет, это не я',
  declined: 'Привязка отменена. Если ссылка не ваша, сообщите администратору.',
  linked: 'Готово. Нажмите кнопку ниже, чтобы открыть Clinora.',
  notLinked: 'Этот аккаунт Telegram не привязан к Clinora. Попросите у администратора ссылку-приглашение.',
  welcomeBack: 'Нажмите кнопку ниже, чтобы открыть Clinora.',
  telegramTaken: 'Этот аккаунт Telegram привязан к другому сотруднику. Обратитесь к администратору.'
};
export const BOT_TEXT: Record<BotLocale, BotText> = { 'uz-Cyrl': uzCyrl, 'uz-Latn': uzLatn, ru };

export function botText(locale: BotLocale, key: keyof BotText, vars: Record<string, string> = {}): string {
  return BOT_TEXT[locale][key].replace(/\{(\w+)\}/g, (match, name: string) => vars[name] ?? match);
}
