# Gʻofurov klinikasi 1C baseline

Inspected 12 November 2026 by the planner. Source: two 1C infobase dumps (`.dt`) supplied by the clinic through the founders (one labelled 12.07, one "Клиника Гофуров"). The files are not in this repository and must never be committed: the patient catalog (БЕМОРЛАР) holds real patient records.

## What the dumps are

A custom 1C:Enterprise configuration (not a standard 1C medical product) that runs the first clinic today. It is the functional baseline for Clinora: the same workflow the CEO's spec describes. Object names are Uzbek in Cyrillic.

Format: 8-byte header `1CIBDmpF`, then a raw deflate stream (zlib, wbits -15, from byte 9). The inflated stream is 1C's tagged serialization with readable strings: UTF-16LE text, ASCII codes and numbers. Example service record: code `10902002002000003`, name in Uzbek Cyrillic, Uzbek Latin ("Nurlanish diagnostika Ultratovush tadqiqoti (UZI)") and Russian ("Лучевая диагностика Ультразвуковое исследование (УЗИ)"). Catalogs can be extracted offline without the 1C platform.

## Objects and Clinora mapping

| 1C object | Meaning | Clinora module |
| --- | --- | --- |
| Справочник.БЕМОРЛАР | Patients | patients (import only after founders define a real-data process) |
| Справочник.БУЛИМ | Departments | departments (C3) |
| Справочник.ВРАЧЛАР | Doctors | doctor profiles (C3) |
| Справочник.МИХИЛАР | Service groups by specialty ("Гастроэнтеролог Хизматлари") | service categories (C3) |
| Справочник.МУОЛАЖА | Procedures and services | services and prices (C3) |
| Справочник.Анализ, Справочник.ЛАБАРАТОРИЯ | Lab analyses | lab services (C3, C6) |
| Справочник.ХоналарТипи | Room types | rooms and beds (C7) |
| Справочник.Туман, Справочник.МФЙ | District, mahalla | patient address (C4) |
| Справочник.КАССА, Справочник.КАССА_СМЕНА | Cash desks, cash shifts | cashier shifts (C5) |
| Справочник.Расходлар | Expense types | cash out (C5) |
| Справочник.Дорилар, Справочник.Товары | Medicines, goods | pharmacy stock (C10) |
| Справочник.Каровчи | Caretaker: a person who stays with an inpatient (Imamatdin, 12 Nov) | admissions: caretakers per stay and any caretaker charges (C7) |
| Справочник.Мумкун | Literally "possible"; likely a lookup of allowed values or permissions. Builder inspects its records and reports | to decide after inspection |
| Документ.КАБУЛ | Reception visit | visits and routing (C4) |
| Документ.ВрачКуриги | Doctor examination | encounters and notes (C6) |
| Документ.ЛАБАРАТОРИЯ / Лабаратория | Lab order and result | lab workspace (C6) |
| Документ.СТАЦИОНАР | Inpatient stay | admissions (C7) |
| Документ.ХИРУРГИЯ | Surgery (second dump only) | surgery charges (C10) |
| Документ.КАССА_КИРИМИ / КАССА_ЧИКИМИ | Cash in / cash out | payments, expenses (C5) |
| Документ.Дори_ДармонПриходи | Medicine stock receipt | pharmacy stock (C10) |
| РегистрНакопления.БЕМОР | Patient balance register | invoice balances (C2, C5) |
| Отчет.КассаКирими | Cash-in report | day close and cash report (C8) |
| Roles: КАССИР, Рахбар, ВРАЧЛАР, ЛАБАРАТОРИЯ, КАБУЛ | Cashier, head, doctors, lab, reception | membership roles (C1) |

## Consequences

- Service, department and doctor names need three fields: `name_uz_cyrl`, `name_uz_latn`, `name_ru`, plus the 1C code for traceability.
- Cash out (expenses) and cash shifts are part of today's cashier work and belong in C5.
- Pharmacy stock and surgery exist in the current system and are needed on day one (decided 12 Nov), so C10 is in the go-live scope.
- The import feature the CEO asked for ("a clinic uploads its 1C data and the base builds itself") can read this configuration's `.dt` directly. Other clinics running different 1C configurations need their own mapping or an Excel export.

## Inner format (verified on both real dumps, 12 November 2026)

Fully decoded by the planner; reference implementation: `scripts/reference/dt_reference.py` (run it on a real file for a safe summary). Both real files parse end to end with no unknown tags.

- File: `1CIBDmpF`, version byte `3`, raw deflate (wbits -15) from byte 9.
- Stream: binary form of 1C bracket notation. Each byte carries flags 0x20 close-list, 0x80 comma, 0x40 open-list (applied in that order) and a base tag (`byte & 0x1F`): 0x01-0x0A digits, 0x0B u8, 0x0D u16 LE, 0x0F u32 LE, 0x11 i64, 0x15 GUID(16), 0x17 UTF-16LE string with 1-byte char count (0x18 2-byte, 0x19 8-byte), 0x1A bytes/ASCII with 1-byte length (0x1B, 0x1C), 0x16 no-quote flag, 0x0C/0x0E/0x10 negatives. Source of the tag table: Infostart article "Формат файлов выгрузки DT" (infostart.ru/1c/articles/1865138).
- Top level: `CompatibilityMode`, flags, folders `Config` (282 metadata files, deflated bracket text, named by metadata UUID), `Params` (includes `DBNames`), `Files`, `Users`, `DataBase`.
- `Params/DBNames` (deflated text): `{uuid,"Reference",45}`, `{uuid,"Fld",54}`... maps metadata UUIDs to physical tables and fields. Config file `<uuid>` of a catalog holds its name as `{0,0,<uuid>},"МУОЛАЖА"` and attributes as `<attr-uuid>},"НАРХИ",{1,"ru",...`.
- `DataBase[0]` = schema (table descriptors: name, type, number, parent, fields with type code/length, subtables, indexes). Data lists follow in schema order, each table followed by its subtables. A row is a flat list of `flag, value` pairs (flag 1 = value, 0 = NULL); `V` (record version) fields are not stored. `Folder` = 0 marks a group row.

### Catalog mapping (Gʻofurov klinikasi configuration)

| 1C object | Table | Rows (12.07 / Гофуров) | Fields to import |
| --- | --- | --- | --- |
| МУОЛАЖА (services) | Reference45 | 56 / 52 | Description = name, Fld54 НАРХИ = price UZS, Fld55 БУЛИМ = department ref, Fld86 МИХИ = MXIK code, Fld221 УлБир = unit code |
| Анализ (lab tests) | Reference297 | 96 (77 items) / 63 (46) | Description = name (groups have Folder 0), Fld317 Цена = price, Fld316 Норма = reference range, Fld328 МИХИ |
| БУЛИМ (departments) | Reference40 | 9 / 7 | Description, Fld43 ВРАЧЛАР |
| ВРАЧЛАР (doctors) | Reference31 | 15 / 13 | Description = name; Fld32 Кабул, Fld33 Стационар, Fld35 Лабаратория, Fld36 УЗИ = role flags. Never import Fld340 ПАРОЛ or Fld357 Телефон |
| МИХИЛАР (MXIK tax classifier, not specialty groups) | Reference44 | 156 / 156 | Description = MXIK code, Fld50/51/52 names uz-Cyrl/uz-Latn/ru, Fld53 unit code |
| ХоналарТипи (room types) | Reference247 | 3 / 3 | Description, Fld248 КунликЁтокПули = daily bed price |
| Туман, МФЙ | Reference295/296 | 31, 5 / 26, 5 | Description |
| Дорилар (medicines) | Reference198 | 5 / 0 | Description, Fld358 Овкат |
| Товары (goods) | Reference266 | 0 / 0 | Fld280 СотувНархи sale price, Fld291 КиримНархи purchase price |
| Расходлар (expense types) | Reference333 | 1 / 1 | Description |
| Мумкун | Reference341 | 5 / 5 | Description only (a short list, likely permission or option names) |
| БЕМОРЛАР, Каровчи | Reference46/245 | 210, 3 / 86, 3 | never decoded or imported |

### Compliance flag found in the dump

The configuration stores MXIK (ИКПУ) codes on every service and has ОнлайнКасса and Инкасса catalogs with Z-report numbers. The clinic issues fiscal receipts through an online cash register today. Clinora's cashier prints non-fiscal receipts. Before go-live: ask the clinic which fiscal device or virtual cash register they use, and keep it running alongside Clinora (or integrate it as a follow-up task). Services must carry their MXIK code.
