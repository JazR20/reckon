/**
 * Date arithmetic for the corpus.
 *
 * Everything is a plain YYYY-MM-DD string held in UTC. There is no local timezone
 * anywhere in the generator, because a corpus that regenerates differently depending on
 * the machine that ran it is not a corpus.
 *
 * The current clock is never read. Every date derives from a configured period.
 */

export type IsoDate = string & { readonly __isoDate?: unique symbol };

const DAY_MS = 86_400_000;

export function isoDate(year: number, month: number, day: number): IsoDate {
  return toIso(Date.UTC(year, month - 1, day));
}

export function toIso(epochMs: number): IsoDate {
  const d = new Date(epochMs);
  const y = d.getUTCFullYear().toString().padStart(4, "0");
  const m = (d.getUTCMonth() + 1).toString().padStart(2, "0");
  const day = d.getUTCDate().toString().padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function toEpoch(date: IsoDate): number {
  const parts = date.split("-");
  const y = Number(parts[0]);
  const m = Number(parts[1]);
  const d = Number(parts[2]);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) {
    throw new Error(`Not an ISO date: ${date}`);
  }
  return Date.UTC(y, m - 1, d);
}

export function addDays(date: IsoDate, days: number): IsoDate {
  return toIso(toEpoch(date) + days * DAY_MS);
}

export function daysBetween(a: IsoDate, b: IsoDate): number {
  return Math.round((toEpoch(b) - toEpoch(a)) / DAY_MS);
}

export function compareDates(a: IsoDate, b: IsoDate): number {
  return toEpoch(a) - toEpoch(b);
}

/** 0 is Sunday, 6 is Saturday. */
export function weekday(date: IsoDate): number {
  return new Date(toEpoch(date)).getUTCDay();
}

export function isWeekend(date: IsoDate): boolean {
  const d = weekday(date);
  return d === 0 || d === 6;
}

/**
 * A representative set of non working days for the corpus period.
 *
 * These are synthetic. The exact calendar is not the point. What matters for failure
 * class F05 is that clusters of non working days exist, so that settlement dates bunch
 * up after them and payments taken on consecutive days settle on the same day.
 */
export const BANK_HOLIDAYS: readonly IsoDate[] = [
  isoDate(2026, 4, 3),
  isoDate(2026, 4, 14),
  isoDate(2026, 5, 1),
  isoDate(2026, 5, 25),
  isoDate(2026, 6, 17),
];

const HOLIDAY_SET = new Set<string>(BANK_HOLIDAYS);

export function isWorkingDay(date: IsoDate): boolean {
  return !isWeekend(date) && !HOLIDAY_SET.has(date);
}

/** Advance by n working days, skipping weekends and the holiday set. */
export function addWorkingDays(date: IsoDate, n: number): IsoDate {
  let cursor = date;
  let remaining = n;
  let guard = 0;
  while (remaining > 0) {
    cursor = addDays(cursor, 1);
    if (isWorkingDay(cursor)) remaining--;
    if (++guard > 400) throw new Error("addWorkingDays: runaway");
  }
  return cursor;
}

/** Every date in the inclusive range. */
export function eachDay(from: IsoDate, to: IsoDate): IsoDate[] {
  const out: IsoDate[] = [];
  let cursor = from;
  let guard = 0;
  while (compareDates(cursor, to) <= 0) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
    if (++guard > 4000) throw new Error("eachDay: runaway");
  }
  return out;
}

/** DD-MM-YYYY, the format most Indian bank statement exports use. */
export function toBankFormat(date: IsoDate): string {
  const [y, m, d] = date.split("-");
  return `${d}-${m}-${y}`;
}

/**
 * An RFC3339 timestamp at a given hour, for gateway records which carry a time.
 * Minutes and seconds are derived from the hour so the value stays deterministic.
 */
export function toTimestamp(date: IsoDate, hour: number, minuteSeed: number): string {
  const minute = minuteSeed % 60;
  const second = (minuteSeed * 7) % 60;
  const hh = hour.toString().padStart(2, "0");
  const mm = minute.toString().padStart(2, "0");
  const ss = second.toString().padStart(2, "0");
  return `${date}T${hh}:${mm}:${ss}+05:30`;
}
