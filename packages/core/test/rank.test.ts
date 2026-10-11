import { describe, expect, it } from "vitest";
import { KumiError, rankBetween, validateRank } from "../src";
import { makeRandom } from "./helpers";

describe("rankBetween", () => {
  it("starts a sequence with a stable first key", () => {
    expect(rankBetween(null, null)).toBe("a0");
  });

  it("produces a key strictly between its bounds", () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    const mid = rankBetween(a, b);
    expect(a < mid).toBe(true);
    expect(mid < b).toBe(true);
  });

  it("prepends before the first key", () => {
    const a = rankBetween(null, null);
    const before = rankBetween(null, a);
    expect(before < a).toBe(true);
  });

  it("rejects out-of-order bounds", () => {
    const a = rankBetween(null, null);
    const b = rankBetween(a, null);
    expect(() => rankBetween(b, a)).toThrowError(KumiError);
    expect(() => rankBetween(a, a)).toThrowError(KumiError);
  });

  it("rejects malformed keys", () => {
    for (const bad of ["", "!!", "0", "a", "a00"]) {
      expect(() => validateRank(bad), bad).toThrowError(KumiError);
    }
  });

  it("keeps appended keys short and ordered", () => {
    const keys: string[] = [];
    let last: string | null = null;
    for (let i = 0; i < 5000; i++) {
      last = rankBetween(last, null);
      keys.push(last);
    }
    expect(keys).toEqual([...keys].sort());
    const longest = Math.max(...keys.map((k) => k.length));
    expect(longest).toBeLessThanOrEqual(5);
  });

  it("keeps prepended keys short and ordered", () => {
    const keys: string[] = [];
    let first: string | null = null;
    for (let i = 0; i < 2000; i++) {
      first = rankBetween(null, first);
      keys.unshift(first);
    }
    expect(keys).toEqual([...keys].sort());
    expect(Math.max(...keys.map((k) => k.length))).toBeLessThanOrEqual(6);
  });

  it("stays ordered and bounded under thousands of random insertions", () => {
    const random = makeRandom(20260819);
    const list: string[] = [rankBetween(null, null)];
    for (let i = 0; i < 4000; i++) {
      const at = Math.floor(random() * (list.length + 1));
      const before = at === 0 ? null : (list[at - 1] ?? null);
      const after = at === list.length ? null : (list[at] ?? null);
      const key = rankBetween(before, after);
      validateRank(key);
      list.splice(at, 0, key);
    }
    expect(list).toEqual([...list].sort());
    expect(new Set(list).size).toBe(list.length);
    // Repeated midpointing grows keys logarithmically, not linearly.
    expect(Math.max(...list.map((k) => k.length))).toBeLessThan(40);
  });

  it("never exhausts precision when splitting the same gap repeatedly", () => {
    let low = rankBetween(null, null);
    const high = rankBetween(low, null);
    for (let i = 0; i < 500; i++) {
      const mid = rankBetween(low, high);
      expect(low < mid && mid < high).toBe(true);
      low = mid;
    }
  });
});
