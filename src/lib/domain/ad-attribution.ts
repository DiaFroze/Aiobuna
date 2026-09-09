// Telegram start payloads are at most 64 URL-safe characters.
// A separate namespace prevents paid traffic from granting referral rewards.
export function adSource(payload: string): string | null {
  return /^ad_[A-Za-z0-9_-]{1,61}$/.test(payload) ? payload.slice(3) : null;
}
