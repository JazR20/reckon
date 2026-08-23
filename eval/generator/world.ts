/**
 * Builds the clean world: orders, payments, refunds, settlements and the bank statement
 * they produce, together with the ground truth mapping between them.
 *
 * A DELIBERATE OMISSION, and it is the most important decision in the generator.
 *
 * A real gateway can produce a reconciliation report that maps every payment to the
 * settlement that paid it out. If this corpus emitted that mapping, the task would be a
 * join. Reckon would look excellent and would have proved nothing, because the hard part
 * of multi source reconciliation is precisely that the mapping is absent and must be
 * recovered from arithmetic.
 *
 * So `payments.csv` carries no settlement identifier and `settlements.csv` carries no
 * payment list. Recovering which payments a bank credit represents is a constrained
 * subset sum over a date bounded candidate pool, net of a fee schedule that varies by
 * payment method. That is failure classes F02 and F03, and it is real work.
 *
 * This choice is also realistic. Many merchants reconcile from exactly these two exports
 * because the payment level recon report is a separate artefact they do not pull.
 */

import {
  type Money,
  add,
  allocate,
  fromDecimalString,
  fromMinor,
  multiplyRational,
  subtract,
  sum,
  toMinor,
  zero,
} from "../../src/money/index.ts";
import {
  B2B_SHARE,
  FEE_BPS,
  GATEWAY_NAME,
  GST_ON_FEE_BPS,
  MERCHANT,
  METHOD_MIX,
  type Method,
  NARRATION_STYLES,
  type NarrationStyle,
  PLANS,
  SKUS,
  SETTLEMENT_LAG_WORKING_DAYS,
  TDS_BPS,
  customerRef,
  renderNarration,
} from "./catalogue.ts";
import {
  type IsoDate,
  addWorkingDays,
  compareDates,
  eachDay,
  isWorkingDay,
  isWeekend,
  toTimestamp,
} from "./dates.ts";
import type { Rng } from "./rng.ts";

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type FaultCode =
  | "F01"
  | "F02"
  | "F03"
  | "F04"
  | "F05"
  | "F06"
  | "F07"
  | "F08"
  | "F09"
  | "F10"
  | "F11"
  | "F12";

export interface Order {
  readonly id: string;
  readonly customerRef: string;
  readonly kind: "one_off" | "subscription";
  readonly itemCode: string;
  readonly gross: Money;
  readonly createdAt: IsoDate;
  readonly b2b: boolean;
}

export interface Payment {
  readonly id: string;
  readonly orderId: string;
  readonly method: Method;
  readonly gross: Money;
  readonly capturedAt: IsoDate;
  readonly capturedTs: string;
  readonly status: "captured" | "failed";
}

export interface Refund {
  readonly id: string;
  readonly paymentId: string;
  readonly amount: Money;
  readonly createdAt: IsoDate;
}

export interface Settlement {
  readonly id: string;
  readonly utr: string;
  readonly settledAt: IsoDate;
  readonly gross: Money;
  readonly fee: Money;
  readonly tax: Money;
  readonly tds: Money;
  readonly refundsDeducted: Money;
  readonly net: Money;
  /** ground truth only. Never emitted into a source file */
  readonly paymentIds: readonly string[];
  readonly refundIds: readonly string[];
}

export interface BankTxn {
  readonly id: string;
  readonly date: IsoDate;
  readonly narrationStyle: NarrationStyle;
  readonly narration: string;
  readonly refNo: string;
  readonly credit: Money | null;
  readonly debit: Money | null;
  readonly balance: Money;
}

/** What the matcher is scored against. One entry per bank transaction. */
export interface TruthEntry {
  readonly bankTxnId: string;
  /** null means there is nothing to match. The correct answer is REFUSED */
  readonly settlementId: string | null;
  readonly paymentIds: readonly string[];
  readonly faults: readonly FaultCode[];
  readonly note: string;
}

export interface World {
  readonly orders: Order[];
  readonly payments: Payment[];
  readonly refunds: Refund[];
  readonly settlements: Settlement[];
  readonly bankTxns: BankTxn[];
  readonly truth: TruthEntry[];
}

export interface WorldConfig {
  readonly periodStart: IsoDate;
  readonly periodEnd: IsoDate;
  /** subscribers billed monthly, the main source of amount collisions */
  readonly subscriberCount: number;
  /** mean one off orders on a working day */
  readonly dailyOrdersMean: number;
  readonly dailyOrdersSpread: number;
  readonly failedPaymentRate: number;
  /**
   * Share of captured payments held back from their own day's batch and folded into a
   * later one, the way a payment under risk review settles late.
   *
   * This parameter is what makes failure class F02 real. Without it every settlement is
   * exactly one whole day of captures, so recovering the payment set is not a subset sum
   * at all: a solver simply tries each of 365 days and takes the batch that ties. With it
   * the batch is a day's captures minus its own stragglers plus other days' stragglers,
   * and the subset has to be genuinely searched for.
   */
  readonly latePaymentRate: number;
  readonly refundRate: number;
  readonly chargebackRate: number;
  /** bank credits with nothing behind them, failure class F08 */
  readonly orphanCreditCount: number;
  /** unrelated bank activity that is not a gateway settlement at all */
  readonly noiseCreditCount: number;
}

// ---------------------------------------------------------------------------
// identifier shapes, matching the real ones without reproducing any real value
// ---------------------------------------------------------------------------

function orderId(rng: Rng): string {
  return `order_${rng.token(14)}`;
}
function paymentId(rng: Rng): string {
  return `pay_${rng.token(14)}`;
}
function refundId(rng: Rng): string {
  return `rfnd_${rng.token(14)}`;
}
function settlementId(rng: Rng): string {
  return `setl_${rng.token(14)}`;
}
/** A UTR is 16 alphanumerics on NEFT and RTGS rails. */
function utr(rng: Rng): string {
  return `${rng.pick(["CITIN5", "HDFCN5", "UTIBN5", "ICICN5"])}${rng.token(10)}`;
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

export function buildWorld(rootRng: Rng, config: WorldConfig): World {
  const currency = MERCHANT.currency;
  const days = eachDay(config.periodStart, config.periodEnd);

  const orders: Order[] = [];
  const payments: Payment[] = [];
  const refunds: Refund[] = [];

  // --- subscribers, each with a fixed plan and a fixed billing day of month ---
  const subRng = rootRng.fork("subscribers");
  const subscribers = Array.from({ length: config.subscriberCount }, (_, i) => ({
    ref: customerRef(i),
    plan: subRng.weighted(PLANS.map((p) => [p, p.code === "SG-SUB-M" ? 3 : 1] as const)),
    billingDay: subRng.int(1, 28),
    b2b: subRng.bool(B2B_SHARE),
  }));

  // --- one off orders and subscription charges, day by day ---
  const orderRng = rootRng.fork("orders");
  const payRng = rootRng.fork("payments");

  for (const day of days) {
    const dayOfMonth = Number(day.split("-")[2]);

    // subscription charges on their billing day
    for (const sub of subscribers) {
      if (sub.billingDay !== dayOfMonth) continue;
      const order: Order = {
        id: orderId(orderRng),
        customerRef: sub.ref,
        kind: "subscription",
        itemCode: sub.plan.code,
        gross: fromDecimalString(sub.plan.price, currency),
        createdAt: day,
        b2b: sub.b2b,
      };
      orders.push(order);
      payments.push(makePayment(payRng, order, day));
    }

    // one off orders, lighter at the weekend
    const weekendFactor = isWeekend(day) ? 0.55 : 1;
    const count = Math.max(
      0,
      Math.round(
        orderRng.aboutNormal(config.dailyOrdersMean, config.dailyOrdersSpread) * weekendFactor,
      ),
    );
    for (let i = 0; i < count; i++) {
      const sku = orderRng.weighted(
        SKUS.map((s) => [s, s.code.startsWith("SG-GFT") ? 1 : 3] as const),
      );
      const order: Order = {
        id: orderId(orderRng),
        customerRef: customerRef(orderRng.int(config.subscriberCount, config.subscriberCount + 4000)),
        kind: "one_off",
        itemCode: sku.code,
        gross: fromDecimalString(sku.price, currency),
        createdAt: day,
        b2b: orderRng.bool(B2B_SHARE),
      };
      orders.push(order);
      payments.push(makePayment(payRng, order, day));
    }
  }

  function makePayment(rng: Rng, order: Order, day: IsoDate): Payment {
    const failed = rng.bool(config.failedPaymentRate);
    return {
      id: paymentId(rng),
      orderId: order.id,
      method: rng.weighted(METHOD_MIX),
      gross: order.gross,
      capturedAt: day,
      capturedTs: toTimestamp(day, rng.int(6, 23), rng.int(0, 59)),
      status: failed ? "failed" : "captured",
    };
  }

  const orderById = new Map(orders.map((o) => [o.id, o] as const));
  const captured = payments.filter((p) => p.status === "captured");

  // --- refunds, some of which cross a settlement boundary (F09) ---
  const refundRng = rootRng.fork("refunds");
  for (const payment of captured) {
    if (!refundRng.bool(config.refundRate)) continue;
    const full = refundRng.bool(0.6);
    const amount = full
      ? payment.gross
      : multiplyRational(payment.gross, BigInt(refundRng.int(20, 80)), 100n);
    const daysLater = refundRng.int(0, 9);
    const at = addWorkingDays(payment.capturedAt, daysLater);
    if (compareDates(at, config.periodEnd) > 0) continue;
    refunds.push({
      id: refundId(refundRng),
      paymentId: payment.id,
      amount,
      createdAt: at,
    });
  }

  // --- settlements: a batch per settlement day, credited T+2 working days later ---
  //
  // A batch is NOT simply one day of captures. A share of payments is held back and
  // folded into a later batch, so a batch is one day's captures minus its own stragglers
  // plus stragglers arriving from earlier days. That is what makes recovering the
  // payment set a subset search rather than a lookup by date.
  const setlRng = rootRng.fork("settlements");
  const lateRng = rootRng.fork("late-payments");
  const byCaptureDay = new Map<IsoDate, Payment[]>();
  for (const payment of captured) {
    const heldDays = lateRng.bool(config.latePaymentRate) ? lateRng.int(1, 3) : 0;
    const batchDay = heldDays === 0 ? payment.capturedAt : addWorkingDays(payment.capturedAt, heldDays);
    if (compareDates(batchDay, config.periodEnd) > 0) continue;
    const bucket = byCaptureDay.get(batchDay);
    if (bucket) bucket.push(payment);
    else byCaptureDay.set(batchDay, [payment]);
  }

  const settlements: Settlement[] = [];
  const refundsByDate = groupBy(refunds, (r) => r.createdAt);
  const consumedRefunds = new Set<string>();

  for (const day of days) {
    const batch = byCaptureDay.get(day);
    if (!batch || batch.length === 0) continue;
    const settledAt = addWorkingDays(day, SETTLEMENT_LAG_WORKING_DAYS);
    if (compareDates(settledAt, config.periodEnd) > 0) continue;

    const gross = sum(batch.map((p) => p.gross), currency);

    // fee is per payment, because the rate varies by method. This is what makes the
    // settlement arithmetic non invertible from the total alone.
    const perPaymentFee = batch.map((p) => multiplyRational(p.gross, BigInt(FEE_BPS[p.method]), 10000n));
    const fee = sum(perPaymentFee, currency);
    const tax = multiplyRational(fee, BigInt(GST_ON_FEE_BPS), 10000n);

    const tds = sum(
      batch.map((p) => {
        const order = orderById.get(p.orderId);
        return order?.b2b === true
          ? multiplyRational(p.gross, BigInt(TDS_BPS), 10000n)
          : zero(currency);
      }),
      currency,
    );

    // refunds raised on or before the settlement date are netted off this payout
    const dueRefunds = (refundsByDate.get(settledAt) ?? []).filter((r) => !consumedRefunds.has(r.id));
    for (const r of dueRefunds) consumedRefunds.add(r.id);
    const refundsDeducted = sum(dueRefunds.map((r) => r.amount), currency);

    const net = subtract(subtract(subtract(subtract(gross, fee), tax), tds), refundsDeducted);

    settlements.push({
      id: settlementId(setlRng),
      utr: utr(setlRng),
      settledAt,
      gross,
      fee,
      tax,
      tds,
      refundsDeducted,
      net,
      paymentIds: batch.map((p) => p.id),
      refundIds: dueRefunds.map((r) => r.id),
    });
  }

  // --- the bank statement ---
  const bankRng = rootRng.fork("bank");
  const truth: TruthEntry[] = [];
  const rows: Array<Omit<BankTxn, "balance">> = [];

  let bankSeq = 0;
  const nextBankId = (): string => `btxn_${(++bankSeq).toString().padStart(5, "0")}`;

  for (const settlement of settlements) {
    const style = bankRng.weighted(NARRATION_STYLES);
    const id = nextBankId();
    rows.push({
      id,
      date: settlement.settledAt,
      narrationStyle: style,
      narration: renderNarration(style, settlement.utr, GATEWAY_NAME, bankRng.token(12)),
      refNo: settlement.utr,
      credit: settlement.net,
      debit: null,
    });
    const faults: FaultCode[] = ["F02", "F03"];
    if (settlement.refundIds.length > 0) faults.push("F09");
    truth.push({
      bankTxnId: id,
      settlementId: settlement.id,
      paymentIds: settlement.paymentIds,
      faults,
      note: `settlement of ${settlement.paymentIds.length} payments`,
    });
  }

  // --- chargebacks, F10: a debit reversing a payment settled weeks earlier ---
  const cbRng = rootRng.fork("chargebacks");
  const settledPayments = settlements.flatMap((s) =>
    s.paymentIds.map((pid) => ({ pid, settledAt: s.settledAt })),
  );
  const chargebackCount = Math.round(settledPayments.length * config.chargebackRate);
  for (const target of cbRng.sample(settledPayments, Math.min(chargebackCount, settledPayments.length))) {
    const payment = payments.find((p) => p.id === target.pid);
    if (!payment) continue;
    const at = addWorkingDays(target.settledAt, cbRng.int(11, 90));
    if (compareDates(at, config.periodEnd) > 0) continue;
    const style = cbRng.weighted(NARRATION_STYLES);
    const ref = utr(cbRng);
    const id = nextBankId();
    // the reversal carries a dispute fee on top of the payment value
    const disputeFee = fromDecimalString("500.00", currency);
    rows.push({
      id,
      date: at,
      narrationStyle: style,
      narration: renderNarration(style, ref, GATEWAY_NAME, "CHARGEBACK"),
      refNo: ref,
      credit: null,
      debit: add(payment.gross, disputeFee),
    });
    truth.push({
      bankTxnId: id,
      settlementId: null,
      paymentIds: [payment.id],
      faults: ["F10"],
      note: "chargeback reversing a settled payment, plus a dispute fee",
    });
  }

  // --- F08: bank credits with nothing behind them at all ---
  const orphanRng = rootRng.fork("orphans");
  const workingDays = days.filter(isWorkingDay);
  for (let i = 0; i < config.orphanCreditCount; i++) {
    const date = orphanRng.pick(workingDays);
    const style = orphanRng.weighted(NARRATION_STYLES);
    const ref = utr(orphanRng);
    const id = nextBankId();
    // shaped exactly like a settlement, which is what makes it dangerous. A greedy
    // matcher attaches it to the nearest plausible batch and the discrepancy is erased.
    const amount = fromMinor(BigInt(orphanRng.int(180_000, 900_000)), currency);
    rows.push({
      id,
      date,
      narrationStyle: style,
      narration: renderNarration(style, ref, GATEWAY_NAME, orphanRng.token(12)),
      refNo: ref,
      credit: amount,
      debit: null,
    });
    truth.push({
      bankTxnId: id,
      settlementId: null,
      paymentIds: [],
      faults: ["F08"],
      note: "orphan credit, no settlement and no payment explains it",
    });
  }

  // --- unrelated bank activity, which must also not be matched to anything ---
  const noiseRng = rootRng.fork("noise");
  const noiseKinds = [
    { label: "INT.PD:SAVINGS", amount: "1240.00" },
    { label: "REV:CHRG GST", amount: "180.00" },
    { label: "NEFT-VENDOR REFUND-TRAVEL DESK", amount: "8400.00" },
    { label: "IMPS/RETURN/FAILED PAYOUT", amount: "15000.00" },
  ] as const;
  for (let i = 0; i < config.noiseCreditCount; i++) {
    const kind = noiseRng.pick(noiseKinds);
    const date = noiseRng.pick(workingDays);
    const id = nextBankId();
    rows.push({
      id,
      date,
      narrationStyle: "terse",
      narration: kind.label,
      refNo: noiseRng.token(12),
      credit: fromDecimalString(kind.amount, currency),
      debit: null,
    });
    truth.push({
      bankTxnId: id,
      settlementId: null,
      paymentIds: [],
      faults: [],
      note: "not a gateway settlement",
    });
  }

  // --- order the statement by date and compute a running balance ---
  rows.sort((a, b) => compareDates(a.date, b.date) || a.id.localeCompare(b.id));
  let balance = fromDecimalString("250000.00", currency);
  const bankTxns: BankTxn[] = rows.map((row) => {
    if (row.credit) balance = add(balance, row.credit);
    if (row.debit) balance = subtract(balance, row.debit);
    return { ...row, balance };
  });

  const truthById = new Map(truth.map((t) => [t.bankTxnId, t] as const));
  const orderedTruth = bankTxns.map((t) => {
    const entry = truthById.get(t.id);
    if (!entry) throw new Error(`Bank transaction ${t.id} has no truth entry`);
    return entry;
  });

  return { orders, payments, refunds, settlements, bankTxns, truth: orderedTruth };
}

function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** Exported for the fee apportionment the tier 2 solver will need to mirror. */
export function apportionFee(total: Money, weights: readonly Money[]): Money[] {
  return allocate(total, weights.map((w) => toMinor(w)));
}
