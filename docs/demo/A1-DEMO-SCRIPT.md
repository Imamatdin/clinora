# A1 doctor assistant: 2-minute demo script (for Mashxura)

President's Tech Award, 19 November 2026. Staging only, fictional patient only. Never use a real patient's name or voice recording of a real consultation.

## Before you go on stage (10 minutes earlier)

1. Staging is seeded with `npm run db:demo` (needs `ALLOW_SYNTHETIC_DEMO=true`, `DATABASE_URL`, `DEMO_PASSWORD`). Sign in as `demo.doctor`.
2. Open **Шифокор** → patient **Каримова Дилноза — синтетик бемор (демо)** → the visit dated today.
3. Check the banner at the top of the assistant panel:
   - no yellow banner = real speech recognition (Aisha) and real drafting (Gemini) are connected;
   - yellow **Симуляция режими** banner = keys are not connected; use the fallback path below and say so out loud.
4. Phone: Telegram linked to `demo.doctor` (staff invite: **PIN ва Telegram** or the administrator's invite; one link for sign-in and voice notes), test one voice message.
5. Keep the fallback recording (Mashxura reading the script below, recorded once on her phone) ready to play from a second phone next to the laptop microphone.

## On stage (about 2 minutes)

| Time | Say | Do |
| --- | --- | --- |
| 0:00 | "Шифокор беморга қарайди, клавиатурага эмас." | Show today's visit, patient history on the left (hypertension, penicillin allergy). |
| 0:10 | "Ёзишни бошлайман." | Tick the consent box, press **Ёзишни бошлаш**. The red dot and timer appear. |
| 0:15 | Read the consultation (below) with a colleague as the patient, about 40 seconds. | |
| 0:55 | "Тўхтатаман." | Press **Тўхтатиш ва юбориш**. Show the states: uploading → transcribing → drafting. |
| 1:10 | "Ҳар бир майдон манбаси билан." | Tap **Манба сўзлар** under Examination: the exact words appear. |
| 1:20 | "Шифокор ҳал қилади." | Edit Complaints in one sentence; accept the rest one by one; point out the yellow "Таклиф" chips turning green. |
| 1:40 | "Тасдиқлаганда ўзгармас версия бўлади." | Press **Тасдиқлаш ва тарихга сақлаш**, confirm, open **PDF**. |
| 1:50 | "Telegram орқали ҳам." | Show the bot message on the phone: a notice and a button, no patient data. |

## Consultation to read (fictional)

- Doctor: Ассалому алайкум, қандай шикоят билан келдингиз?
- Patient: Уч кундан бери бошим оғрияпти, томоғим оғрияпти, ҳароратим 38 гача кўтарилди. Кашель тоже есть, сухой, особенно ночью.
- Doctor: Аллергиянгиз борми? Илгари қандай касалликлар бўлган?
- Patient: Пенициллинга аллергия бор. Гипертония бор, эналаприл ичаман.
- Doctor: Кўрик: артериал босим 135 га 85, пульс 88, ҳарорат 37,8. Томоқ гиперемияланган, ўпкада везикуляр нафас, хириллаш йўқ.
- Doctor: Диагноз: ОРВИ, острый фарингит.
- Doctor: Тавсия: кўп суюқлик ичинг, парацетамол 500 мг ҳароратда, кунига 3 мартагача, уй режими.
- Doctor: Умумий қон таҳлили ва С-реактив оқсил топширинг. Беш кундан кейин қайта келинг.

## Fallback path (if the network or a provider fails)

1. If recording fails, the panel says so in words and the note can still be typed by hand: press **Таҳрирлаш** on each field. This is the honest "provider down" story: the clinic never stops.
2. If keys are not connected, press **Намойиш сценарийси (симуляция)**. The panel shows the yellow simulation banner the whole time. Say: "This run uses a prepared transcript, not live speech recognition."
3. Do not present simulated output as live recognition, and do not quote accuracy numbers that were not measured (see the handoff for the evaluation status).
