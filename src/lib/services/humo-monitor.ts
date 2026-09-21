// MTProto GramJS Background Monitor for HUMO Card notifications
// Listens to incoming Telegram messages from HUMO_CHAT_ID, parses deposits,
// matches against active CardPaymentRequests, and triggers fulfillment.

import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { NewMessage } from "telegram/events";
import { parseHumoNotification, sanitizeNotificationText } from "../domain/humo-parser";
import { claimPaymentConfirmation, getCardPaymentConfig } from "../domain/card-payment";

export type PaymentConfirmedHandler = (request: {
  id: number;
  userId: number;
  variantId: number;
  qty: number;
  totalAmount: number;
  chatId: string | null;
  messageId: number | null;
  targetUsername: string | null;
  recipientTgId: string | null;
  refSpend: number;
}) => Promise<void>;

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
let confirmedHandler: PaymentConfirmedHandler | null = null;

/**
 * Returns read-only monitor health and status for admin dashboards.
 */
export function getHumoMonitorStatus() {
  const config = getCardPaymentConfig();
  return {
    isRunning: state.isRunning,
    isConfigured: state.isConfigured,
    lastEventAt: state.lastEventAt,
    lastError: state.lastError,
    processedCount: state.processedCount,
    mode: config.mode,
    cardLast4: config.cardLast4,
    cardNumberMasked: config.cardNumber ? config.cardNumber.replace(/\d{4}(?=\d{4})/g, "**** ") : null,
  };
}

/**
 * Register fulfillment callback when payment is atomically confirmed.
 */
export function registerPaymentConfirmedHandler(handler: PaymentConfirmedHandler) {
  confirmedHandler = handler;
}

/**
 * Initializes and starts the GramJS MTProto client in the bot background.
 * Gracefully no-ops if credentials are not provided.
 */
export async function startHumoMonitor(db: any): Promise<void> {
  dbClientInstance = db;

  // Safe backward compatibility: Appapi_id / Appapi_hash -> TELEGRAM_API_ID / TELEGRAM_API_HASH
  const rawApiId = process.env.TELEGRAM_API_ID || (process.env as any).Appapi_id;
  const rawApiHash = process.env.TELEGRAM_API_HASH || (process.env as any).Appapi_hash;
  const rawSession = process.env.TELEGRAM_SESSION;
  const rawChatId = process.env.HUMO_CHAT_ID;

  if (!rawApiId || !rawApiHash || !rawSession || !rawChatId) {
    state.isConfigured = false;
    state.lastError = "Missing MTProto configuration (API_ID, API_HASH, SESSION, or CHAT_ID)";
    console.log("[humo-monitor] MTProto credentials not fully configured; monitor is offline.");
    return;
  }

  const apiId = Number.parseInt(String(rawApiId).trim(), 10);
  const apiHash = String(rawApiHash).trim();
  const stringSession = new StringSession(String(rawSession).trim());
  const targetChatId = String(rawChatId).trim();

  if (isNaN(apiId) || !apiHash) {
    state.isConfigured = false;
    state.lastError = "Invalid API_ID or API_HASH";
    console.error("[humo-monitor] Invalid API_ID or API_HASH format.");
    return;
  }

  state.isConfigured = true;

  try {
    client = new TelegramClient(stringSession, apiId, apiHash, {
      connectionRetries: 5,
    });

    await client.connect();
    state.isRunning = true;
    state.lastError = null;
    console.log(`[humo-monitor] GramJS MTProto client connected. Listening to chat ${targetChatId.slice(-4)}`);

    // Event listener for new messages
    client.addEventHandler(async (event: any) => {
      const message = event.message;
      if (!message || message.out) return;

      // Match chat ID
      const senderChatId = message.chatId ? String(message.chatId) : "";
      const peerId = message.peerId ? String(message.peerId.channelId || message.peerId.chatId || message.peerId.userId || "") : "";

      // Check if this event originates from target HUMO_CHAT_ID
      const matchesTarget =
        senderChatId === targetChatId ||
        peerId === targetChatId ||
        targetChatId.endsWith(peerId) ||
        peerId.endsWith(targetChatId.replace(/^-100/, ""));

      if (!matchesTarget) {
        return;
      }

      state.lastEventAt = new Date();
      state.processedCount++;

      await processBankMessage(db, targetChatId, message.id, message.message || "", new Date(message.date * 1000));
    }, new NewMessage({}));
  } catch (err: any) {
    state.isRunning = false;
    state.lastError = err.message || "Connection failed";
    console.error("[humo-monitor] Failed to start MTProto client:", err.message || err);
  }
}

/**
 * Process a bank notification message:
 * 1. Deduplicate by chatId + messageId
 * 2. Parse deposit details
 * 3. Match against pending requests
 * 4. Execute atomic confirmation & fulfillment
 */
export async function processBankMessage(
  db: any,
  chatId: string,
  messageId: number,
  rawText: string,
  messageDate: Date
): Promise<{ matched: boolean; requestId?: number }> {
  if (!rawText || !messageId) return { matched: false };

  // 1. Check if already recorded in bankNotification
  const existingNotification = await db.bankNotification.findUnique({
    where: {
      chatId_messageId: {
        chatId,
        messageId,
      },
    },
  });

  if (existingNotification) {
    // Already processed idempotently
    return {
      matched: existingNotification.status === "matched",
      requestId: existingNotification.matchedRequestId || undefined,
    };
  }

  // 2. Parse notification
  const parsed = parseHumoNotification(rawText, messageDate);

  // If not a deposit, record as ignored or debit
  if (!parsed.isDeposit || parsed.operationType !== "deposit") {
    await db.bankNotification.create({
      data: {
        chatId,
        messageId,
        operationType: parsed.operationType,
        amount: parsed.amount,
        cardLast4: parsed.cardLast4 || "0000",
        operationTime: parsed.operationTime,
        rawSummary: parsed.rawSummary,
        status: "ignored",
      },
    });
    return { matched: false };
  }

  // 3. Create initial unmatched notification record
  const notification = await db.bankNotification.create({
    data: {
      chatId,
      messageId,
      operationType: "deposit",
      amount: parsed.amount,
      cardLast4: parsed.cardLast4,
      operationTime: parsed.operationTime,
      rawSummary: parsed.rawSummary,
      status: "unmatched",
    },
  });

  const now = new Date();

  // 4. Try to find active pending request matching amount and cardLast4
  const pendingRequest = await db.cardPaymentRequest.findFirst({
    where: {
      cardLast4: parsed.cardLast4,
      totalAmount: parsed.amount,
      status: "pending",
      expiresAt: { gt: now },
    },
    select: {
      id: true,
      userId: true,
      variantId: true,
      qty: true,
      totalAmount: true,
      chatId: true,
      messageId: true,
      targetUsername: true,
      recipientTgId: true,
      refSpend: true,
    },
  });

  if (pendingRequest) {
    // 5. Atomic CAS confirmation
    const confirmed = await claimPaymentConfirmation(db, pendingRequest.id, notification.id);
    if (confirmed) {
      console.log(`[humo-monitor] Matched & confirmed request #${pendingRequest.id} for amount ${parsed.amount} UZS`);
      if (confirmedHandler) {
        try {
          await confirmedHandler(pendingRequest);
        } catch (err: any) {
          console.error(`[humo-monitor] Fulfillment callback error for request #${pendingRequest.id}:`, err.message);
        }
      }
      return { matched: true, requestId: pendingRequest.id };
    }
  }

  // If no active pending request, check if it matches an expired request (late payment)
  const expiredRequest = await db.cardPaymentRequest.findFirst({
    where: {
      cardLast4: parsed.cardLast4,
      totalAmount: parsed.amount,
      status: "expired",
    },
    select: { id: true },
  });

  if (expiredRequest) {
    await db.bankNotification.update({
      where: { id: notification.id },
      data: {
        status: "late",
        adminReviewNote: `Received after expiration for request #${expiredRequest.id}`,
      },
    });
    console.log(`[humo-monitor] Late payment recorded for expired request #${expiredRequest.id}`);
  }

  return { matched: false };
}

/**
 * On-demand check triggered when user clicks «✅ Я оплатил — проверить».
 * Inspects recent messages without extending the 5-minute TTL.
 */
export async function triggerImmediateCheck(
  requestId: number,
  db: any
): Promise<{ isConfirmed: boolean; status: string; message: string }> {
  const request = await db.cardPaymentRequest.findUnique({
    where: { id: requestId },
  });

  if (!request) {
    return { isConfirmed: false, status: "not_found", message: "Заявка не найдена" };
  }

  if (request.status === "confirmed" || request.status === "manual_confirmed") {
    return { isConfirmed: true, status: request.status, message: "Оплата уже подтверждена!" };
  }

  if (request.status !== "pending") {
    return { isConfirmed: false, status: request.status, message: `Заявка не в статусе ожидания (${request.status})` };
  }

  // If client is available, fetch recent 15 messages from the bank channel to catch any latency
  if (client && state.isRunning) {
    try {
      const config = getCardPaymentConfig();
      if (config.humoChatId) {
        const messages = await client.getMessages(config.humoChatId, { limit: 15 });
        for (const msg of messages) {
          if (msg && !msg.out && msg.message) {
            await processBankMessage(
              db,
              config.humoChatId,
              msg.id,
              msg.message,
              new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000)
            );
          }
        }
      }
    } catch (err: any) {
      console.error("[humo-monitor] Immediate check fetch error:", err.message);
    }
  }

  // Re-check status of request after immediate sync
  const freshRequest = await db.cardPaymentRequest.findUnique({
    where: { id: requestId },
  });

  const isConfirmed = freshRequest?.status === "confirmed" || freshRequest?.status === "manual_confirmed";
  return {
    isConfirmed,
    status: freshRequest?.status || "pending",
    message: isConfirmed
      ? "Оплата успешно подтверждена!"
      : "Платёж пока не найден в выписке банка. Пожалуйста, подождите 1-2 минуты.",
  };
}
