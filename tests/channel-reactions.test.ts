import { describe, it, expect, vi } from "vitest";
import {
  handleMessageReactionCountUpdate,
  launchConfiguredNextPromo,
  transitionPromoToTeaser,
} from "../src/lib/services/channel-reactions";

describe("Channel Reactions Service", () => {
  it("ignores reactions when no campaign is waiting", async () => {
    const mockDb = {
      channelPromoCampaign: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    };

    const res = await handleMessageReactionCountUpdate(mockDb, {}, {
      chat: { id: -1001234567 },
      message_id: 999,
      reactions: [{ type: { type: "emoji", emoji: "🔥" }, total_count: 12 }],
    });

    expect(res.reached).toBe(false);
    expect(res.launched).toBe(false);
  });

  it("updates count and auto-launches next promo when reaction threshold is reached", async () => {
    let state = "waiting_reactions";
    let channelMessageText = "";

    const campaign = {
      id: 1,
      channelId: "-1001234567",
      messageId: 500,
      state: "waiting_reactions",
      targetEmoji: "🔥",
      targetReactions: 10,
      autoLaunchNext: true,
      nextVariantId: 42,
      nextPriceUzs: 120000,
      nextHours: 4,
    };

    const nextVariant = {
      id: 42,
      priceUzs: 200000,
      nameRu: "Plus",
      product: { nameRu: "ChatGPT" },
    };

    const mockDb = {
      channelPromoCampaign: {
        findUnique: vi.fn().mockResolvedValue(campaign),
        update: vi.fn().mockResolvedValue({}),
        updateMany: vi.fn().mockImplementation(({ where, data }) => {
          if (where.state === state) {
            state = data.state;
            return { count: 1 };
          }
          return { count: 0 };
        }),
        create: vi.fn().mockResolvedValue({ id: 2 }),
      },
      variant: {
        findUnique: vi.fn().mockResolvedValue(nextVariant),
        update: vi.fn().mockResolvedValue({}),
      },
      setting: {
        upsert: vi.fn().mockResolvedValue({}),
      },
    };

    const mockBotApi = {
      editMessageText: vi.fn().mockImplementation((channelId, messageId, text) => {
        channelMessageText = text;
        return Promise.resolve({});
      }),
    };

    const res = await handleMessageReactionCountUpdate(mockDb, mockBotApi, {
      chat: { id: -1001234567 },
      message_id: 500,
      reactions: [{ type: { type: "emoji", emoji: "🔥" }, total_count: 10 }],
    }, "Aiobuna_bot");

    expect(res.reached).toBe(true);
    expect(res.launched).toBe(true);
    expect(state).toBe("completed");
    expect(mockDb.variant.update).toHaveBeenCalledWith({
      where: { id: 42 },
      data: { priceUzs: 120000 },
    });
    expect(channelMessageText).toContain("ChatGPT Plus");
    expect(channelMessageText).toContain("120 000 сум");
  });

  it("transitions active promo to reaction teaser on expiry without deleting", async () => {
    let teaserMessage = "";
    const activeCampaign = {
      id: 10,
      channelId: "-1001234567",
      messageId: 600,
      variantId: 7,
      state: "active",
      targetEmoji: "🔥",
      targetReactions: 10,
      nextVariantId: 8,
      nextPriceUzs: 45000,
    };

    const mockDb = {
      channelPromoCampaign: {
        findFirst: vi.fn().mockResolvedValue(activeCampaign),
        update: vi.fn().mockResolvedValue({}),
      },
      variant: {
        findUnique: vi.fn().mockResolvedValue({
          id: 8,
          nameRu: "Pro",
          product: { nameRu: "Canva" },
        }),
      },
    };

    const mockBotApi = {
      editMessageText: vi.fn().mockImplementation((channel, msgId, text) => {
        teaserMessage = text;
        return Promise.resolve({});
      }),
    };

    const res = await transitionPromoToTeaser(mockDb, mockBotApi, 7);
    expect(res.handled).toBe(true);
    expect(res.campaignId).toBe(10);
    expect(teaserMessage).toContain("Акция завершена!");
    expect(teaserMessage).toContain("Canva Pro");
    expect(teaserMessage).toContain("45 000 сум");
    expect(teaserMessage).toContain("10 реакций 🔥");
    expect(mockDb.channelPromoCampaign.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { state: "waiting_reactions" },
    });
  });
});
