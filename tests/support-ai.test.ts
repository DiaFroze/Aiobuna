import { describe, it, expect } from "vitest";
import {
  detectMessageLanguage,
  isPureGreeting,
  quickGreetingReply,
  isCooperationQuery,
  isPaymentIssueQuery,
  isPaymentProofQuery,
  isUnclearQuery,
  isEscalationQuery,
  directEscalationReply,
  unclearQueryReply,
  fallbackSupportReply,
  redactSupportText,
  cleanSupportReply,
} from "../src/lib/domain/support-ai";

describe("Support AI Domain Logic", () => {
  describe("Language Detection", () => {
    it("detects Uzbek Latin for greetings and shopping requests", () => {
      expect(detectMessageLanguage("salom")).toBe("uz");
      expect(detectMessageLanguage("Assalomu alaykum")).toBe("uz");
      expect(detectMessageLanguage("assalomu aleykum!")).toBe("uz");
      expect(detectMessageLanguage("Gemini kerak edi")).toBe("uz");
      expect(detectMessageLanguage("Qanday sotib olaman?")).toBe("uz");
      expect(detectMessageLanguage("Gemini bormi? Narxi qancha?")).toBe("uz");
      expect(detectMessageLanguage("Sotib olmoqchiman")).toBe("uz");
    });

    it("detects Russian for Cyrillic messages", () => {
      expect(detectMessageLanguage("привет")).toBe("ru");
      expect(detectMessageLanguage("здравствуйте")).toBe("ru");
      expect(detectMessageLanguage("Как купить Gemini?")).toBe("ru");
      expect(detectMessageLanguage("Хочу сотрудничество")).toBe("ru");
      expect(detectMessageLanguage("Оплата не прошла")).toBe("ru");
    });

    it("detects English for English messages", () => {
      expect(detectMessageLanguage("hello")).toBe("en");
      expect(detectMessageLanguage("how can I buy?")).toBe("en");
      expect(detectMessageLanguage("How can I buy Gemini?")).toBe("en");
      expect(detectMessageLanguage("What is the price of Gemini?")).toBe("en");
    });

    it("handles Uzbek Cyrillic gracefully", () => {
      expect(detectMessageLanguage("Салом, менга Gemini керак эди")).toBe("uz");
      expect(detectMessageLanguage("Қандай сотиб олсам бўлади?")).toBe("uz");
    });

    it("uses fallback for ambiguous or non-text input", () => {
      expect(detectMessageLanguage("???", "ru")).toBe("ru");
      expect(detectMessageLanguage("12345", "uz")).toBe("uz");
      expect(detectMessageLanguage("", "uz")).toBe("uz");
    });
  });

  describe("Fast Greetings", () => {
    it("recognizes pure greetings without questions", () => {
      expect(isPureGreeting("salom")).toBe(true);
      expect(isPureGreeting("Assalomu alaykum")).toBe(true);
      expect(isPureGreeting("Assalomu alaykum!")).toBe(true);
      expect(isPureGreeting("привет")).toBe(true);
      expect(isPureGreeting("Здравствуйте!")).toBe(true);
      expect(isPureGreeting("hello")).toBe(true);
      expect(isPureGreeting("hi!")).toBe(true);
      expect(isPureGreeting("salom aka")).toBe(true);
    });

    it("does NOT classify messages with purchase intent as pure greetings", () => {
      expect(isPureGreeting("Assalomu alaykum, Gemini kerak edi")).toBe(false);
      expect(isPureGreeting("salom narxi qancha")).toBe(false);
      expect(isPureGreeting("привет, как купить?")).toBe(false);
      expect(isPureGreeting("hello how much is Gemini")).toBe(false);
      expect(isPureGreeting("Gemini kerak edi")).toBe(false);
      expect(isPureGreeting("Qanday sotib olaman?")).toBe(false);
    });

    it("provides natural fast greeting replies without Gemini", () => {
      expect(quickGreetingReply("salom", "uz")).toContain("Assalomu alaykum");
      expect(quickGreetingReply("Assalomu alaykum", "uz")).toContain("Va alaykum assalom");
      expect(quickGreetingReply("привет", "ru")).toContain("Привет");
      expect(quickGreetingReply("здравствуйте", "ru")).toContain("Здравствуйте");
      expect(quickGreetingReply("hello", "en")).toContain("Hi");
      expect(quickGreetingReply("Gemini kerak edi", "uz")).toBeNull();
    });
  });

  describe("Escalation & Admin Transfer", () => {
    const admin = "Abdulloh_Zokirov";

    it("identifies cooperation queries", () => {
      expect(isCooperationQuery("Хочу сотрудничество")).toBe(true);
      expect(isCooperationQuery("Hamkorlik qilmoqchiman")).toBe(true);
      expect(isCooperationQuery("We want wholesale partnership")).toBe(true);
      expect(isCooperationQuery("Gemini kerak edi")).toBe(false);
    });

    it("identifies payment issues while keeping general payment method questions safe", () => {
      expect(isPaymentIssueQuery("Оплата не прошла")).toBe(true);
      expect(isPaymentIssueQuery("Деньги списались но подписка не пришла")).toBe(true);
      expect(isPaymentIssueQuery("To'lov o'tmadi")).toBe(true);
      expect(isPaymentIssueQuery("Pul yechildi lekin kelmadi")).toBe(true);
      expect(isPaymentIssueQuery("Хочу возврат")).toBe(true);

      // General questions must NOT trigger payment dispute escalation
      expect(isPaymentIssueQuery("Как оплатить?")).toBe(false);
      expect(isPaymentIssueQuery("Какие способы оплаты доступны?")).toBe(false);
      expect(isPaymentIssueQuery("To'lov qanday bo'ladi?")).toBe(false);
      expect(isPaymentIssueQuery("Qanday to'lov qilsam bo'ladi?")).toBe(false);
      expect(isPaymentIssueQuery("How to pay?")).toBe(false);
    });

    it("identifies payment proof and receipt messages", () => {
      expect(isPaymentProofQuery("чек 39000")).toBe(true);
      expect(isPaymentProofQuery("чек")).toBe(true);
      expect(isPaymentProofQuery("вот чек")).toBe(true);
      expect(isPaymentProofQuery("оплатил")).toBe(true);
      expect(isPaymentProofQuery("оплатила")).toBe(true);
      expect(isPaymentProofQuery("перевёл")).toBe(true);
      expect(isPaymentProofQuery("to'ladim")).toBe(true);
      expect(isPaymentProofQuery("mana chek")).toBe(true);
      expect(isPaymentProofQuery("чек скинул")).toBe(true);
      expect(isPaymentProofQuery("нужен ли чек?")).toBe(false);
      expect(isPaymentProofQuery("чек kerakmi")).toBe(false);
    });

    it("identifies unclear queries", () => {
      expect(isUnclearQuery("???")).toBe(true);
      expect(isUnclearQuery("...")).toBe(true);
      expect(isUnclearQuery(" ")).toBe(true);
      expect(isUnclearQuery("a")).toBe(true);
      expect(isUnclearQuery("Gemini")).toBe(false);
    });

    it("provides direct escalation replies with cooperation handle or direct receipt request", () => {
      const coopHandle = "Abdulloh_ZokirovN";
      const coopUz = directEscalationReply("Hamkorlik qilmoqchiman", "uz", coopHandle);
      expect(coopUz).toContain("@" + coopHandle);
      expect(coopUz).toContain("Hamkorlik");

      const coopRu = directEscalationReply("Хочу сотрудничество", "ru", coopHandle);
      expect(coopRu).toContain("@" + coopHandle);
      expect(coopRu).toContain("сотрудничества");

      const payRu = directEscalationReply("Оплата не прошла", "ru");
      expect(payRu).toContain("чек");
      expect(payRu).toContain("прямо сюда в чат");

      const payUz = directEscalationReply("To'lov o'tmadi", "uz");
      expect(payUz).toContain("chek");
      expect(payUz).toContain("shu yerga");

      const proofRu = directEscalationReply("чек 39000", "ru");
      expect(proofRu).toContain("Чек принят на ручную проверку");
      expect(proofRu).toContain("Абдуллох");

      const proofUz = directEscalationReply("to'ladim", "uz");
      expect(proofUz).toContain("Chek qabul qilindi");
    });

    it("handles unclear query responses in first person", () => {
      const respUz = unclearQueryReply("uz");
      expect(respUz).toContain("aniqroq");

      const respRu = unclearQueryReply("ru");
      expect(respRu).toContain("Уточните");
    });

    it("provides natural fallback reply in first person", () => {
      const fb = fallbackSupportReply("uz");
      expect(fb).toContain("tezda javob");

      const fbRu = fallbackSupportReply("ru");
      expect(fbRu).toContain("скоро отвечу");
    });

    it("escalates if AI response indicates uncertainty", () => {
      expect(isEscalationQuery("Как сделать?", "К сожалению, я не уверен в этом вопросе.")).toBe(true);
      expect(isEscalationQuery("Как сделать?", "Вот подробная инструкция:")).toBe(false);
    });
  });

  describe("PII Redaction & Sanitization", () => {
    it("redacts emails, passwords, cards, phones, and URLs", () => {
      const input =
        "Mening telefonim +998901234567, karta 8600 1234 5678 9012, email user@gmail.com va parol: MySecret123. Link: https://example.com/login";
      const redacted = redactSupportText(input);

      expect(redacted).not.toContain("+998901234567");
      expect(redacted).not.toContain("8600 1234 5678 9012");
      expect(redacted).not.toContain("user@gmail.com");
      expect(redacted).not.toContain("MySecret123");
      expect(redacted).not.toContain("https://example.com/login");

      expect(redacted).toContain("[phone]");
      expect(redacted).toContain("[card]");
      expect(redacted).toContain("[email]");
      expect(redacted).toContain("[secret]");
      expect(redacted).toContain("[link]");
    });

    it("cleans LLM role prefixes and quotes", () => {
      expect(cleanSupportReply("Помощник: Здравствуйте! Вот ответ.")).toBe("Здравствуйте! Вот ответ.");
      expect(cleanSupportReply("Клиент: Как купить?")).toBe("Как купить?");
      expect(cleanSupportReply("Assistant: Here is the price.")).toBe("Here is the price.");
      expect(cleanSupportReply('"Gemini AI Pro 18 oylik obunasi bor"')).toBe("Gemini AI Pro 18 oylik obunasi bor");
    });
  });
});
