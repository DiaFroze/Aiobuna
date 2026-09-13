import { randomBytes } from "node:crypto";

export interface GiveawayStartPayload {
  giveawayId: number;
  refUserId?: number;
}

/**
 * Parses /start payload for giveaways.
 * Supported formats:
 * - "gw_12" -> { giveawayId: 12 }
 * - "gw_12_987" -> { giveawayId: 12, refUserId: 987 }
 * - "giveaway_12" -> { giveawayId: 12 }
 */
export function parseGiveawayStartPayload(payload: string): GiveawayStartPayload | null {
  if (!payload) return null;
  const clean = payload.trim().toLowerCase();
  const match = clean.match(/^(?:gw_|giveaway_)?(\d+)(?:_(\d+))?$/);
  if (!match) return null;

  const giveawayId = parseInt(match[1], 10);
  if (!Number.isFinite(giveawayId) || giveawayId <= 0) return null;

  const refUserId = match[2] ? parseInt(match[2], 10) : undefined;
  if (refUserId !== undefined && (!Number.isFinite(refUserId) || refUserId <= 0)) {
    return { giveawayId };
  }

  return { giveawayId, refUserId };
}

/**
 * Builds the deep link URL for joining a giveaway or sharing a referral link.
 */
export function buildGiveawayBotUrl(botUsername: string, giveawayId: number, refUserId?: number): string {
  const cleanUsername = botUsername.replace(/^@/, "").trim() || "Aiobunabot";
  const param = refUserId ? `gw_${giveawayId}_${refUserId}` : `gw_${giveawayId}`;
  return `https://t.me/${cleanUsername}?start=${param}`;
}

/**
 * Checks if a participant meets all conditions (channel subscriptions + required friends).
 */
export function checkParticipantEligibility(params: {
  hasRequiredSubs: boolean;
  friendsCount: number;
  reqFriends: number;
}): boolean {
  if (!params.hasRequiredSubs) return false;
  if (params.reqFriends > 0 && params.friendsCount < params.reqFriends) return false;
  return true;
}

/**
 * Calculates when the prize claim expires (default 24 hours from now).
 */
export function calculateClaimExpiry(now: Date, claimHours: number): Date {
  const safeHours = Math.max(1, claimHours || 24);
  return new Date(now.getTime() + safeHours * 60 * 60 * 1000);
}

/**
 * Selects random winners from eligible participants without replacement.
 * Uses Fisher-Yates shuffle with cryptographic random or optional custom random function.
 */
export function selectRandomWinners<T>(
  eligibleParticipants: T[],
  winnersCount: number,
  randomFn?: () => number,
): T[] {
  if (!eligibleParticipants || eligibleParticipants.length === 0 || winnersCount <= 0) {
    return [];
  }

  const pool = [...eligibleParticipants];
  const count = Math.min(winnersCount, pool.length);

  // Modern Fisher-Yates partial shuffle
  for (let i = 0; i < count; i++) {
    let randIndex: number;
    if (randomFn) {
      randIndex = i + Math.floor(randomFn() * (pool.length - i));
    } else {
      const randByte = randomBytes(4).readUInt32BE(0);
      randIndex = i + (randByte % (pool.length - i));
    }

    const temp = pool[i];
    pool[i] = pool[randIndex];
    pool[randIndex] = temp;
  }

  return pool.slice(0, count);
}

/**
 * Masks user identity for public channel publication (privacy-preserving).
 * E.g. "@johndoe" -> "@jo***oe", "Ivan" -> "Ivan (ID: 123***89)"
 */
export function maskUserIdentifier(user: {
  username?: string | null;
  firstName?: string | null;
  tgId?: string | null;
}): string {
  if (user.username && user.username.trim()) {
    const raw = user.username.replace(/^@/, "").trim();
    if (raw.length <= 3) {
      return `@${raw}***`;
    }
    const prefix = raw.slice(0, 2);
    const suffix = raw.slice(-2);
    return `@${prefix}***${suffix}`;
  }

  const name = (user.firstName || "").trim();
  const rawId = (user.tgId || "").trim();
  const maskedId = rawId.length > 4 ? `${rawId.slice(0, 2)}***${rawId.slice(-2)}` : rawId;

  if (name) {
    return `${name} (${maskedId ? `ID: ${maskedId}` : "участник"})`;
  }

  return maskedId ? `ID: ${maskedId}` : "Участник";
}

/**
 * Formats results message for Telegram channel post after draw is executed.
 */
export function formatGiveawayResultsPost(params: {
  title: string;
  productTitle: string;
  prizeType: string;
  discountPriceUzs: number;
  winners: Array<{
    username?: string | null;
    firstName?: string | null;
    tgId?: string | null;
  }>;
  botUsername?: string;
}): string {
  const priceText =
    params.prizeType === "free" || params.discountPriceUzs === 0
      ? "🎁 <b>Бесплатно (0 сум)</b>"
      : `💰 <b>${params.discountPriceUzs.toLocaleString("ru-RU")} сум</b>`;

  let lines: string[] = [
    `🎉 <b>Итоги розыгрыша: ${escapeTgHtml(params.title)}</b>`,
    "",
    `🏆 <b>Приз:</b> ${escapeTgHtml(params.productTitle)}`,
    `🏷 <b>Цена для победителя:</b> ${priceText}`,
    "",
    `👥 <b>Победители (${params.winners.length}):</b>`,
  ];

  if (params.winners.length === 0) {
    lines.push("<i>Участников, выполнивших условия, не нашлось.</i>");
  } else {
    params.winners.forEach((w, idx) => {
      lines.push(`${idx + 1}. ${escapeTgHtml(maskUserIdentifier(w))}`);
    });
  }

  lines.push("");
  lines.push("⚡ <i>Победителям отправлены персональные инструкции в боте для получения приза!</i>");

  return lines.join("\n");
}

function escapeTgHtml(s: string): string {
  if (!s) return "";
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
