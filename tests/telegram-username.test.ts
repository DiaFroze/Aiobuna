import { describe, it, expect } from "vitest";
import { checkUsername, normalizeUsername } from "../src/lib/domain/telegram-username";

describe("normalizeUsername", () => {
  it("strips the decorations people actually paste", () => {
    for (const input of [
      "durov",
      "@durov",
      "t.me/durov",
      "https://t.me/durov",
      "https://www.t.me/durov",
      "telegram.me/durov",
      "  @durov  ",
      "t.me/durov/",
    ]) {
      expect(normalizeUsername(input)).toBe("durov");
    }
  });

  it("survives empty and junk input", () => {
    expect(normalizeUsername("")).toBe("");
    expect(normalizeUsername("   ")).toBe("");
    expect(normalizeUsername("@")).toBe("");
  });
});

describe("checkUsername", () => {
  it("accepts a normal username", () => {
    expect(checkUsername("@durov_official")).toEqual({ ok: true, username: "durov_official" });
    expect(checkUsername("Jahongir99")).toEqual({ ok: true, username: "Jahongir99" });
  });

  it("rejects the length limits Telegram enforces", () => {
    expect(checkUsername("abcd")).toEqual({ ok: false, reason: "short" });
    expect(checkUsername("a".repeat(33))).toEqual({ ok: false, reason: "long" });
    expect(checkUsername("abcde").ok).toBe(true);
    expect(checkUsername("a".repeat(32)).ok).toBe(true);
  });

  it("rejects a name that does not start with a letter", () => {
    expect(checkUsername("1durov")).toEqual({ ok: false, reason: "start" });
    expect(checkUsername("_durov")).toEqual({ ok: false, reason: "start" });
  });

  it("rejects underscores Telegram itself would reject", () => {
    expect(checkUsername("durov_")).toEqual({ ok: false, reason: "end" });
    expect(checkUsername("du__rov")).toEqual({ ok: false, reason: "double" });
  });

  it("rejects anything outside latin letters, digits and underscore", () => {
    // Cyrillic look-alikes are the realistic typo here — «а» is not "a", and
    // sending Stars to a name that does not exist is money gone.
    expect(checkUsername("durоv")).toEqual({ ok: false, reason: "chars" });
    expect(checkUsername("my name")).toEqual({ ok: false, reason: "chars" });
    expect(checkUsername("user-name")).toEqual({ ok: false, reason: "chars" });
    expect(checkUsername("user.name")).toEqual({ ok: false, reason: "chars" });
    expect(checkUsername("Жахонгир")).toEqual({ ok: false, reason: "chars" });
  });

  it("rejects empty input", () => {
    expect(checkUsername("")).toEqual({ ok: false, reason: "empty" });
    expect(checkUsername("@")).toEqual({ ok: false, reason: "empty" });
  });

  it("never returns ok with a leading @ still attached", () => {
    const r = checkUsername("@durov");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.username.startsWith("@")).toBe(false);
  });
});
