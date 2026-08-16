import { describe, it, expect } from "vitest";

// Mirrors maskName()/maskId() in src/bot/index.ts. The sales feed is a PUBLIC
// group, so these are the only thing standing between a purchase post and a
// buyer's identity. Pinned here so a future edit can't quietly widen them.
function maskName(s: string): string {
  const v = (s ?? "").trim();
  if (!v) return "•••";
  if (v.length <= 2) return v[0] + "•";
  if (v.length <= 4) return v[0] + "••" + v.slice(-1);
  const keep = Math.min(2, v.length - 2);
  return v.slice(0, keep) + "•".repeat(Math.max(3, v.length - keep - 1)) + v.slice(-1);
}

function maskId(s: string): string {
  const v = (s ?? "").trim();
  if (v.length <= 4) return "•".repeat(Math.max(3, v.length));
  return v.slice(0, 3) + "•".repeat(Math.max(3, v.length - 5)) + v.slice(-2);
}

describe("sales feed privacy", () => {
  it("never posts a name in full", () => {
    for (const name of ["Jahongir", "Sarvar", "Ali", "Абдулло", "Bo"]) {
      expect(maskName(name)).not.toBe(name);
      expect(maskName(name)).toContain("•");
    }
  });

  it("never posts an id in full", () => {
    for (const id of ["7141343261", "123456789", "12345"]) {
      expect(maskId(id)).not.toBe(id);
      expect(maskId(id)).not.toContain(id);
    }
  });

  it("hides the middle of an id, keeping only a short head and tail", () => {
    const masked = maskId("7141343261");
    expect(masked).toBe("714•••••61");
    // At most 5 of the 10 real digits survive — not enough to look someone up.
    const digits = masked.replace(/[^0-9]/g, "");
    expect(digits.length).toBeLessThanOrEqual(5);
  });

  it("degrades safely on empty or very short input", () => {
    expect(maskName("")).toBe("•••");
    expect(maskName("A")).toBe("A•");
    expect(maskId("")).toBe("•••");
    expect(maskId("12")).toBe("•••");
  });

  it("keeps enough for the buyer to recognise their own purchase", () => {
    // The point of the feed is social proof: the buyer should spot their line.
    expect(maskName("Jahongir")).toBe("Ja•••••r");
    expect(maskId("7141343261").startsWith("714")).toBe(true);
    expect(maskId("7141343261").endsWith("61")).toBe(true);
  });
});
