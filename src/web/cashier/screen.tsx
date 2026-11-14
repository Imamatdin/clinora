// Task 028 cashier (docs/DESIGN.md): find the patient, see what is owed as one large figure, take the payment.
// The amount is pre-filled with the full sum due, so the usual case needs no typing. Discounts, refunds, receipts,
// cash-out and closing the shift sit one tap deeper, in sheets. Every server call is unchanged from task 009/023.
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ModuleProps, WebModule } from "../modules.js";
import { CashierPrint } from "./print.js";
import { t, errorText } from "../i18n/index.js";
import { formatUzs, uzs } from "../../modules/billing/index.js";
import { AbrField } from "../abr.js";
import { Icon, Seg, Sheet } from "../shell.js";
type Row = Record<string, any>;
const money = (n: string) => formatUzs(uzs(n));
const digits = (v: string) => v.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
/** Sums are typed and shown in groups of three ("110 000"); the state keeps bare digits. */
const grouped = (v: string) => v.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const METHODS = ["cash", "card", "transfer"] as const;
type Method = (typeof METHODS)[number];

export function Cashier({ clinic, request }: ModuleProps) {
  const base = `/api/clinics/${clinic.id}/cashier`;
  const [data, setData] = useState<Row>({ desks: [], expenses: [], shifts: [], approvers: [] }),
    [loaded, setLoaded] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(""), [saved, setSaved] = useState(false);
  const [desk, setDesk] = useState(""), [opening, setOpening] = useState("0"), [shift, setShift] = useState("");
  const [query, setQuery] = useState(""), [matches, setMatches] = useState<Row[]>([]), [searched, setSearched] = useState(false);
  const [visit, setVisit] = useState(""), [bill, setBill] = useState<Row | null>(null);
  const [amount, setAmount] = useState(""), [given, setGiven] = useState(""), [method, setMethod] = useState<Method>("cash"), [confirm, setConfirm] = useState(false);
  const [sheet, setSheet] = useState<"" | "shift" | "more">("");
  // Sheet fields. Each form has its own amount and reason, so nothing typed for one action leaks into another.
  const [reason, setReason] = useState(""), [approver, setApprover] = useState(""), [pin, setPin] = useState(""), [kind, setKind] = useState("fixed"), [lineId, setLineId] = useState(""),
    [discountAmount, setDiscountAmount] = useState(""), [payment, setPayment] = useState(""), [refundAmount, setRefundAmount] = useState(""), [refundReason, setRefundReason] = useState("");
  const [expense, setExpense] = useState(""), [outAmount, setOutAmount] = useState(""), [outNote, setOutNote] = useState(""), [outPin, setOutPin] = useState(""), [counted, setCounted] = useState("0");
  const [printable, setPrintable] = useState<Row | null>(null);
  const paymentKey = useRef<{ signature: string; key: string } | null>(null);
  const manager = clinic.roles.some((r: string) => r === "ceo" || r === "administrator");
  const locked = useRef(false);

  async function load() {
    const d = await request<Row>(base);
    setData(d); setLoaded(true);
    setDesk((x) => x || d.desks[0]?.id || "");
    setShift((x) => (d.shifts.some((s: Row) => s.id === x && s.status === "open") ? x : d.shifts.find((s: Row) => s.status === "open")?.id || ""));
    setApprover((x) => x || d.approvers[0]?.id || "");
    setExpense((x) => x || d.expenses[0]?.id || "");
  }
  async function run(fn: () => Promise<void>, announce = true) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setError(""); setSaved(false);
    try { await fn(); if (announce) setSaved(true); } // Task 017: loading the screen is not a save.
    catch (e) { setError(errorText((e as { code: string }).code)); }
    finally { setBusy(false); locked.current = false; }
  }
  useEffect(() => { void run(load, false); }, [clinic.id]);
  const showBill = (b: Row) => { setBill(b); const due = String(b.invoice.due); setAmount(/^\d+$/.test(due) && due !== "0" ? due : ""); setGiven(""); };
  async function openVisit(id: string) { setVisit(id); showBill(await request<Row>(`${base}/visits/${id}`)); }
  async function refresh() { if (visit) showBill(await request<Row>(`${base}/visits/${visit}`)); await load(); }
  async function sensitive(operation: string, payload: Row) {
    let approvalId: string | undefined;
    if (!manager) {
      const approved = await request<{ approvalId: string }>(base + "/approvals", { approverId: approver, pin, visitId: visit, operation, payload });
      approvalId = approved.approvalId; setPin("");
    }
    const result = await request<Row>(`${base}/visits/${visit}/${operation}`, { ...payload, ...(approvalId ? { approvalId } : {}) });
    if (operation === "refund") setPrintable(result.snapshot);
    await refresh();
  }
  function keyFor(payload: Row) {
    const signature = JSON.stringify(payload);
    if (paymentKey.current?.signature !== signature) paymentKey.current = { signature, key: crypto.randomUUID() };
    return paymentKey.current.key;
  }
  const select = (label: Parameters<typeof t>[0], value: string, set: (s: string) => void, rows: Row[], name: (r: Row) => string) => (
    <label>{t(label)}
      <select aria-label={t(label)} value={value} onChange={(e) => set(e.target.value)}>
        <option value="">—</option>
        {rows.map((r) => <option key={r.id} value={r.id}>{name(r)}</option>)}
      </select>
    </label>
  );
  const field = (label: Parameters<typeof t>[0], value: string, set: (s: string) => void, numeric = false, extra: Row = {}) => (
    <label>{t(label)}<input value={numeric ? grouped(value) : value} inputMode={numeric ? "numeric" : undefined} autoComplete="off" onChange={(e) => set(numeric ? digits(e.target.value) : e.target.value)} {...extra} /></label>
  );
  const approval = (pinValue: string, setPinValue: (s: string) => void, approverLabel: Parameters<typeof t>[0] = "cashier.approver", pinLabel: Parameters<typeof t>[0] = "cashier.pin"): ReactNode => !manager && <>
    {select(approverLabel, approver, setApprover, data.approvers, (r) => r.display_name)}
    <label>{t(pinLabel)}<input type="password" inputMode="numeric" autoComplete="off" value={pinValue} onChange={(e) => setPinValue(e.target.value)} /></label>
  </>;

  const openShifts = data.shifts.filter((s: Row) => s.status === "open"), deskName = (s: Row) => data.desks.find((d: Row) => d.id === s.cash_desk_id)?.name ?? s.id;
  const current = openShifts.find((s: Row) => s.id === shift);
  const due = bill ? BigInt(bill.invoice.due) : 0n, payable = /^\d+$/.test(amount) && BigInt(amount) > 0n;
  const change = method === "cash" && payable && /^\d+$/.test(given) && BigInt(given) >= BigInt(amount) ? BigInt(given) - BigInt(amount) : null;
  const groups = bill ? [...new Set<string>(bill.lines.map((l: Row) => l.doctor || l.department || t("cashier.visit")))] : [];
  const closeBill = () => { setBill(null); setVisit(""); setConfirm(false); setSaved(false); setError(""); };

  return (
    <section className="cashier screen">
      <div className="banners" aria-live="polite">
        {error && <p role="alert" className="error">{error}</p>}
        {busy && <p role="status" className="sr-only">{t("cashier.loading")}</p>}
        {saved && <p role="status" className="notice">{t("cashier.saved")}</p>}
      </div>
      <fieldset disabled={busy} className="cashier-body">
        {!loaded ? null : !openShifts.length ? (
          <div className="hero"><AbrField />
            <div className="hero-in cashier-open">
              <h2 className="hero-name">{t("cashier.shiftClosed")}</h2>
              {data.desks.length > 1 && select("cashier.desk", desk, setDesk, data.desks, (r) => r.name)}
              {field("cashier.opening", opening, setOpening, true)}
              <button className="primary big" onClick={() => void run(async () => { const s = await request<Row>(base + "/shifts", { deskId: desk, opening }); setShift(s.id); await load(); })}>{t("cashier.open")}</button>
            </div>
          </div>
        ) : !bill ? (<>
          <div className="hero"><AbrField />
            <form className="hero-in" role="search" onSubmit={(e) => { e.preventDefault(); void run(async () => { setMatches(await request<Row[]>(base + "/search", { query })); setSearched(true); }, false); }}>
              <div className="search-field"><Icon name="search" />
                <input type="search" aria-label={t("cashier.search")} placeholder={t("cashier.searchHint")} value={query} autoFocus enterKeyHint="search" onChange={(e) => { setQuery(e.target.value); setSearched(false); }} />
                <button className="primary" disabled={!query.trim()}>{t("cashier.find")}</button></div>
            </form>
          </div>
          {searched && !matches.length && <p role="status" className="empty">{t("cashier.empty")}</p>}
          {matches.length > 0 && <ul className="rows cashier-results">{matches.map((p) => (
            <li key={p.id}><button className="row" aria-label={`${p.patient_no} · ${p.full_name}`} onClick={() => void run(() => openVisit(p.id), false)}>
              <span className="row-lead muted">№ {p.patient_no}</span><span className="row-title row-body">{p.full_name}</span><span className="chev" aria-hidden="true" /></button></li>
          ))}</ul>}
        </>) : (<>
          <div className="cashier-head"><button className="quiet back" onClick={closeBill}><Icon name="back" />{t("cashier.back")}</button>
            <button className="quiet" onClick={() => setSheet("more")}>{t("cashier.more")}</button></div>
          <div className="hero"><AbrField />
            <div className="hero-in cashier-pay">
              <div className="cashier-owed">
                <h2 className="hero-name">{bill.patient.full_name}</h2>
                {due > 0n ? <><p className="hero-label">{t("cashier.dueLabel")}</p>
                  <p className="hero-figure attn">{money(String(bill.invoice.due)).replace(/\s*сўм$/, "")}<small>{t("cashier.uzs")}</small></p></>
                  : <p className="cashier-settled okc"><Icon name="check" />{t("cashier.settled")}</p>}
              </div>
              {due > 0n && <div className="cashier-take">
                <Seg label={t("cashier.method")} value={method} onChange={setMethod} options={METHODS.map((m) => [m, t(`cashier.${m}`)] as const)} />
                {field("cashier.amount", amount, setAmount, true)}
                {method === "cash" && field("cashier.given", given, setGiven, true)}
                {change !== null && <p className="cashier-change">{t("cashier.change")} <b className="num">{money(change.toString())}</b></p>}
                <div className="keypad" role="group" aria-label={t("cashier.amount")}>
                  {"1234567890".split("").map((n) => <button key={n} onClick={() => setAmount((v) => digits(v + n))}>{n}</button>)}
                  <button aria-label={t("cashier.backspace")} onClick={() => setAmount((v) => v.slice(0, -1))}>⌫</button>
                </div>
                <button className="primary big" disabled={!shift || !payable} onClick={() => setConfirm(true)}>{t("cashier.take")}</button>
              </div>}
            </div>
          </div>
          {groups.map((group) => (
            <section key={group} className="cashier-group"><h3 className="section-label">{group}</h3>
              <ul className="rows">{bill.lines.filter((l: Row) => (l.doctor || l.department || t("cashier.visit")) === group).map((l: Row) => {
                const total = bill.invoice.lines.find((n: Row) => n.id === l.id);
                return (
                  <li key={l.id}><div className={`row ${l.status === "cancelled" ? "cancelled" : ""}`}>
                    <span className="row-body"><span className="row-title">{l.name}{l.quantity > 1 && <span className="muted"> × {l.quantity}</span>}</span>
                      {l.status === "cancelled" && <span className="row-meta">{t("cashier.cancelled")}</span>}</span>
                    {/* Task 023: an unpaid ordered line that will not be performed leaves the bill. The reason is asked for and recorded. */}
                    {l.status === "ordered" && total.allocatedPaid === "0" && (
                      <button className="quiet small" aria-label={`${t("cashier.cancelLine")}: ${l.name}`} onClick={() => {
                        const why = window.prompt(`${l.name}: ${t("cashier.reason")}`)?.trim();
                        if (why) void run(async () => { await request(`/api/clinics/${clinic.id}/charges/${l.id}/cancel`, { idempotencyKey: crypto.randomUUID(), reason: why }); await refresh(); });
                      }}>{t("cashier.cancelLine")}</button>
                    )}
                    <span className="row-end num">{money(total.payable)}</span>
                  </div></li>
                );
              })}</ul>
            </section>
          ))}
          <dl className="cashier-totals">
            {(["value", "discount", "paid", "due"] as const).map((k) => (
              <div key={k} className={k === "due" ? "total" : ""}><dt>{t(`cashier.${k}`)}</dt><dd data-testid={`cashier-${k}`}>{money(bill.invoice[k])}</dd></div>
            ))}
          </dl>
        </>)}
        {openShifts.length > 0 && !bill && (
          <button className="quiet cashier-shift" onClick={() => setSheet("shift")}><span className="dot ok">{current ? deskName(current) : t("cashier.shift")}</span><span className="chev" aria-hidden="true" /></button>
        )}
        {!openShifts.length && data.shifts.some((s: Row) => s.status === "closed") && <div className="cashier-reports">{data.shifts.filter((s: Row) => s.status === "closed").map((s: Row) => (
          <button key={s.id} className="quiet" onClick={() => setPrintable(s.close_report)}>{t("cashier.report")} · {new Date(s.opened_at).toLocaleDateString()}</button>
        ))}</div>}
      </fieldset>

      {confirm && bill && (
        <div className="modal-backdrop"><section className="modal" role="dialog" aria-modal="true" aria-label={t("cashier.take")}>
          <p className="cashier-confirm">{t("cashier.confirm", { name: bill.patient.full_name, amount: money(amount), method: t(`cashier.${method}`) })}</p>
          <div className="actions">
            <button className="primary big" autoFocus disabled={busy} onClick={() => void run(async () => {
              const payload = { shiftId: shift, amount, method };
              const result = await request<Row>(`${base}/visits/${visit}/payments`, { ...payload, key: keyFor(payload) });
              paymentKey.current = null; setPrintable(result.snapshot); setConfirm(false); await refresh();
            })}>{t("cashier.yes")}</button>
            <button className="big" disabled={busy} onClick={() => setConfirm(false)}>{t("cashier.cancel")}</button>
          </div>
        </section></div>
      )}

      {sheet === "more" && bill && (
        <Sheet title={t("cashier.more")} onClose={() => setSheet("")}>
          {error && <p role="alert" className="error">{error}</p>}
          {bill.receipts?.length > 0 && <div className="actions">{bill.receipts.map((r: Row) => (
            <button key={r.id} disabled={busy} onClick={() => void run(async () => { const result = await request<Row>(`${base}/receipts/${r.id}/print`, {}); setPrintable(result.snapshot); setSheet(""); }, false)}><Icon name="print" />{t("cashier.print")} · № {r.receipt_no}</button>
          ))}</div>}
          <details className="cashier-form"><summary>{t("cashier.discount")}</summary>
            {select("cashier.kind", kind, setKind, [{ id: "fixed" }, { id: "percent" }], (r) => t(`cashier.${r.id}` as "cashier.fixed"))}
            {field("cashier.discountAmount", discountAmount, setDiscountAmount, true)}
            {select("cashier.target", lineId, setLineId, bill.lines, (r) => r.name)}
            {field("cashier.reason", reason, setReason)}
            {approval(pin, setPin)}
            <button className="primary" disabled={busy} onClick={() => void run(async () => { await sensitive("discount", { kind, amount: discountAmount, reason, ...(lineId ? { lineId } : {}) }); setDiscountAmount(""); setReason(""); })}>{t("cashier.apply")}</button>
            {bill.discounts.map((d: Row) => (
              <button key={d.id} disabled={busy} onClick={() => void run(() => sensitive("void", { discountId: d.id, reason }))}>{t("cashier.void")} · {d.reason}</button>
            ))}
          </details>
          <details className="cashier-form"><summary>{t("cashier.refund")}</summary>
            {select("cashier.payment", payment, setPayment, bill.payments.filter((p: Row) => p.kind === "payment"), (r) => `${money(r.amount_uzs)} · ${t(`cashier.${r.method}` as "cashier.cash")}`)}
            {field("cashier.refundAmount", refundAmount, setRefundAmount, true)}
            {field("cashier.refundReason", refundReason, setRefundReason)}
            {approval(pin, setPin)}
            <button className="danger" disabled={busy} onClick={() => {
              if (window.confirm(t("cashier.refundConfirm", { amount: money(refundAmount || "0") })))
                void run(async () => { const p = { shiftId: shift, paymentId: payment, amount: refundAmount, reason: refundReason }; await sensitive("refund", { ...p, key: keyFor(p) }); paymentKey.current = null; setRefundAmount(""); setRefundReason(""); });
            }}>{t("cashier.refund")}</button>
          </details>
        </Sheet>
      )}

      {sheet === "shift" && (
        <Sheet title={current ? deskName(current) : t("cashier.shift")} onClose={() => setSheet("")}>
          {error && <p role="alert" className="error">{error}</p>}
          {saved && <p role="status" className="notice">{t("cashier.saved")}</p>}
          {openShifts.length > 1 && select("cashier.shift", shift, setShift, openShifts, deskName)}
          <details className="cashier-form"><summary>{t("cashier.out")}</summary>
            {select("cashier.expense", expense, setExpense, data.expenses, (r) => r.name_uz_cyrl)}
            {field("cashier.outAmount", outAmount, setOutAmount, true)}
            {field("cashier.note", outNote, setOutNote)}
            {/* Task 023: a cashier's cash-out above the clinic threshold needs a CEO/administrator PIN (default: always). */}
            {approval(outPin, setOutPin, "cashier.outApprover", "cashier.outPin")}
            <button disabled={busy} onClick={() => {
              if (window.confirm(t("cashier.outConfirm", { amount: money(outAmount || "0") })))
                void run(async () => {
                  const payload = { expenseId: expense, amount: outAmount, note: outNote };
                  // One key per press: a retry of this press records one cash-out.
                  const key = keyFor({ out: shift, ...payload });
                  let approvalId: string | undefined;
                  if (!manager && outPin) {
                    approvalId = (await request<{ approvalId: string }>(base + "/approvals", { approverId: approver, pin: outPin, shiftId: shift, operation: "cash_out", payload })).approvalId;
                    setOutPin("");
                  }
                  const r = await request<Row>(`${base}/shifts/${shift}/cash-out`, { ...payload, key, ...(approvalId ? { approvalId } : {}) });
                  paymentKey.current = null; setPrintable(r); setOutAmount(""); setOutNote("");
                });
            }}>{t("cashier.outSubmit")}</button>
          </details>
          <details className="cashier-form" open><summary>{t("cashier.close")}</summary>
            {field("cashier.counted", counted, setCounted, true)}
            <button className="primary" disabled={busy || !shift} onClick={() => {
              if (window.confirm(t("cashier.closeConfirm", { amount: money(counted) })))
                void run(async () => { setPrintable(await request<Row>(`${base}/shifts/${shift}/close`, { counted })); setShift(""); setSheet(""); await load(); });
            }}>{t("cashier.close")}</button>
          </details>
          {data.shifts.filter((s: Row) => s.status === "closed").map((s: Row) => (
            <button key={s.id} className="quiet" onClick={() => { setPrintable(s.close_report); setSheet(""); }}>{t("cashier.report")} · {new Date(s.opened_at).toLocaleDateString()}</button>
          ))}
        </Sheet>
      )}

      {printable && (
        <div className="cashier-printable">
          <div className="actions"><button className="primary" onClick={() => window.print()}><Icon name="print" />{t("cashier.print")}</button>
            <button className="quiet" onClick={() => setPrintable(null)}>{t("app.close")}</button></div>
          <CashierPrint value={printable} />
        </div>
      )}
    </section>
  );
}
export const cashierModule: WebModule = { id: "cashier", label: "module.payments", roles: ["cashier", "ceo", "administrator"], Screen: Cashier };
