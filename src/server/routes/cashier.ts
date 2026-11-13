import { z } from "zod";
import * as a from "../../modules/cashier/actions.js";
import { registerRoutes } from "./registry.js";
import { parse, uuid, type Route } from "./types.js";
const roles = ["cashier", "ceo", "administrator"] as const;
const route = (
  method: Route["method"],
  pattern: RegExp,
  handle: Route["handle"],
): Route => ({ method, pattern, roles, handle });
registerRoutes("cashier", [
  route("GET", /^cashier$/, async (c) => ({ body: await a.overview(c) })),
  route("POST", /^cashier\/search$/, async (c, _p, b) => ({
    body: await a.lookup(c, parse(a.Search, await b())),
  })),
  route("POST", /^cashier\/shifts$/, async (c, _p, b) => ({
    status: 201,
    body: await a.open(c, parse(a.Open, await b())),
  })),
  route(
    "POST",
    new RegExp(`^cashier/shifts/${uuid}/close$`),
    async (c, [id], b) => ({
      body: await a.close(c, id!, parse(a.Close, await b())),
    }),
  ),
  route(
    "POST",
    new RegExp(`^cashier/shifts/${uuid}/cash-out$`),
    async (c, [id], b) => ({
      status: 201,
      body: await a.cashOut(c, id!, parse(a.OutRequest, await b())),
    }),
  ),
  route("GET", new RegExp(`^cashier/visits/${uuid}$`), async (c, [id]) => ({
    body: a.json(await a.bill(c, id!)),
  })),
  route("POST", /^cashier\/approvals$/, async (c, _p, b) =>
    a.approve(c, parse(a.Approval, await b())),
  ),
  route(
    "POST",
    new RegExp(`^cashier/visits/${uuid}/payments$`),
    async (c, [id], b) => ({
      status: 201,
      body: await a.pay(c, id!, parse(a.Payment, await b())),
    }),
  ),
  ...(["refund", "discount", "void"] as const).map((operation) =>
    route(
      "POST",
      new RegExp(`^cashier/visits/${uuid}/${operation}$`),
      async (c, [id], b) => {
        // Strip the approval credential before hashing the typed financial payload.
        const raw = (await b()) as Record<string, unknown>;
        const { approvalId, ...payload } = raw ?? {};
        const approval = parse(a.Approved, { approvalId }).approvalId;
        const body =
          operation === "refund"
            ? await a.pay(c, id!, parse(a.Refund, payload), approval)
            : operation === "discount"
              ? await a.discount(c, id!, parse(a.Reduction, payload), approval)
              : await a.voidDiscount(c, id!, parse(a.Void, payload), approval);
        return { body };
      },
    ),
  ),
  route(
    "POST",
    new RegExp(`^cashier/receipts/${uuid}/print$`),
    async (c, [id], b) => {
      parse(z.object({}).strict(), await b());
      return { body: await a.receipt(c, id!) };
    },
  ),
]);
