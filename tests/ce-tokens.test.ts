import { describe, it, expect } from "vitest";
import {
  extractCeTokens,
  primaryCeCode,
  replaceCeTokensForPublic,
} from "@/lib/emoji/ce-tokens";

const sample =
  "{ce:5278711610775457808} <b>18 Months Plan</b>\n" +
  "{ce:5240241223632954241} <b>Non Warranty</b>\n" +
  "{ce:5350619413533958825:⚡} <b>Grok Account</b>";

describe("extractCeTokens", () => {
  it("keeps long numeric codes as strings (no precision loss)", () => {
    const tokens = extractCeTokens(sample);
    expect(tokens[0].code).toBe("5278711610775457808");
    expect(typeof tokens[0].code).toBe("string");
    // JS Number would corrupt this — prove the string differs from Number()
    expect(tokens[0].code).not.toBe(String(Number("5278711610775457808")));
  });

  it("captures optional fallback char", () => {
    const tokens = extractCeTokens(sample);
    expect(tokens[2]).toEqual({ code: "5350619413533958825", fallback: "⚡" });
    expect(tokens[0].fallback).toBeNull();
  });

  it("returns [] for empty", () => {
    expect(extractCeTokens(null)).toEqual([]);
  });
});

describe("primaryCeCode", () => {
  it("returns the first token", () => {
    expect(primaryCeCode(sample)?.code).toBe("5278711610775457808");
  });
});

describe("replaceCeTokensForPublic", () => {
  it("drops code-only tokens and keeps fallback chars", () => {
    const out = replaceCeTokensForPublic(sample);
    expect(out).not.toContain("{ce:");
    expect(out).toContain("⚡");
    expect(out).toContain("18 Months Plan");
  });
});
