// Background MTProto (GramJS) listener for HUMO Card notification Telegram chat.
// Connects to Telegram using a user account session string (TELEGRAM_SESSION).
// Idempotently records bank notifications and matches incoming deposits to active CardPaymentRequests.
// NEVER logs API hashes, sessions, tokens, or full card numbers.

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import { parseHumoNotification, sanitizeNotificationText } from "../domain/humo-parser";
import {
  claimPaymentConfirmation,
  getCardPaymentConfig,
  getEnvTolerant,
  maskCardNumber,
  maskChatId,
} from "../domain/card-payment";

interface MonitorState {
  isRunning: boolean;
  isConfigured: boolean;
  lastEventAt: Date | null;
  lastError: string | null;
  processedCount: number;
}

const state: MonitorState = {
  isRunning: false,
  isConfigured: false,
  lastEventAt: null,
  lastError: null,
  processedCount: 0,
};

let client: TelegramClient | null = null;
let dbClientInstance: any = null;

export interface SupportIncomingMessage {
  senderId: string;
  messageId: number;
  text: string;
  date: Date;
  isPrivate: boolean;
}

export type SupportIncomingHandler = (message: SupportIncomingMessage) => Promise<void>;

let supportIncomingHandler: SupportIncomingHandler | null = null;
let supportOwnerVerified: boolean | null = null;

export function registerSupportIncomingHandler(handler: SupportIncomingHandler | null) {
  supportIncomingHandler = handler;
}

function supportUserConfig() {
  const mode = (getEnvTolerant("TELEGRAM_SUPPORT_MODE", ["telegram_support_mode"]) || "off").toLowerCase();
  const targetIds = new Set(
    (getEnvTolerant("TELEGRAM_SUPPORT_TARGET_ID", ["telegram_support_target_id"]) || "")
      .split(/[,;\s]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const ownerUsername = getEnvTolerant("TELEGRAM_SUPPORT_OWNER_USERNAME", ["telegram_support_owner_username"])
    .replace(/^@/, "")
    .trim()
    .toLowerCase();
  return { mode, targetIds, ownerUsername };
}

function messageSenderId(message: any): string {
  const raw = message?.senderId?.value ?? message?.senderId ?? message?.peerId?.userId?.value ?? message?.peerId?.userId;
  return raw === undefined || raw === null ? "" : String(raw).trim();
}

async function isSupportOwnerAccount(): Promise<boolean> {
  const config = supportUserConfig();
  if (!config.ownerUsername || !client) return false;
  if (supportOwnerVerified !== null) return supportOwnerVerified;
  try {
    const me: any = await client.getMe();
    supportOwnerVerified = String(me?.username ?? "").replace(/^@/, "").toLowerCase() === config.ownerUsername;
  } catch {
    supportOwnerVerified = false;
  }
  return supportOwnerVerified;
}

export async function sendSupportAccountMessage(targetId: string, text: string): Promise<"sent" | "dry_run" | "disabled" | "rejected"> {
  const config = supportUserConfig();
  if (!config.targetIds.has(String(targetId)) || !text.trim()) return "rejected";
  if (config.mode === "dry_run") {
    console.log("[telegram-support] dry-run reply skipped for " + targetId);
    return "dry_run";
  }
  if (config.mode !== "allowlist" || !client || !state.isRunning || !(await isSupportOwnerAccount())) {
    return "disabled";
  }
  try {
    await client.sendMessage(String(targetId), { message: text.slice(0, 4096) });
    return "sent";
  } catch (error) {
    console.error("[telegram-support] send failed:", (error as Error).message);
    return "disabled";
  }
}

export type PaymentConfirmedHandler = (request: {
  id: number;
  userId: number;
  variantId: number;
  qty: number;
  baseAmount: number;
  extraAmount: number;
  totalAmount: number;
  cardLast4: string;
  chatId?: string | null;
  messageId?: number | null;
  refSpend?: number;
  targetUsername?: string | null;
  recipientTgId?: string | null;
}) => Promise<void>;

let confirmedHandler: PaymentConfirmedHandler | null = null;

/**
 * Register fulfillment callback when payment is atomically confirmed.
 */
export function registerPaymentConfirmedHandler(handler: PaymentConfirmedHandler) {
  confirmedHandler = handler;
}

export function isMatchingChatId(
  incomingChatId: string | number | bigint | undefined | null,
  incomingPeerId: any,
  targetChatId: string,
  resolvedNumericId?: string | null,
  senderId?: any
): boolean {
  if (!targetChatId) return false;
  const targetClean = String(targetChatId).trim();
  const targetWithout100 = targetClean.replace(/^-100/, "").replace(/^-/, "");
  const targetLower = targetClean.toLowerCase().replace(/^@/, "");

  const candidates: string[] = [];
  if (incomingChatId !== undefined && incomingChatId !== null) {
    candidates.push(String(incomingChatId).trim());
  }
  if (senderId !== undefined && senderId !== null) {
    candidates.push(String(senderId).trim());
  }
  if (incomingPeerId) {
    const rawPeer = String(
      incomingPeerId.channelId ?? incomingPeerId.chatId ?? incomingPeerId.userId ?? ""
    ).trim();
    if (rawPeer) candidates.push(rawPeer);
  }

  for (const c of candidates) {
    const without100 = c.replace(/^-100/, "").replace(/^-/, "");
    const lower = c.toLowerCase().replace(/^@/, "");
    if (
      c === targetClean ||
      without100 === targetWithout100 ||
      lower === targetLower ||
      (resolvedNumericId && (
        c === resolvedNumericId ||
        without100 === resolvedNumericId.replace(/^-100/, "").replace(/^-/, "")
      ))
    ) {
      return true;
    }
  }

  return false;
}

async function persistMonitorState(db: any, s: MonitorState) {
  if (!db) return;
  try {
    const config = getCardPaymentConfig();
    const dataObj = {
      isRunning: s.isRunning,
      isConfigured: s.isConfigured || config.isConfigured,
      lastEventAt: s.lastEventAt ? s.lastEventAt.toISOString() : null,
      lastError: s.lastError,
      processedCount: s.processedCount,
      mode: config.mode,
      cardLast4: config.cardLast4,
      cardNumberMasked: maskCardNumber(config.cardNumber, config.cardLast4),
      humoChatIdMasked: maskChatId(config.humoChatId),
      hasApiId: config.hasApiId,
      hasApiHash: config.hasApiHash,
      hasSession: config.hasSession,
      hasChatId: config.hasChatId,
      ttlSeconds: config.ttlSeconds,
      updatedAt: new Date().toISOString(),
    };
    const valRu = JSON.stringify(dataObj);

    // Save into BotSetting (used by bot process)
    if (db.botSetting) {
      await db.botSetting.upsert({
        where: { key: "humo_monitor_status" },
        create: { key: "humo_monitor_status", valueRu: valRu },
        update: { valueRu: valRu },
      }).catch(() => {});
    }

    // BotSetting is the shared status store. In the bot process `db.setting`
    // is a compatibility proxy to BotSetting, so writing both models causes
    // Prisma to reject the web-only `value` field.
  } catch {
    // Non-critical, ignore
  }
}

/**
 * Returns monitor status for admin diagnostics and bot access gating.
 * Safely masks all card numbers, hashes, tokens, and sessions.
 */
export async function getHumoMonitorStatus(db?: any) {
  const config = getCardPaymentConfig();

  let currentRunning = state.isRunning;
  let currentConfigured = state.isConfigured || config.isConfigured;
  let currentLastError = state.lastError;
  let currentLastEventAt = state.lastEventAt;
  let currentProcessedCount = state.processedCount;
  let currentCardNumberMasked = maskCardNumber(config.cardNumber, config.cardLast4);
  let currentHumChatIdMasked = maskChatId(config.humoChatId);
  let currentHasApiId = config.hasApiId;
  let currentHasApiHash = config.hasApiHash;
  let currentHasSession = config.hasSession;
  let currentHasChatId = config.hasChatId;
  let currentCardLast4 = config.cardLast4;
  let currentMode = config.mode;
  let currentTtlSeconds = config.ttlSeconds;

  if (db) {
    try {
      let parsed: any = null;
      // Check BotSetting first (shared table)
      if (db.botSetting) {
        const row = await db.botSetting.findUnique({ where: { key: "humo_monitor_status" } });
        if (row?.valueRu) {
          try { parsed = JSON.parse(row.valueRu); } catch {}
        }
      }
      // Check Setting second (raw Prisma Setting model)
      if (!parsed && db.setting) {
        const row = await db.setting.findUnique({ where: { key: "humo_monitor_status" } });
        if (row?.value) {
          parsed = typeof row.value === "string" ? JSON.parse(row.value) : row.value;
        } else if (row?.valueRu) {
          try { parsed = JSON.parse(row.valueRu); } catch {}
        }
      }

      if (parsed) {
        if (!state.isRunning && parsed.isRunning !== undefined) {
          currentRunning = Boolean(parsed.isRunning);
        }
        if (parsed.isConfigured !== undefined) {
          currentConfigured = Boolean(parsed.isConfigured) || currentConfigured;
        }
        if (parsed.lastError !== undefined) currentLastError = parsed.lastError || null;
        if (parsed.lastEventAt) currentLastEventAt = new Date(parsed.lastEventAt);
        if (parsed.processedCount !== undefined) currentProcessedCount = Number(parsed.processedCount) || 0;
        if (parsed.cardNumberMasked && parsed.cardNumberMasked !== "Не задана") {
          currentCardNumberMasked = parsed.cardNumberMasked;
        }
        if (parsed.humoChatIdMasked && parsed.humoChatIdMasked !== "Не настроен") {
          currentHumChatIdMasked = parsed.humoChatIdMasked;
        }
        if (parsed.cardLast4) currentCardLast4 = parsed.cardLast4;
        if (parsed.hasApiId !== undefined) currentHasApiId = currentHasApiId || Boolean(parsed.hasApiId);
        if (parsed.hasApiHash !== undefined) currentHasApiHash = currentHasApiHash || Boolean(parsed.hasApiHash);
        if (parsed.hasSession !== undefined) currentHasSession = currentHasSession || Boolean(parsed.hasSession);
        if (parsed.hasChatId !== undefined) currentHasChatId = currentHasChatId || Boolean(parsed.hasChatId);
        if (parsed.mode) currentMode = parsed.mode;
        if (parsed.ttlSeconds) currentTtlSeconds = Number(parsed.ttlSeconds);
      }
    } catch {}
  }

  return {
    isRunning: currentRunning,
    isConfigured: currentConfigured,
    lastEventAt: currentLastEventAt,
    lastError: currentLastError,
    processedCount: currentProcessedCount,
    mode: currentMode,
    cardLast4: currentCardLast4,
    cardNumberMasked: currentCardNumberMasked,
    humoChatIdMasked: currentHumChatIdMasked,
    hasApiId: currentHasApiId,
    hasApiHash: currentHasApiHash,
    hasSession: currentHasSession,
    hasChatId: currentHasChatId,
    ttlSeconds: currentTtlSeconds,
  };
}

export function getHumoMonitorStatusSync() {
  const config = getCardPaymentConfig();
  return {
    isRunning: state.isRunning,
    isConfigured: state.isConfigured || config.isConfigured,
    lastEventAt: state.lastEventAt,
    lastError: state.lastError,
    processedCount: state.processedCount,
    mode: config.mode,
    cardLast4: config.cardLast4,
    cardNumberMasked: maskCardNumber(config.cardNumber, config.cardLast4),
    humoChatIdMasked: maskChatId(config.humoChatId),
    hasApiId: config.hasApiId,
    hasApiHash: config.hasApiHash,
    hasSession: config.hasSession,
    hasChatId: config.hasChatId,
  };
}

/**
 * Initializes and starts the GramJS MTProto client in the bot background.
 * Gracefully no-ops if credentials are not provided.
 */
export async function startHumoMonitor(db: any): Promise<void> {
  dbClientInstance = db;

  const config = getCardPaymentConfig();
  const rawApiId = config.apiId;
  const rawApiHash = getEnvTolerant("TELEGRAM_API_HASH", ["Appapi_hash", "appapi_hash", "telegram_api_hash", "API_HASH"]);
  const rawSession = getEnvTolerant("TELEGRAM_SESSION", ["telegram_session", "SESSION", "HUMO_SESSION", "STRING_SESSION"]);
  const rawChatId = config.humoChatId;
  const supportConfig = supportUserConfig();
  const personalSupportConfigured =
    (supportConfig.mode === "allowlist" || supportConfig.mode === "dry_run") &&
    supportConfig.targetIds.size > 0 &&
    Boolean(supportConfig.ownerUsername);

  if (!rawApiId || !rawApiHash || !rawSession || (!rawChatId && !personalSupportConfigured)) {
    state.isConfigured = false;
    state.isRunning = false;
    state.lastError = "Missing MTProto configuration (TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION, or HUMO_CHAT_ID / support allowlist)";
    console.log("[humo-monitor] MTProto credentials not fully configured; monitor is offline.");
    await persistMonitorState(db, state);
    return;
  }

  state.isConfigured = true;

  try {
    const stringSession = new StringSession(rawSession.trim());
    client = new TelegramClient(stringSession, rawApiId, rawApiHash.trim(), {
      connectionRetries: 5,
    });

    await client.connect();

    // Verify session validity
    const isAuthorized = await client.checkAuthorization().catch(() => false);
    if (!isAuthorized) {
      state.isRunning = false;
      state.lastError = "invalid session";
      console.error("[humo-monitor] TelegramClient connected, but TELEGRAM_SESSION is not authorized (invalid session).");
      await persistMonitorState(db, state);
      return;
    }

    state.isRunning = true;
    state.lastError = null;
    await persistMonitorState(db, state);

    console.log(
      `[humo-monitor] GramJS MTProto client connected and authorized. Listening to chat ${
        rawChatId ? maskChatId(rawChatId) : "disabled"
      }; personal support ${personalSupportConfigured ? supportConfig.mode : "disabled"}`,
    );

    // Preload dialogs so GramJS entity cache has channel access hashes
    await client.getDialogs({ limit: 100 }).catch((e) => {
      console.warn("[humo-monitor] getDialogs warning:", (e as Error).message || e);
    });

    let resolvedChatNumericId: string | null = null;
    if (rawChatId) {
      try {
        const entity = await client.getEntity(rawChatId);
        if (entity && (entity as any).id) {
          resolvedChatNumericId = String((entity as any).id);
          console.log(`[humo-monitor] Resolved target chat ${rawChatId} to numeric id: ${resolvedChatNumericId}`);
        }
      } catch (e: any) {
        console.warn(`[humo-monitor] getEntity for ${rawChatId} note:`, e?.message || e);
      }
    }

    // Event listener for incoming bank notification messages
    client.addEventHandler(async (event: any) => {
      const message = event.message;
      if (!message || message.out) return;

      if (supportIncomingHandler && message.message) {
        const senderId = messageSenderId(message);
        const isPrivate = Boolean(message.isPrivate || message.peerId?.userId);
        if (senderId) {
          const supportConfig = supportUserConfig();
          if (isPrivate) {
            console.info(
              `[telegram-support] incoming sender=${senderId} private=true targetMatch=${supportConfig.targetIds.has(senderId)}`,
            );
          }
          await supportIncomingHandler({
            senderId,
            messageId: Number(message.id) || 0,
            text: String(message.message),
            date: new Date(message.date * 1000),
            isPrivate,
          }).catch((error) => {
            console.error("[telegram-support] incoming handler failed:", (error as Error).message);
          });
        }
      }

      const isTarget = isMatchingChatId(message.chatId, message.peerId, rawChatId, resolvedChatNumericId, message.senderId);
      if (!isTarget) {
        return;
      }

      state.lastEventAt = new Date();
      state.processedCount++;
      await persistMonitorState(db, state);

      await processBankMessage(db, rawChatId, message.id, message.message || "", new Date(message.date * 1000));
    }, new NewMessage({}));
  } catch (err: any) {
    state.isRunning = false;
    const errMsg = String(err?.message || err);
    if (
      errMsg.includes("AUTH_KEY") ||
      errMsg.includes("SESSION") ||
      errMsg.includes("401") ||
      errMsg.includes("unregistered")
    ) {
      state.lastError = "invalid session";
    } else {
      state.lastError = errMsg;
    }
    console.error("[humo-monitor] Failed to start MTProto client:", state.lastError);
    await persistMonitorState(db, state);
  }
}

/**
 * Parses and processes a bank notification message idempotently.
 */
export async function processBankMessage(
  db: any,
  chatId: string,
  messageId: number,
  text: string,
  messageDate: Date
): Promise<{ matched: boolean; notificationId?: number; requestId?: number }> {
  const existing = await db.bankNotification.findUnique({
    where: { chatId_messageId: { chatId, messageId } },
  });

  if (existing) {
    return {
      matched: existing.status === "matched",
      notificationId: existing.id,
      requestId: existing.matchedRequestId ?? undefined,
    };
  }

  const config = getCardPaymentConfig();
  const parsed = parseHumoNotification(text, messageDate, config.cardLast4);
  const rawSummary = sanitizeNotificationText(text);

  if (!parsed.isDeposit || parsed.amount <= 0 || !parsed.cardLast4) {
    const saved = await db.bankNotification.create({
      data: {
        chatId,
        messageId,
        operationType: parsed.operationType,
        amount: parsed.amount || 0,
        cardLast4: parsed.cardLast4 || "unknown",
        operationTime: parsed.operationTime,
        rawSummary,
        status: "ignored",
      },
    });
    return { matched: false, notificationId: saved.id };
  }

  const notification = await db.bankNotification.create({
    data: {
      chatId,
      messageId,
      operationType: "deposit",
      amount: parsed.amount,
      cardLast4: parsed.cardLast4,
      operationTime: parsed.operationTime,
      rawSummary,
      status: "unmatched",
    },
  });

  const now = new Date();
  const matchedRequest = await db.cardPaymentRequest.findFirst({
    where: {
      cardLast4: parsed.cardLast4,
      totalAmount: parsed.amount,
      status: "pending",
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!matchedRequest) {
    const expiredRequest = await db.cardPaymentRequest.findFirst({
      where: {
        cardLast4: parsed.cardLast4,
        totalAmount: parsed.amount,
        status: "expired",
      },
      orderBy: { createdAt: "desc" },
    });

    if (expiredRequest) {
      await db.bankNotification.update({
        where: { id: notification.id },
        data: {
          status: "late",
          adminReviewNote: `Received after expiration of request #${expiredRequest.id}`,
        },
      });
      console.log(`[humo-monitor] Late payment recorded for expired request #${expiredRequest.id}`);
    } else {
      console.log(`[humo-monitor] Unmatched deposit of ${parsed.amount} UZS on card *${parsed.cardLast4}`);
    }

    return { matched: false, notificationId: notification.id };
  }

  const success = await claimPaymentConfirmation(db, matchedRequest.id, notification.id);
  if (!success) {
    console.warn(`[humo-monitor] Failed atomic confirmation for request #${matchedRequest.id}`);
    return { matched: false, notificationId: notification.id };
  }

  console.log(`[humo-monitor] Matched & confirmed request #${matchedRequest.id} for amount ${parsed.amount} UZS`);

  if (confirmedHandler) {
    confirmedHandler({
      id: matchedRequest.id,
      userId: matchedRequest.userId,
      variantId: matchedRequest.variantId,
      qty: matchedRequest.qty,
      baseAmount: matchedRequest.baseAmount,
      extraAmount: matchedRequest.extraAmount,
      totalAmount: matchedRequest.totalAmount,
      cardLast4: matchedRequest.cardLast4,
      chatId: matchedRequest.chatId,
      messageId: matchedRequest.messageId,
      refSpend: matchedRequest.refSpend,
      targetUsername: matchedRequest.targetUsername,
      recipientTgId: matchedRequest.recipientTgId,
    }).catch((e) => {
      console.error("[humo-monitor] confirmedHandler error:", (e as Error).message);
    });
  }

  return { matched: true, notificationId: notification.id, requestId: matchedRequest.id };
}

/**
 * On-demand check triggered by user tapping "Я оплатил — проверить".
 * Does NOT extend the 5-minute deadline.
 */
export async function triggerImmediateCheck(
  requestId: number,
  db: any,
  lang: string = "ru"
): Promise<{ isConfirmed: boolean; message: string }> {
  const req = await db.cardPaymentRequest.findUnique({ where: { id: requestId } });
  if (!req) return { isConfirmed: false, message: "Заявка не найдена." };
  if (req.status === "confirmed" || req.status === "manual_confirmed") {
    return { isConfirmed: true, message: "Оплата уже подтверждена!" };
  }
  if (req.status === "cancelled") {
    return { isConfirmed: false, message: "Заявка была отменена." };
  }
  const now = new Date();
  if (req.status === "expired" || (req.expiresAt && req.expiresAt.getTime() <= now.getTime())) {
    return { isConfirmed: false, message: "Срок действия заявки (5 минут) истёк." };
  }

  const config = getCardPaymentConfig();
  if (client && state.isRunning && config.humoChatId) {
    try {
      let messages: any[] = [];
      try {
        messages = await client.getMessages(config.humoChatId, { limit: 15 });
      } catch (err: any) {
        console.warn("[humo-monitor] getMessages initial attempt failed, refreshing dialogs:", err?.message || err);
        await client.getDialogs({ limit: 100 }).catch(() => {});
        messages = await client.getMessages(config.humoChatId, { limit: 15 });
      }
      for (const msg of messages) {
        if (msg && !msg.out && msg.message) {
          await processBankMessage(
            db,
            config.humoChatId,
            msg.id,
            msg.message,
            new Date(msg.date * 1000)
          );
        }
      }
    } catch (e: any) {
      console.error("[humo-monitor] immediate check error:", e.message || e);
    }
  }

  const freshReq = await db.cardPaymentRequest.findUnique({ where: { id: requestId } });
  if (freshReq && (freshReq.status === "confirmed" || freshReq.status === "manual_confirmed")) {
    return { isConfirmed: true, message: "Оплата успешно подтверждена!" };
  }

  const currentReq = freshReq || req;
  const remMs = currentReq.expiresAt.getTime() - Date.now();
  if (remMs <= 0 || currentReq.status === "expired") {
    return { isConfirmed: false, message: "Срок действия заявки (5 минут) истёк." };
  }

  const messages: Record<string, string> = {
    ru: "Платёж пока не найден. Заявка активна, повторно переводить деньги не нужно.",
    uz: "To‘lov hozircha topilmadi. Ariza faol, pulni qayta o‘tkazish shart emas.",
    en: "Payment not found yet. Request is active, no need to send money again.",
  };

  return {
    isConfirmed: false,
    message: messages[lang] || messages.ru,
  };
}
