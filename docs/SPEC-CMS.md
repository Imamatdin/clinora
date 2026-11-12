# Clinic Management System specification (from the CEO, 12 Nov 2026)

Source: Mashxuraxon Mamatxalilova, Clinora CEO, sent to Imamatdin on 12 November 2026. Kept verbatim below the additions. Additions from the same conversation come first and take precedence where they are more specific.

## Additions from the CEO conversation

- Each doctor has an individual account and sees only their own patients. Full-clinic data export is available only to the clinic CEO.
- The CEO sees in real time what happens at the laboratory, cashier, registration and each doctor; sets and calculates staff pay; manages each doctor in the system, including per-doctor revenue splits (examples given: 50/50 with one doctor, 80/20 with another); and sees each doctor's productivity. Split percentages and rules are configured per clinic and per doctor, not hardcoded.
- At the end of each day the cashier prints a cash report and brings it to the CEO together with the cash.
- UI language: Uzbek in Cyrillic script.
- Must be simple: few buttons, minimal typing, works on phone and computer. Install from the browser to the home screen or desktop (PWA), so staff do not sign in through Google every time.
- Prescription sheet (retsept varaqasi) can be downloaded as PDF and printed.
- Clinic reference data (services, laboratory tests, doctors) comes from the clinic's existing 1C database. Any new clinic should be able to upload its 1C data so its database is built automatically.
- First clinic: about 150 outpatients and 20+ inpatients per day. Handoff target: 19 November 2026, when the clinic is expected to start paying.
- Later: a patient app for inpatients showing services used and their prices each day.

## Original specification

Clinic Management System — Product Requirements & Development Specification

1. Project Overview

Develop a comprehensive Clinic Management System (CMS) that digitizes and automates the daily operations of a medical clinic.

The system must manage the complete patient journey, starting from patient registration and appointment/queue management to medical services, laboratory procedures, inpatient management, payments, receipt generation, and financial reporting.

The platform should be modular, user-friendly, scalable, and suitable for real-world clinic operations.

The primary objective is to minimize manual administrative work, improve operational transparency, and provide clinic management with accurate real-time financial and operational data.

---

2. User Roles and Access Permissions

The system must support role-based access control (RBAC).

Required user roles:

1. CEO / Clinic Owner
   
   - Access to all financial and operational dashboards.
   - View daily, weekly, monthly, and yearly reports.
   - Monitor patient statistics, revenue, discounts, and outstanding balances.
   - View performance by doctor, department, and laboratory.

2. Administrator
   
   - Manage daily clinic operations.
   - Open and close business days.
   - Manage employees, doctors, services, and departments.
   - Monitor patient queues.

3. Receptionist / Registrar
   
   - Register new patients.
   - Search existing patients.
   - Create patient visits.
   - Select outpatient or inpatient services.
   - Assign doctors and generate queue numbers.

4. Doctor
   
   - View assigned patients.
   - View patient information and visit history.
   - Update consultation status.
   - Record completed medical services.

5. Laboratory Staff
   
   - Access laboratory orders.
   - Select and confirm completed tests.
   - Update laboratory service statuses.
   - Submit service charges to the patient's account.

6. Cashier
   
   - View patient invoices.
   - Process payments.
   - Apply authorized discounts.
   - Manage outstanding balances.
   - Print receipts.

7. Inpatient Department Staff
   
   - Manage admitted patients.
   - Assign beds and rooms.
   - Record daily bed charges.
   - Add additional services and expenses.
   - Track inpatient billing.

Each role must have configurable permissions. Users must only access the modules and actions authorized for their role.

---

3. Patient Registration Module

When a patient arrives at the clinic, the receptionist must register the patient in the system.

Required patient information:

- Full name
- Date of birth
- Automatically calculated age
- Gender
- Phone number
- Residential region, district, and address
- Patient acquisition source (referral, advertisement, walk-in, etc.)
- Registration date
- Unique patient ID

Functional requirements:

- Generate a unique patient ID automatically.
- Search existing patients by name, phone number, or patient ID.
- Prevent unnecessary duplicate patient registrations.
- Maintain complete patient visit history.
- Allow existing patients to create new visits without registering again.
- Store all patient data securely.

---

4. Daily Shift and Business Day Management

The clinic must operate through a daily business-day management system.

Requirements:

- Automatically detect the current date.
- Allow authorized administrators to open a new business day.
- Reset daily queue counters.
- Activate available doctors, departments, laboratories, and services.
- Associate all transactions and patient visits with the correct business date.
- Allow administrators to close the business day.
- Generate a daily financial summary when the day is closed.

Historical data must never be deleted or overwritten when a new business day starts.

---

5. Queue Management System

After patient registration, the receptionist selects the required doctors and medical services.

The system must automatically generate separate queue numbers for each doctor or service.

Example:

A patient requires:

- Cardiologist — Queue No. 1
- Neurologist — Queue No. 4
- Laboratory — Queue No. 12
- Ultrasound — Queue No. 7

Functional requirements:

- Automatically assign queue numbers.
- Maintain independent queues for each doctor and department.
- Display queue numbers and patient statuses.
- Support multiple doctor assignments for one patient visit.
- Print queue tickets.
- Track queue statuses:
  - Waiting
  - In Progress
  - Completed
  - Cancelled
- Allow authorized staff to manage queues.

The queue system must prevent duplicate queue assignments within the same doctor/service and business day.

---

6. Outpatient Management (Ambulatory Patients)

Outpatient patients visit the clinic for consultations and medical services without being admitted to an inpatient bed.

Workflow:

1. Register or identify the patient.
2. Create a new outpatient visit.
3. Select required doctors.
4. Automatically generate queue numbers.
5. Add consultations and medical services.
6. Calculate service charges.
7. Apply discounts if authorized.
8. Process payments or record outstanding balances.
9. Generate a receipt.
10. Save the visit in the patient's history.

A single outpatient visit may include multiple doctors, laboratory tests, and additional medical services.

All services must be associated with the same visit and patient account.

---

7. Inpatient Management (Hospitalization)

The system must support patients admitted to the clinic for inpatient treatment.

Patient admission information:

- Patient ID
- Admission date and time
- Department
- Room number
- Bed number
- Daily bed price
- Expected discharge date
- Actual discharge date
- Assigned medical staff

Billing management:

The system must automatically calculate inpatient expenses.

Required billing components:

- Daily bed charges
- Laboratory tests
- Doctor consultations
- Medical procedures
- Additional services
- Other authorized expenses

Example:

Service| Amount
Bed charge (5 days)| 500,000 UZS
Laboratory tests| 250,000 UZS
Ultrasound| 150,000 UZS
Additional services| 100,000 UZS
Total| 1,000,000 UZS

The system must:

- Calculate the total number of billable bed days.
- Automatically calculate bed charges.
- Allow authorized staff to add additional services.
- Update the patient's total account in real time.
- Track payments and outstanding balances.
- Generate a final invoice upon discharge.

Bed-day calculation rules, including admission and discharge day handling, must be configurable by the clinic.

---

8. Laboratory Management Module

The clinic must have a separate laboratory interface/account.

Laboratory employees must be able to access assigned patient orders and record completed procedures.

Workflow:

1. Laboratory staff logs into the laboratory account.
2. Selects a patient or laboratory order.
3. Views requested tests.
4. Confirms completed tests.
5. The system retrieves the configured service prices.
6. Completed service charges are automatically added to the patient's account.
7. The cashier can view the updated charges.

Requirements:

- Maintain a laboratory service catalog.
- Configure prices for each laboratory test.
- Track test statuses.
- Associate each test with a patient and visit.
- Prevent duplicate billing for the same completed service.
- Maintain laboratory service history.
- Support laboratory-specific reports.

Laboratory staff must not have permission to modify payments or financial records unless explicitly authorized.

---

9. Service and Pricing Management

The administrator must be able to manage the clinic's complete service catalog.

Service categories:

- Doctor consultations
- Laboratory tests
- Diagnostic procedures
- Ultrasound
- Inpatient services
- Bed charges
- Additional medical services

Requirements:

- Create, edit, and deactivate services.
- Assign services to departments.
- Set individual service prices.
- Assign services to doctors or laboratories.
- Maintain price history.
- Allow authorized price updates.

All patient charges must use the price applicable at the time the service was recorded.

---

10. Cash Management and Payment Processing

The cash management module must consolidate all patient charges.

Cashier functionality:

- Search patients by patient ID or name.
- View all services associated with a patient visit.
- View service prices and totals.
- Apply authorized discounts.
- Accept cash and card payments.
- Support partial payments.
- Calculate outstanding balances.
- Generate payment receipts.
- Maintain complete transaction history.

Payment statuses:

- Unpaid
- Partially Paid
- Paid
- Refunded
- Cancelled

The system must distinguish between:

- Total service value
- Discount amount
- Actual amount payable
- Amount paid
- Remaining balance

Revenue reports must be based on actual payments received, not simply the total value of services performed.

---

11. Discount Management

The system must support flexible discount management.

Discount types:

- Percentage discounts (5%, 10%, 50%, 100%).
- Fixed-amount discounts.
- Special discounts for selected patients.
- Promotional discounts.

Important business rule:

Even if a patient receives a 100% discount, their registration and all consumed services must still be recorded.

For example:

Item| Amount
Original service price| 500,000 UZS
Discount| 100%
Final payable amount| 0 UZS

Security requirements:

- Only authorized users can approve discounts.
- Record who applied the discount.
- Require a discount reason.
- Maintain an audit log.
- Prevent unauthorized changes to historical discounts.

---

12. Receipt and Printing Module

The system must support physical receipt printing through thermal receipt printers.

Receipt information:

- Clinic name and details
- Receipt number
- Patient name
- Patient ID
- Date and time
- Service names
- Individual service prices
- Total amount
- Discount amount
- Amount paid
- Outstanding balance
- Payment method

Requirements:

- Support standard thermal printers.
- Generate printable receipts.
- Allow receipt reprinting with proper authorization.
- Maintain receipt history.
- Support individual service receipts and consolidated invoices.

The printing workflow must work with the clinic's existing computers and printer hardware.

---

13. CEO Dashboard and Financial Reporting

The CEO must have a centralized dashboard providing real-time operational and financial visibility.

Patient statistics:

- Total daily patients
- Outpatient patients
- Inpatient patients
- New patients
- Returning patients
- Patient statistics by doctor
- Patient statistics by department
- Patient acquisition sources

Financial analytics:

- Total service value
- Actual collected revenue
- Cash payments
- Card payments
- Discounts
- Outstanding balances
- Refunds
- Revenue by doctor
- Revenue by department
- Laboratory revenue
- Inpatient revenue

Example dashboard:

Metric| Example
Total patients| 120
Outpatients| 100
Inpatients| 20
Total collected revenue| 15,000,000 UZS
Discounts| 1,000,000 UZS
Outstanding balances| 500,000 UZS

These numbers are illustrative. All dashboard values must be calculated dynamically from actual system records.

Reporting functionality:

- Daily reports
- Weekly reports
- Monthly reports
- Annual reports
- Doctor performance reports
- Laboratory reports
- Patient billing reports
- Inpatient final billing reports
- Discount reports
- Cashier transaction reports

Allow exporting reports in PDF and Excel formats.

---

14. Complete Patient Workflow

The entire system must support the following workflow:

Step 1 — Patient Arrival

- Patient arrives at the clinic.

Step 2 — Registration

- Receptionist registers the patient or finds an existing patient record.

Step 3 — Patient Type

- Select outpatient or inpatient.

Step 4 — Medical Routing

- Assign doctors, laboratories, and other services.
- Automatically generate queue numbers.

Step 5 — Service Delivery

- Doctors provide consultations.
- Laboratories perform requested tests.
- Additional medical services are recorded.

Step 6 — Automatic Billing

- All completed services are added to the patient's account.
- Bed charges are calculated for inpatient patients.

Step 7 — Payment

- Cashier reviews charges.
- Applies authorized discounts.
- Processes payments or records outstanding balances.

Step 8 — Receipt

- Generate and print receipts.

Step 9 — Reporting

- All patient and financial transactions become available in the CEO dashboard.

---

15. Database Architecture Requirements

The database must be relational and normalized.

Suggested core entities:

- Users
- Roles
- Permissions
- Patients
- PatientVisits
- Departments
- Doctors
- Services
- ServiceCategories
- DoctorAssignments
- Queues
- QueueTickets
- LaboratoryOrders
- LaboratoryTests
- InpatientAdmissions
- Rooms
- Beds
- BedAssignments
- PatientInvoices
- InvoiceItems
- Payments
- Discounts
- Receipts
- BusinessDays
- AuditLogs

Important architecture principles:

1. One patient can have multiple visits.
2. One visit can include multiple doctors and services.
3. Each service must be linked to the correct patient visit.
4. All financial transactions must be traceable.
5. Patient registration, medical services, invoices, and payments must remain separate entities.
6. Historical transactions must not be overwritten.
7. The system must support multiple concurrent users.
8. All financial operations must be transaction-safe.
9. Role-based permissions must be enforced on the backend, not only in the interface.

---

16. Security and Data Integrity

Because the platform handles sensitive medical and financial information, implement:

- Secure authentication.
- Role-based access control.
- Password hashing.
- Encrypted communication (HTTPS).
- Audit logs for sensitive actions.
- Automatic database backups.
- Protection against duplicate payments.
- Protection against duplicate service billing.
- Validation of all financial calculations.
- Restricted access to patient information.
- Secure session management.

All changes to payments, discounts, invoices, and patient records must be traceable.

---

17. UI/UX Requirements

The interface must be simple, professional, and optimized for everyday clinic staff.

Design principles:

- Clean and intuitive dashboard.
- Minimal number of steps for common tasks.
- Fast patient search.
- Clear patient status indicators.
- Easy navigation between modules.
- Responsive design for different screen sizes.
- Separate interfaces based on user roles.
- Minimal training requirements for receptionists and cashiers.

The system should prioritize operational speed and simplicity over unnecessary visual complexity.

---

18. Development Priorities

Develop the system incrementally.

Phase 1 — Core MVP

- Authentication and user roles
- Patient registration
- Daily business-day management
- Doctor and department management
- Queue management
- Outpatient management
- Service catalog and pricing
- Cash management
- Basic receipt printing
- Basic CEO dashboard

Phase 2 — Extended Clinic Operations

- Inpatient management
- Bed and room management
- Laboratory management
- Automatic service billing
- Advanced discount management
- Partial payments and debt tracking
- Advanced receipt and invoice generation

Phase 3 — Analytics and Optimization

- Advanced financial analytics
- PDF and Excel exports
- Advanced audit logs
- Operational performance reports
- Advanced integrations
- Automated notifications

---

19. Expected Deliverables

Before considering the project complete, provide:

1. System architecture documentation.
2. Database schema and entity relationships.
3. User role and permission matrix.
4. Complete UI/UX design.
5. Functional frontend and backend.
6. API documentation.
7. Receipt printer integration.
8. Financial calculation logic.
9. CEO reporting dashboard.
10. Testing documentation.
11. Deployment instructions.
12. Technical documentation for future maintenance.

Final Development Instruction

Do not build this as a collection of disconnected CRUD pages.

Build it as one integrated Clinic Management System where patient registration, doctor consultations, laboratory services, inpatient expenses, service billing, cashier operations, and CEO reporting are connected through a centralized patient and financial data architecture.

Every completed service must be traceable to a patient and a visit. Every financial transaction must be auditable. All totals and reports must be calculated from reliable transaction records.

Prioritize correctness, operational simplicity, data integrity, and scalability.
