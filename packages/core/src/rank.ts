/**
 * Fractional indexing over a base-62 digit set.
 *
 * A rank is `<integer part><fraction>`:
 *   - the integer part starts with a magnitude head — `a`..`z` for lengths
 *     2..27 (non-negative) and `A`..`Z` for lengths 27..2 (negative) — so
 *     ranks of different magnitudes still compare correctly as plain strings;
 *   - the fraction is an arbitrary-length base-62 tail with no trailing `0`,
 *     which is what makes the space inexhaustible: when two neighbours are
 *     adjacent, another digit is appended instead of running out of room.
 *
 * Consequences that matter for callers:
 *   - `rankBetween(null, null)` is always `"a0"`;
 *   - repeated appends (`rankBetween(last, null)`) walk the integer part, so
 *     sequential inserts stay short (one extra char per 62 appends);
 *   - all comparisons are plain lexicographic (`<`), matching SQLite's default
 *     `BINARY` collation on `TEXT`.
 */

import { KumiError } from "./errors";

const DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const BASE = DIGITS.length;
const ZERO = "0";
const TOP = "z";
/** The first rank ever generated when the sequence is empty. */
export const INTEGER_ZERO = "a0";
/** Lower bound of the integer space; never a valid stored rank. */
const SMALLEST_INTEGER = "A" + ZERO.repeat(26);

function bad(message: string): KumiError {
  return new KumiError("invalid", message);
}

function digitValue(ch: string): number {
  const v = DIGITS.indexOf(ch);
  if (v < 0) throw bad(`invalid rank digit ${JSON.stringify(ch)}`);
  return v;
}

function digitChar(v: number): string {
  const ch = DIGITS[v];
  if (ch === undefined) throw bad(`rank digit out of range: ${v}`);
  return ch;
}

function head(key: string): string {
  const ch = key[0];
  if (ch === undefined) throw bad("empty rank");
  return ch;
}

/** Total length of the integer part implied by its head character. */
function integerLength(h: string): number {
  if (h >= "a" && h <= "z") return h.charCodeAt(0) - 97 + 2;
  if (h >= "A" && h <= "Z") return 90 - h.charCodeAt(0) + 2;
  throw bad(`invalid rank head ${JSON.stringify(h)}`);
}

function validateInteger(int: string): void {
  if (int.length !== integerLength(head(int))) {
    throw bad(`invalid rank integer part: ${int}`);
  }
  for (let i = 1; i < int.length; i++) digitValue(int.charAt(i));
}

function integerPart(key: string): string {
  const len = integerLength(head(key));
  if (len > key.length) throw bad(`invalid rank: ${key}`);
  return key.slice(0, len);
}

/** Throws unless `key` is a well-formed rank produced by this module. */
export function validateRank(key: string): void {
  if (key === SMALLEST_INTEGER) throw bad(`invalid rank: ${key}`);
  const int = integerPart(key);
  validateInteger(int);
  const fraction = key.slice(int.length);
  if (fraction.endsWith(ZERO)) throw bad(`rank has a trailing zero: ${key}`);
  for (const ch of fraction) digitValue(ch);
}

function incrementInteger(int: string): string | null {
  validateInteger(int);
  const h = head(int);
  const digits = int.slice(1).split("");
  let carry = true;
  for (let i = digits.length - 1; carry && i >= 0; i--) {
    const next = digitValue(digits[i] ?? ZERO) + 1;
    if (next === BASE) {
      digits[i] = ZERO;
    } else {
      digits[i] = digitChar(next);
      carry = false;
    }
  }
  if (carry) {
    if (h === "Z") return "a" + ZERO;
    if (h === "z") return null;
    const nextHead = String.fromCharCode(h.charCodeAt(0) + 1);
    if (nextHead > "a") digits.push(ZERO);
    else digits.pop();
    return nextHead + digits.join("");
  }
  return h + digits.join("");
}

function decrementInteger(int: string): string | null {
  validateInteger(int);
  const h = head(int);
  const digits = int.slice(1).split("");
  let borrow = true;
  for (let i = digits.length - 1; borrow && i >= 0; i--) {
    const next = digitValue(digits[i] ?? ZERO) - 1;
    if (next === -1) {
      digits[i] = TOP;
    } else {
      digits[i] = digitChar(next);
      borrow = false;
    }
  }
  if (borrow) {
    if (h === "a") return "Z" + TOP;
    if (h === "A") return null;
    const nextHead = String.fromCharCode(h.charCodeAt(0) - 1);
    if (nextHead < "Z") digits.push(TOP);
    else digits.pop();
    return nextHead + digits.join("");
  }
  return h + digits.join("");
}

/**
 * A fraction strictly between `a` and `b` (both fractions, `b === null` meaning
 * "1.0"), never with a trailing zero and never longer than it has to be.
 */
function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) {
    throw bad(`rank fraction bounds out of order: ${a} >= ${b}`);
  }
  if (b !== null) {
    let n = 0;
    while ((a[n] ?? ZERO) === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const digitA = a === "" ? 0 : digitValue(a.charAt(0));
  const digitB = b === null ? BASE : digitValue(b.charAt(0));
  if (digitB - digitA > 1) {
    return digitChar(Math.round(0.5 * (digitA + digitB)));
  }
  // The leading digits are adjacent: borrow from the upper bound if it has more
  // to give, otherwise keep `a`'s digit and recurse one place deeper.
  if (b !== null && b.length > 1) return b.slice(0, 1);
  return digitChar(digitA) + midpoint(a.slice(1), null);
}

/**
 * Generate a rank strictly between `a` and `b`.
 *
 * `null` means "unbounded": `rankBetween(null, x)` prepends before `x`,
 * `rankBetween(x, null)` appends after `x`, `rankBetween(null, null)` starts a
 * fresh sequence.
 *
 * @throws KumiError `invalid` when either bound is malformed or `a >= b`.
 */
export function rankBetween(a: string | null, b: string | null): string {
  if (a !== null) validateRank(a);
  if (b !== null) validateRank(b);
  if (a !== null && b !== null && a >= b) {
    throw bad(`rank bounds out of order: ${a} >= ${b}`);
  }

  if (a === null) {
    if (b === null) return INTEGER_ZERO;
    const intB = integerPart(b);
    const fracB = b.slice(intB.length);
    if (intB === SMALLEST_INTEGER) return intB + midpoint("", fracB);
    if (intB < b) return intB;
    const decremented = decrementInteger(intB);
    if (decremented === null) throw bad("rank space exhausted below");
    return decremented;
  }

  const intA = integerPart(a);
  const fracA = a.slice(intA.length);

  if (b === null) {
    const incremented = incrementInteger(intA);
    return incremented === null ? intA + midpoint(fracA, null) : incremented;
  }

  const intB = integerPart(b);
  const fracB = b.slice(intB.length);
  if (intA === intB) return intA + midpoint(fracA, fracB);

  const incremented = incrementInteger(intA);
  if (incremented === null) throw bad("rank space exhausted above");
  if (incremented < b) return incremented;
  return intA + midpoint(fracA, null);
}
