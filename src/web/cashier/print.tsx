import { t } from "../i18n/index.js";
import { formatUzs, uzs } from "../../modules/billing/index.js";
const amount = (v: unknown) => {
  const text = String(v);
  return text.startsWith("-")
    ? "-" + formatUzs(uzs(text.slice(1)))
    : formatUzs(uzs(text));
};
export function CashierPrint({ value: v }: { value: Record<string, any> }) {
  const labels = {
    opening: "cashier.opening",
    cashPayments: "cashier.cashPayments",
    cashRefunds: "cashier.cashRefunds",
    cashOuts: "cashier.cashOuts",
    expected: "cashier.expected",
    counted: "cashier.counted",
    difference: "cashier.difference",
    amount: "cashier.amount",
    amount_uzs: "cashier.amount",
  } as const;
  return (
    <article className="cashier-print">
      <h3>{v.header?.name || t("cashier.title")}</h3>
      {v.header?.address && <p>{v.header.address}</p>}
      {v.header?.phone && <p>{v.header.phone}</p>}
      {v.receiptNo && (
        <p>
          № {v.receiptNo} · {v.issuedAt}
        </p>
      )}
      {v.patient && (
        <p>
          {v.patient.full_name} · {v.patient.patient_no}
        </p>
      )}
      {v.kind === "refund" && <h4>{t("cashier.refund")}</h4>}
      {v.method && <p>{t(`cashier.${v.method}` as "cashier.cash")}</p>}
      {v.lines?.map((l: any) => (
        <p key={l.id}>
          {l.name} × {l.quantity} · {amount(l.unit_price_uzs)}
        </p>
      ))}
      {v.invoice &&
        (["value", "discount", "paid", "due"] as const).map((k) => (
          <p key={k}>
            {t(`cashier.${k}`)}: {amount(v.invoice[k])}
          </p>
        ))}
      {Object.entries(labels)
        .filter(([key]) => v[key] !== undefined)
        .map(([key, label]) => (
          <p key={key}>
            {t(label)}: {amount(v[key])}
          </p>
        ))}
      {(v.note || v.reason) && <p>{v.note || v.reason}</p>}
      {v.closedAt && <p>{v.closedAt}</p>}
    </article>
  );
}
