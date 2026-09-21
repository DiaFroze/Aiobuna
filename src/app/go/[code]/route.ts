import { NextResponse, type NextRequest } from "next/server";
import { botDb } from "@/lib/botDb";
import {
  isCrawlerBot,
  hashVisitorIp,
  buildAdRedirectUrl,
  validateAdCode,
} from "@/lib/domain/ad-attribution";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DEDUP_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

export async function GET(
  request: NextRequest,
  { params }: { params: { code: string } },
) {
  const rawCode = params?.code ?? "";
  const validated = validateAdCode(rawCode);
  const botUsername =
    process.env.NEXT_PUBLIC_BOT_USERNAME ||
    process.env.BOT_USERNAME ||
    "Aiobunabot";
  const defaultBotUrl = `https://t.me/${botUsername.replace(/^@/, "").trim() || "Aiobunabot"}`;

  // If code is malformed, safely redirect to normal bot
  if (!validated.valid) {
    return NextResponse.redirect(defaultBotUrl, {
      status: 307,
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  }

  const code = validated.code;

  try {
    const adLink = await botDb.adLink.findUnique({
      where: { code },
    });

    // If link doesn't exist or is disabled: redirect to default bot without attribution
    if (!adLink || !adLink.isActive) {
      return NextResponse.redirect(defaultBotUrl, {
        status: 307,
        headers: { "Cache-Control": "no-store, max-age=0" },
      });
    }

    const userAgent = request.headers.get("user-agent") || "";
    const referer = request.headers.get("referer") || null;
    const isBot = isCrawlerBot(userAgent, request.headers);

    const forwardedFor = request.headers.get("x-forwarded-for");
    const ip = forwardedFor ? forwardedFor.split(",")[0].trim() : "127.0.0.1";
    const ipHash = hashVisitorIp(ip, userAgent);

    if (!isBot) {
      // Human visitor: check 15-minute deduplication window
      const recentClick = await botDb.adClick.findFirst({
        where: {
          adLinkId: adLink.id,
          ipHash,
          createdAt: { gte: new Date(Date.now() - DEDUP_WINDOW_MS) },
        },
        select: { id: true },
      });

      const isUnique = !recentClick;

      // Asynchronously log click
      await botDb.adClick
        .create({
          data: {
            adLinkId: adLink.id,
            ipHash,
            userAgent: userAgent.slice(0, 255),
            referer: referer ? referer.slice(0, 500) : null,
            isUnique,
            isBot: false,
          },
        })
        .catch((e) => console.error("[ad-redirect] click logging failed:", (e as Error).message));
    }

    // Build Telegram deep link: https://t.me/Aiobunabot?start=meta_reels5_broad
    const targetUrl = buildAdRedirectUrl(botUsername, code);

    return NextResponse.redirect(targetUrl, {
      status: 307,
      headers: {
        "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
        Pragma: "no-cache",
      },
    });
  } catch (error) {
    console.error("[ad-redirect] error:", error);
    return NextResponse.redirect(defaultBotUrl, {
      status: 307,
      headers: { "Cache-Control": "no-store, max-age=0" },
    });
  }
}
