/**
 * Decimal rounding that matches Python's, so the dashboard, the CSV and the
 * workbook all agree with the reference implementation to the last digit.
 *
 * `Math.round` and `toFixed` break ties away from zero; Python's `round()` and
 * its `:.2f` format break them toward the even digit. That is not academic --
 * an account totalling 8,895 in-budget minutes is 148.25 hours, and the two
 * rules disagree about whether that reads 148.2 or 148.3.
 *
 * Both work from the decimal expansion rather than by scaling, because scaling
 * introduces its own error: `14.825 * 100` is 1482.5000000000002 in binary, so
 * it looks like a tie that should round up when the underlying value is
 * actually a hair below the midpoint and must round down.
 */

/** Digits kept, and whether the discarded tail rounds them up. */
function split(abs: number, digits: number): [kept: string, up: boolean] {
  // 20 extra digits is far more than enough to tell an exact tie (which
  // terminates in 5 followed by zeros) from a value merely close to one.
  const s = abs.toFixed(Math.min(100, digits + 20));
  const dot = s.indexOf('.');
  const all = s.slice(0, dot) + s.slice(dot + 1);
  const cut = dot + digits;
  const kept = all.slice(0, cut);
  const rest = all.slice(cut);

  let up: boolean;
  if (rest[0] > '5') up = true;
  else if (rest[0] < '5') up = false;
  else if (/[1-9]/.test(rest.slice(1))) up = true;
  else up = (kept.charCodeAt(cut - 1) - 48) % 2 === 1; // an exact tie: go even
  return [kept, up];
}

/** Python's `round(value, digits)`. */
export function round(value: number, digits = 0): number {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) return value;
  const [kept, up] = split(Math.abs(value), digits);
  const magnitude = (Number(kept) + (up ? 1 : 0)) / 10 ** digits;
  return value < 0 ? -magnitude : magnitude;
}

/** Python's `f"{value:.Nf}"`. */
export function toFixed(value: number, digits: number): string {
  if (!Number.isFinite(value) || Math.abs(value) >= 1e21) return value.toFixed(digits);
  const [kept, up] = split(Math.abs(value), digits);
  const scaled = (BigInt(kept) + (up ? 1n : 0n)).toString().padStart(digits + 1, '0');
  const body = digits ? `${scaled.slice(0, -digits)}.${scaled.slice(-digits)}` : scaled;
  return (value < 0 ? '-' : '') + body;
}

/** Python's `f"{value:.0%}"`. */
export const toPercent = (value: number): string => `${toFixed(value * 100, 0)}%`;
