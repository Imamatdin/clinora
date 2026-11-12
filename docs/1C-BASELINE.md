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

## Inner format (observed on the real dumps, 12 November 2026)

Task 005's reader assumed a text bracket layout and stops with `UNRECOGNIZED_LAYOUT` on both real files (inflated sizes 4.58 MB and 3.83 MB, dump version "3"). What the planner observed by inspecting the real files (structure only):

- The inflated stream is a binary tagged serialization of the infobase's physical tables, not the configuration's object names. Tables are 1C's physical tables: `ReferenceNN` (catalogs), `DocumentNN` and `DocumentNN_VTxx` (documents and their table parts), `AccumRgNN`, `InfoRgNN`, `EnumNN`, plus system tables (`Params`, `Config`, `DBNames` mapping).
- Table definitions come first (offsets up to about 3.14 MB in the 12.07 file): each field as a name token followed by a type letter and size, for example `ID` R (reference, 16 bytes), `Version`, `Marked` L (boolean), `PredefinedID`, `ParentID` R, `Folder` L, `Code` N or S, `Description` S(150), then configuration fields `Fld50`, `Fld51`... Indexes follow (`ByParentCode`, `ByDescr`, ...). Observed type letters after tag `0xcb`: `N` number, `S` string, `R` reference, `L` boolean, `B` binary, `V` version, `D`/`T` dates likely.
- Row data follows. Value tags observed: `0x82` field separator; `0x9a <len>` short ASCII/binary string (length byte), used for codes and Latin names; `0x97 <len>` UTF-16LE string with a character count, used for Cyrillic and Russian names; `0xe2` followed by 16 bytes, a reference (GUID-like); `0x8b <n>` small integer; `0x8f` numeric with length (likely decimals such as prices); `0xfa`/`0xda <len>` name tokens in definitions; `0xa1`/`0xa2`/`0x81` flags.
- A service row looks like: record number string, reference id, parent reference (16 zero bytes when empty), flags, small integer, `Code` (for example `10902002002000003`), name in Uzbek Cyrillic (UTF-16), name in Uzbek Latin (ASCII here), name in Russian (UTF-16).
- Mapping from configuration objects (Справочник.МУОЛАЖА and so on) to `ReferenceNN` lives in the `DBNames` data (metadata UUID to table number); the configuration object names appear as UTF-16 strings in the metadata region together with their UUIDs. Prices are most likely in `FldNN` numeric fields of МУОЛАЖА/Анализ or in an information register; to be confirmed.

Task 018 implements the real reader against these findings. The planner runs every candidate reader on the real files locally and reports counts and samples (no patient data) back to the builder, because the real files never leave Imamatdin's machine and the planner's workspace.
