import { describe, it, expect } from "vitest";
import { fitCaption } from "@/lib/emoji/rich-text";

describe("fitCaption HTML truncator for Telegram media captions", () => {
  it("leaves strings shorter than or equal to maxLen unchanged", () => {
    const text = "<b>Hello</b> world!";
    expect(fitCaption(text, 1024)).toBe(text);
    expect(fitCaption(text, text.length)).toBe(text);
    expect(fitCaption("", 1024)).toBe("");
  });

  it("truncates plain text and adds ellipsis while not exceeding maxLen", () => {
    const text = "1234567890abcdefghijklmnopqrstuvwxyz";
    const res = fitCaption(text, 15);
    expect(res.length).toBeLessThanOrEqual(15);
    expect(res.endsWith("...")).toBe(true);
  });

  it("safely closes open HTML tags when truncating", () => {
    const text = "<b>Important: <i>This is a very long text with details</i> and more</b>";
    const res = fitCaption(text, 35);
    expect(res.length).toBeLessThanOrEqual(35);
    expect(res.endsWith("</i></b>") || res.endsWith("</b>")).toBe(true);

    // Verify tag balance: <b> matches </b>, <i> matches </i>
    const bOpen = (res.match(/<b>/g) || []).length;
    const bClose = (res.match(/<\/b>/g) || []).length;
    expect(bOpen).toBe(bClose);

    const iOpen = (res.match(/<i>/g) || []).length;
    const iClose = (res.match(/<\/i>/g) || []).length;
    expect(iOpen).toBe(iClose);
  });

  it("safely closes custom emoji and link tags without cutting attribute values", () => {
    const text = 'Check out <tg-emoji emoji-id="5278711610775457808">✨</tg-emoji> and <a href="https://example.com/long-url-path">our link</a> here';
    const res = fitCaption(text, 65);
    expect(res.length).toBeLessThanOrEqual(65);

    const tgOpen = (res.match(/<tg-emoji[^>]*>/g) || []).length;
    const tgClose = (res.match(/<\/tg-emoji>/g) || []).length;
    expect(tgOpen).toBe(tgClose);

    const aOpen = (res.match(/<a[^>]*>/g) || []).length;
    const aClose = (res.match(/<\/a>/g) || []).length;
    expect(aOpen).toBe(aClose);
  });

  it("handles HTML entities properly without breaking &amp; in half", () => {
    const text = "Ben &amp; Jerry &amp; friends &amp; family";
    const res = fitCaption(text, 15);
    expect(res.length).toBeLessThanOrEqual(15);
    expect(res.includes("&amp;")).toBe(true);
    expect(res).not.toMatch(/&[a-z]*$/); // No half-cut entity at the end
  });

  it("strictly guarantees <= 1024 characters for very large text", () => {
    const text = `<b>${"A".repeat(800)}</b> <i>${"B".repeat(800)}</i>`;
    const res = fitCaption(text, 1024);
    expect(res.length).toBeLessThanOrEqual(1024);
    expect(res.endsWith("</b>") || res.endsWith("</i>")).toBe(true);
  });
});
