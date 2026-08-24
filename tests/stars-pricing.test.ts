import { describe, it, expect } from "vitest";
import {
  decodeStarsRate,
  encodeStarsRate,
  minQtyForStars,
  perStarPrice,
  planStarsRepricing,
  priceForStars,
} from "../src/lib/domain/stars-pricing";

const RATE = { stars: 50, priceUzs: 13_000 }; // 260 сум за звезду

describe("perStarPrice", () => {
  it("divides the quoted price by the quoted amount", () => {
    expect(perStarPrice(RATE)).toBe(260);
  });
  it("refuses a nonsense rate instead of returning Infinity", () => {
    expect(perStarPrice({ stars: 0, priceUzs: 13_000 })).toBeNull();
    expect(perStarPrice({ stars: 50, priceUzs: 0 })).toBeNull();
    expect(perStarPrice({ stars: 50, priceUzs: NaN })).toBeNull();
  });
});

describe("priceForStars", () => {
  it("prices every pack from the one rate", () => {
    expect(priceForStars(50, RATE, 100)).toBe(13_000);
    expect(priceForStars(150, RATE, 100)).toBe(39_000);
    expect(priceForStars(250, RATE, 100)).toBe(65_000);
    expect(priceForStars(500, RATE, 100)).toBe(130_000);
    expect(priceForStars(1000, RATE, 100)).toBe(260_000);
  });

  it("keeps the quoted pack at exactly the quoted price", () => {
    // 12 345 / 50 = 246.9 — rounding would push the anchor to 12 400.
    const odd = { stars: 50, priceUzs: 12_345 };
    expect(priceForStars(50, odd, 100)).toBe(12_345);
  });

  it("rounds up, never down", () => {
    const odd = { stars: 50, priceUzs: 12_345 }; // 246.9 per star
    expect(priceForStars(100, odd, 100)).toBe(24_700); // 24 690 → 24 700
    expect(priceForStars(100, odd, 1000)).toBe(25_000);
    expect(priceForStars(100, odd, 1)).toBe(24_690);
  });

  it("never rounds the one-star carrier to the pack step", () => {
    // 260 → 300 would be a 15% surcharge on every custom order.
    expect(priceForStars(1, RATE, 100)).toBe(260);
    expect(priceForStars(1, RATE, 1000)).toBe(260);
    expect(priceForStars(1, { stars: 50, priceUzs: 12_345 }, 100)).toBe(247); // 246.9 → 247
  });

  it("returns 0 for an unusable input rather than a wrong price", () => {
    expect(priceForStars(0, RATE, 100)).toBe(0);
    expect(priceForStars(50, { stars: 0, priceUzs: 1 }, 100)).toBe(0);
  });
});

describe("planStarsRepricing", () => {
  const variants = [
    { id: 1, fragmentAmount: 1, priceUzs: 300 },
    { id: 2, fragmentAmount: 50, priceUzs: 12_000 },
    { id: 3, fragmentAmount: 150, priceUzs: 39_000 },
    { id: 4, fragmentAmount: 1000, priceUzs: 165_000 },
  ];

  it("moves every pack onto the new rate in one pass", () => {
    expect(planStarsRepricing(variants, RATE, 100)).toEqual([
      { id: 1, amount: 1, from: 300, to: 260 },
      { id: 2, amount: 50, from: 12_000, to: 13_000 },
      { id: 4, amount: 1000, from: 165_000, to: 260_000 },
    ]);
  });

  it("skips rows that already match, so an unchanged save writes nothing", () => {
    const already = planStarsRepricing(variants, RATE, 100);
    const applied = variants.map((v) => {
      const c = already.find((x) => x.id === v.id);
      return c ? { ...v, priceUzs: c.to } : v;
    });
    expect(planStarsRepricing(applied, RATE, 100)).toEqual([]);
  });

  it("ignores variants with no stars amount", () => {
    expect(planStarsRepricing([{ id: 9, fragmentAmount: 0, priceUzs: 1 }], RATE, 100)).toEqual([]);
  });

  it("does nothing at all on a bad rate", () => {
    expect(planStarsRepricing(variants, { stars: 50, priceUzs: -1 }, 100)).toEqual([]);
  });
});

describe("minQtyForStars", () => {
  it("lets a 50-pack be bought singly", () => {
    expect(minQtyForStars(50, 50)).toBe(1);
    expect(minQtyForStars(150, 50)).toBe(1);
  });
  it("holds the one-star carrier at the supplier floor", () => {
    expect(minQtyForStars(1, 50)).toBe(50);
  });
  it("rounds up for an awkward pack size", () => {
    expect(minQtyForStars(20, 50)).toBe(3); // 60 stars — 40 would be refused
  });
});

describe("rate round-trip through settings", () => {
  it("survives storage", () => {
    expect(decodeStarsRate(encodeStarsRate(RATE, 100))).toEqual({ rate: RATE, step: 100 });
  });
  it("returns null on junk instead of a broken rate", () => {
    expect(decodeStarsRate("")).toBeNull();
    expect(decodeStarsRate("abc")).toBeNull();
    expect(decodeStarsRate("0:13000:100")).toBeNull();
  });
  it("falls back to a sane step when it is missing", () => {
    expect(decodeStarsRate("50:13000")).toEqual({ rate: RATE, step: 100 });
  });
});
