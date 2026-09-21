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
  targetChatId: string
): boolean {
  if (!targetChatId) return false;
  const targetClean = String(targetChatId).trim();
  const targetWithout100 = targetClean.replace(/^-100/, "").replace(/^-/, "");

  if (incomingChatId !== undefined && incomingChatId !== null) {
    const strChatId = String(incomingChatId).trim();
    if (strChatId === targetClean || strChatId.replace(/^-100/, "").replace(/^-/, "") === targetWithout100) {
      return true;
    }
  }

  if (incomingPeerId) {
    const rawPeer = String(
      incomingPeerId.channelId ?? incomingPeerId.chatId ?? incomingPeerId.userId ?? ""
    ).trim();
    if (rawPeer) {
      const peerWithout100 = rawPeer.replace(/^-100/, "").replace(/^-/, "");
      if (rawPeer === targetClean || peerWithout100 === targetWithout100) {
        return true;
      }
    }
  }

  return false;
}

async function persistMonitorState(db: any, s: MonitorState) {
  if (!db) return;
  try {
    const val = JSON.stringify({
      isRunning: s.isRunning,
      isConfigured: s.isConfigured,
      lastEventAt: s.lastEventAt ? s.lastEventAt.toISOString() : null,
      lastError: s.lastError,
      processedCount: s.processedCount,
      updatedAt: new Date().toISOString(),
    });
    if (db.setting) {
      await db.setting.upsert({
        where: { key: "humo_monitor_status" },
        create: { key: "humo_monitor_status", valueRu: val },
        update: { valueRu: val },
      });
    } else if (db.botSetting) {
      await db.botSetting.upsert({
        where: { key: "humo_monitor_status" },
        create: { key: "humo_monitor_status", valueRu: val },
        update: { valueRu: val },
      });
    }
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

  if (db && !state.isRunning) {
    try {
      const row = db.setting
        ? await db.setting.findUnique({ where: { key: "humo_monitor_status" } })
        : db.botSetting
        ? await db.botSetting.findUnique({ where: { key: "humo_monitor_status" } })
        : null;
      if (row?.valueRu) {
        const parsed = JSON.parse(row.valueRu);
        currentRunning = Boolean(parsed.isRunning);
        currentConfigured = Boolean(parsed.isConfigured) || config.isConfigured;
        currentLastError = parsed.lastError || null;
        currentLastEventAt = parsed.lastEventAt ? new Date(parsed.lastEventAt) : null;
        currentProcessedCount = Number(parsed.processedCount) || 0;
      }
    } catch {}
  }

  return {
    isRunning: currentRunning,
    isConfigured: currentConfigured,
    lastEventAt: currentLastEventAt,
    lastError: currentLastError,
    processedCount: currentProcessedCount,
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

  if (!rawApiId || !rawApiHash || !rawSession || !rawChatId) {
    state.isConfigured = false;
    state.isRunning = false;
    state.lastError = "Missing MTProto configuration (TELEGRAM_API_ID, TELEGRAM_API_HASH, TELEGRAM_SESSION, or HUMO_CHAT_ID)";
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

    console.log(`[humo-monitor] GramJS MTProto client connected and authorized. Listening to chat ${maskChatId(rawChatId)}`);

    // Preload dialogs so GramJS entity cache has channel access hashes
    await client.getDialogs({ limit: 100 }).catch((e) => {
      console.warn("[humo-monitor] getDialogs warning:", (e as Error).message || e);
    });

    // Event listener for incoming bank notification messages
    client.addEventHandler(async (event: any) => {
      const message = event.message;
      if (!message || message.out) return;

      const isTarget = isMatchingChatId(message.chatId, message.peerId, rawChatId);
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

  const remMin = Math.max(1, Math.ceil(remMs / 60000));
  const l = lang === "uz" || lang === "en" ? lang : "ru";
  const messages: Record<string, string> = {
    ru: `Платёж пока не найден. Заявка активна, осталось: ${remMin} мин. Повторно переводить деньги не нужно.`,
    uz: `To‘lov hozircha topilmadi. Ariza faol, qoldi: ${remMin} daqiqa. Pulni qayta o‘tkazish shart emas.`,
    en: `Payment not found yet. Request is active, remaining: ${remMin} min. No need to send money again.`,
  };

  return {
    isConfirmed: false,
    message: messages[l] || messages.ru,
  };
}
