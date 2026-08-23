/**
 * Writes the corpus to disk as the files a merchant actually has.
 *
 * A SECOND DELIBERATE DIFFICULTY, added after a first pass made the corpus too easy.
 *
 * The settlement export carries a net amount, and net amounts are close to unique, so a
 * bank credit could be joined to its settlement on amount alone even with the reference
 * destroyed. That would have made failure class F06 free and left the tier 2 solver with
 * nothing to do, and the deterministic baseline would have sat above the 95 percent bound
 * that section 6.1 of DESIGN.md calls theatre.
 *
 * So a configured share of settlements is absent from `settlements.csv` entirely. This is
 * realistic rather than contrived: a merchant pulls a dated export window and the edges
 * fall outside it, or the export is taken before a late settlement lands. For those bank
 * credits there is no settlement row to join to, and the payment set has to be recovered
 * from the payments file by arithmetic alone.
 *
 * Consequence for scoring, recorded here because it defines what correct means: a bank
 * transaction is decided correctly when the predicted PAYMENT SET is value equivalent to
 * the true payment set, or when a transaction with no payments behind it is refused. The
 * settlement identifier is evidence, not the answer. Value equivalence rather than exact
 * set equality, because a measured 23 percent of payments here are interchangeable and a
 * perfect matcher tops out at 40 percent under a strict rule. See ADR 0005.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  type Money,
  add,
  convert,
  equals,
  format,
  fromDecimalString,
  subtract,
  sum,
  toDecimalString,
  toMinor,
} from "../../src/money/index.ts";
import { GATEWAY_NAME, MERCHANT } from "./catalogue.ts";
import { type IsoDate, compareDates, toBankFormat } from "./dates.ts";
import { type Corruption, damageNarration, skewDate } from "./faults.ts";
import type { Rng } from "./rng.ts";
import type { TruthEntry, World } from "./world.ts";

export interface EmitConfig {
  /** share of settlements deliberately absent from settlements.csv */
  readonly settlementExportGapRate: number;
}

export interface EmittedTruth {
  readonly row: number;
  readonly bankTxnId: string;
  readonly settlementId: string | null;
  readonly settlementRowPresent: boolean;
  readonly paymentIds: readonly string[];
  readonly faults: readonly string[];
  readonly note: string;
  /** when set, this row is a duplicate of the given row and must be removed at ingest */
  readonly duplicateOfRow: number | null;
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function csvRow(cells: readonly string[]): string {
  return cells.map(csvCell).join(",");
}

function amountCell(amount: Money): string {
  return toDecimalString(amount);
}

/**
 * A unit ambiguous cell: the value is written as an integer count of minor units with no
 * decimal point, in a column where every other row carries two decimals.
 *
 * There is nothing in the row that says which unit it is. Read as rupees it is a
 * plausible settlement. Read as paise it is a different plausible settlement. This is
 * failure class F01 and the only correct answer is to refuse the row, because choosing
 * an interpretation is guessing at a number that will be believed.
 */
function unitAmbiguousCell(amount: Money): string {
  return toMinor(amount).toString();
}

export async function emitCorpus(
  outDir: string,
  world: World,
  truth: readonly TruthEntry[],
  corruption: Corruption,
  config: EmitConfig,
  rootRng: Rng,
): Promise<{ truth: EmittedTruth[]; counts: Record<string, number> }> {
  const sourcesDir = join(outDir, "sources");
  await mkdir(sourcesDir, { recursive: true });

  const currency = MERCHANT.currency;
  const truthByTxn = new Map(truth.map((t) => [t.bankTxnId, t] as const));

  // -------------------------------------------------------------------------
  // which settlements make it into the export
  // -------------------------------------------------------------------------
  const gapRng = rootRng.fork("export-gap");
  const omittedSettlements = new Set<string>();
  for (const settlement of world.settlements) {
    if (gapRng.bool(config.settlementExportGapRate)) omittedSettlements.add(settlement.id);
  }

  // -------------------------------------------------------------------------
  // bank statement
  // -------------------------------------------------------------------------
  const narrationRng = rootRng.fork("narration-damage");
  const dupSet = new Set(corruption.duplicatedBankTxnIds);

  interface StatementRow {
    readonly bankTxnId: string;
    readonly date: IsoDate;
    readonly narration: string;
    readonly refNo: string;
    readonly credit: Money | null;
    readonly debit: Money | null;
    readonly balance: Money;
    readonly unitAmbiguous: boolean;
    readonly isDuplicate: boolean;
  }

  const statementRows: StatementRow[] = [];
  for (const txn of world.bankTxns) {
    const damage = corruption.narrationDamage.get(txn.id);
    const row: StatementRow = {
      bankTxnId: txn.id,
      date: skewDate(txn.date, corruption.bankDateSkew.get(txn.id)),
      narration: damageNarration(txn.narration, txn.refNo, damage, narrationRng),
      refNo: damage === "drop_ref" || damage === "truncate_ref" ? "" : txn.refNo,
      credit: txn.credit,
      debit: txn.debit,
      balance: txn.balance,
      unitAmbiguous: corruption.unitAmbiguous.has(txn.id),
      isDuplicate: false,
    };
    statementRows.push(row);
    if (dupSet.has(txn.id)) {
      // the duplicate is byte identical except that the bank assigned it its own serial,
      // which is why deduplication has to be content based rather than key based
      statementRows.push({ ...row, isDuplicate: true });
    }
  }

  statementRows.sort(
    (a, b) => compareDates(a.date, b.date) || a.bankTxnId.localeCompare(b.bankTxnId),
  );

  // The running balance MUST be recomputed here, after the sort.
  //
  // world.ts assigns a balance in settlement order. F05 then shifts statement dates, and
  // this sort reorders the rows, so a balance carried over from world.ts no longer
  // follows the order it is printed in and the column does not tie. A statement whose
  // balance does not tie is not a realistic artefact, and it is exactly the kind of
  // plausible looking wrong number this project is about, so it would be a poor thing to
  // ship inside the corpus.
  //
  // A duplicated export row repeats its original balance rather than advancing it, which
  // is what a bank actually prints when the same transaction appears twice in an export,
  // and it gives deduplication a second signal beyond amount and narration.
  let running = fromDecimalString("250000.00", currency);
  const balances = new Map<number, Money>();
  statementRows.forEach((row, index) => {
    if (row.isDuplicate) {
      const original = statementRows.findIndex(
        (r, i) => i < index && r.bankTxnId === row.bankTxnId && !r.isDuplicate,
      );
      const priorBalance = balances.get(original);
      balances.set(index, priorBalance ?? running);
      return;
    }
    if (row.credit) running = add(running, row.credit);
    if (row.debit) running = subtract(running, row.debit);
    balances.set(index, running);
  });

  const emittedTruth: EmittedTruth[] = [];
  const firstRowOf = new Map<string, number>();
  const bankLines: string[] = [
    csvRow([
      "Sl No.",
      "Value Date",
      "Narration",
      "Chq/Ref No.",
      "Withdrawal Amt.",
      "Deposit Amt.",
      "Closing Balance",
    ]),
  ];

  statementRows.forEach((row, index) => {
    const slNo = index + 1;
    const creditCell = row.credit
      ? row.unitAmbiguous
        ? unitAmbiguousCell(row.credit)
        : amountCell(row.credit)
      : "";
    bankLines.push(
      csvRow([
        String(slNo),
        toBankFormat(row.date),
        row.narration,
        row.refNo,
        row.debit ? amountCell(row.debit) : "",
        creditCell,
        amountCell(balances.get(index) ?? row.balance),
      ]),
    );

    const entry = truthByTxn.get(row.bankTxnId);
    if (!entry) throw new Error(`no truth for ${row.bankTxnId}`);
    const duplicateOfRow = row.isDuplicate ? (firstRowOf.get(row.bankTxnId) ?? null) : null;
    if (!row.isDuplicate) firstRowOf.set(row.bankTxnId, slNo);

    emittedTruth.push({
      row: slNo,
      bankTxnId: row.bankTxnId,
      settlementId: entry.settlementId,
      settlementRowPresent:
        entry.settlementId !== null && !omittedSettlements.has(entry.settlementId),
      paymentIds: entry.paymentIds,
      faults: entry.faults,
      note: entry.note,
      duplicateOfRow,
    });
  });

  // the emitted statement must tie: opening + credits - debits = closing, over unique rows
  {
    const unique = statementRows.filter((r) => !r.isDuplicate);
    const credits = sum(unique.flatMap((r) => (r.credit ? [r.credit] : [])), currency);
    const debits = sum(unique.flatMap((r) => (r.debit ? [r.debit] : [])), currency);
    const opening = fromDecimalString("250000.00", currency);
    const expected = subtract(add(opening, credits), debits);
    const lastIndex = statementRows.reduce((acc, r, i) => (r.isDuplicate ? acc : i), -1);
    const closing = balances.get(lastIndex);
    if (!closing || !equals(expected, closing)) {
      throw new Error(
        `Emitted statement does not tie: expected closing ${toDecimalString(expected)}, got ${closing ? toDecimalString(closing) : "none"}`,
      );
    }
  }

  await writeFile(join(sourcesDir, "bank_statement.csv"), bankLines.join("\n") + "\n", "utf8");

  // -------------------------------------------------------------------------
  // settlements, with a share deliberately absent
  // -------------------------------------------------------------------------
  const settlementLines: string[] = [
    csvRow([
      "settlement_id",
      "utr",
      "settled_at",
      "currency",
      "gross_amount",
      "fee",
      "tax",
      "tds",
      "refunds",
      "net_amount",
    ]),
  ];
  for (const settlement of world.settlements) {
    if (omittedSettlements.has(settlement.id)) continue;
    settlementLines.push(
      csvRow([
        settlement.id,
        settlement.utr,
        settlement.settledAt,
        currency,
        amountCell(settlement.gross),
        amountCell(settlement.fee),
        amountCell(settlement.tax),
        amountCell(settlement.tds),
        amountCell(settlement.refundsDeducted),
        amountCell(settlement.net),
      ]),
    );
  }
  await writeFile(
    join(sourcesDir, "settlements.csv"),
    settlementLines.join("\n") + "\n",
    "utf8",
  );

  // -------------------------------------------------------------------------
  // payments. No settlement identifier, on purpose. See the header of world.ts
  // -------------------------------------------------------------------------
  const orderById = new Map(world.orders.map((o) => [o.id, o] as const));
  const paymentLines: string[] = [
    csvRow([
      "payment_id",
      "order_id",
      "captured_at",
      "method",
      "currency",
      "amount",
      "status",
      "customer_ref",
      "b2b",
    ]),
  ];
  const dupPayments = new Set(corruption.duplicatedPaymentIds);
  const emitPayment = (payment: (typeof world.payments)[number]): string => {
    const order = orderById.get(payment.orderId);
    const foreign = corruption.foreignPayments.get(payment.id);
    let reportedCurrency: string = currency;
    let reportedAmount = amountCell(payment.gross);
    if (foreign) {
      // the payment was taken abroad and settled to INR. The export reports the amount
      // the customer was charged, in their currency, and the rate lives elsewhere
      reportedCurrency = foreign.currency;
      const inverse = {
        from: currency,
        to: foreign.currency,
        numerator: foreign.rateDenominator,
        denominator: foreign.rateNumerator,
        source: "corpus",
      } as const;
      reportedAmount = amountCell(convert(payment.gross, inverse));
    }
    return csvRow([
      payment.id,
      payment.orderId,
      payment.capturedTs,
      payment.method,
      reportedCurrency,
      reportedAmount,
      payment.status,
      order?.customerRef ?? "",
      order?.b2b === true ? "true" : "false",
    ]);
  };
  for (const payment of world.payments) {
    paymentLines.push(emitPayment(payment));
    if (dupPayments.has(payment.id)) paymentLines.push(emitPayment(payment));
  }
  await writeFile(join(sourcesDir, "payments.csv"), paymentLines.join("\n") + "\n", "utf8");

  // -------------------------------------------------------------------------
  // refunds and orders
  // -------------------------------------------------------------------------
  const refundLines: string[] = [
    csvRow(["refund_id", "payment_id", "created_at", "currency", "amount"]),
  ];
  for (const refund of world.refunds) {
    refundLines.push(
      csvRow([refund.id, refund.paymentId, refund.createdAt, currency, amountCell(refund.amount)]),
    );
  }
  await writeFile(join(sourcesDir, "refunds.csv"), refundLines.join("\n") + "\n", "utf8");

  const orderLines: string[] = [
    csvRow(["order_id", "created_at", "customer_ref", "kind", "item_code", "currency", "gross", "b2b"]),
  ];
  for (const order of world.orders) {
    orderLines.push(
      csvRow([
        order.id,
        order.createdAt,
        order.customerRef,
        order.kind,
        order.itemCode,
        currency,
        amountCell(order.gross),
        order.b2b ? "true" : "false",
      ]),
    );
  }
  await writeFile(join(sourcesDir, "orders.csv"), orderLines.join("\n") + "\n", "utf8");

  // -------------------------------------------------------------------------
  // published exchange rates, with a few days deliberately absent
  // -------------------------------------------------------------------------
  const rateDates = [
    ...new Set(
      world.payments
        .filter((p) => corruption.foreignPayments.has(p.id))
        .map((p) => p.capturedAt),
    ),
  ].sort();
  const rateLines: string[] = [csvRow(["date", "from", "to", "numerator", "denominator", "source"])];
  for (const date of rateDates) {
    if (corruption.missingRateDates.has(date)) continue;
    for (const [from, num, den] of [
      ["USD", 8371n, 100n],
      ["EUR", 9042n, 100n],
      ["GBP", 10588n, 100n],
    ] as const) {
      rateLines.push(
        csvRow([date, from, currency, num.toString(), den.toString(), "corpus reference rate"]),
      );
    }
  }
  await writeFile(join(sourcesDir, "fx_rates.csv"), rateLines.join("\n") + "\n", "utf8");

  // -------------------------------------------------------------------------
  // manifest: declared row counts, checked at ingest. Failure class F07 is a manifest
  // that disagrees with the file, and the correct response is to refuse the run
  // -------------------------------------------------------------------------
  const counts = {
    bank_statement: bankLines.length - 1,
    settlements: settlementLines.length - 1,
    payments: paymentLines.length - 1,
    refunds: refundLines.length - 1,
    orders: orderLines.length - 1,
    fx_rates: rateLines.length - 1,
  };
  await writeFile(
    join(sourcesDir, "manifest.json"),
    JSON.stringify(
      {
        merchant: MERCHANT.name,
        gateway: GATEWAY_NAME,
        currency,
        declaredRowCounts: counts,
        note: "Row counts exclude the header. Ingest must verify these and refuse the run on a mismatch.",
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  // -------------------------------------------------------------------------
  // ground truth. NOT a source. The matcher must never read this file
  // -------------------------------------------------------------------------
  await writeFile(
    join(outDir, "truth.json"),
    JSON.stringify(
      {
        warning:
          "Ground truth. Read by the scorer only. Nothing under src/match may import this.",
        scoringRule:
          "PRIMARY: a bank transaction is decided correctly when the predicted payment set is VALUE EQUIVALENT to paymentIds, meaning the sorted multiset of (captureDate, currency, minorAmount) is equal, or when a transaction with an empty paymentIds is REFUSED. Payment identity is deliberately discarded because some payments in this corpus are genuinely interchangeable and no source file distinguishes them. SECONDARY: strict set equality by identity, which is reported only alongside strictCeilingPct, the expected strict accuracy of a perfect matcher. See docs/decisions/0005-value-equivalence-is-the-scoring-rule.md. Rows with duplicateOfRow set must be removed at ingest and are excluded from the matching scoreboard.",
        entries: emittedTruth,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );

  return { truth: emittedTruth, counts };
}

/** Used by the summary printer. */
export function formatMoney(amount: Money): string {
  return format(amount);
}
