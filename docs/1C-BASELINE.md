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
| Справочник.Дорилар, Справочник.Товары | Medicines, goods | pharmacy stock (C10, to confirm) |
| Справочник.Каровчи, Справочник.Мумкун | Unknown | ask the clinic |
| Документ.КАБУЛ | Reception visit | visits and routing (C4) |
| Документ.ВрачКуриги | Doctor examination | encounters and notes (C6) |
| Документ.ЛАБАРАТОРИЯ / Лабаратория | Lab order and result | lab workspace (C6) |
| Документ.СТАЦИОНАР | Inpatient stay | admissions (C7) |
| Документ.ХИРУРГИЯ | Surgery (second dump only) | surgery charges (C10, to confirm) |
| Документ.КАССА_КИРИМИ / КАССА_ЧИКИМИ | Cash in / cash out | payments, expenses (C5) |
| Документ.Дори_ДармонПриходи | Medicine stock receipt | pharmacy stock (C10, to confirm) |
| РегистрНакопления.БЕМОР | Patient balance register | invoice balances (C2, C5) |
| Отчет.КассаКирими | Cash-in report | day close and cash report (C8) |
| Roles: КАССИР, Рахбар, ВРАЧЛАР, ЛАБАРАТОРИЯ, КАБУЛ | Cashier, head, doctors, lab, reception | membership roles (C1) |

## Consequences

- Service, department and doctor names need three fields: `name_uz_cyrl`, `name_uz_latn`, `name_ru`, plus the 1C code for traceability.
- Cash out (expenses) and cash shifts are part of today's cashier work and belong in C5.
- Pharmacy stock and surgery exist in the current system. Confirm with the CEO whether the first clinic needs them on day one (C10).
- The import feature the CEO asked for ("a clinic uploads its 1C data and the base builds itself") can read this configuration's `.dt` directly. Other clinics running different 1C configurations need their own mapping or an Excel export.
