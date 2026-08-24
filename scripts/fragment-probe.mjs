// READ-ONLY probe for fragment-api.com. Creates nothing, spends nothing.
//
// Run it where the credential lives (Railway console, or locally with the value
// in .env). It prints response SHAPES so the client can be written against the
// real contract instead of guesses — and never prints the token itself.
//
//   node scripts/fragment-probe.mjs [username-to-look-up]

const BASE = process.env.FRAGMENT_API_BASE_URL || "https://api.fragment-api.com/v1";
const JWT = process.env.FRAGMENT_CONNECTION_JWT || "";
const APIKEY = process.env.FRAGMENT_API_TOKEN || "";
const LOOKUP = process.argv[2] || "durov";

// A JWT is three dot-separated segments; an account API key is a UUID. Telling
// them apart matters because only one of them authenticates the order endpoints.
const shape = (t) => (!t ? "NOT SET" : t.split(".").length === 3 ? "SET (JWT format)" : "SET (not JWT — looks like an API key)");
console.log(`FRAGMENT_CONNECTION_JWT : ${shape(JWT)}`);
console.log(`FRAGMENT_API_TOKEN      : ${shape(APIKEY)}`);
if (!JWT) {
  console.log("\nNo Fragment Connection JWT — authenticated endpoints cannot be probed.");
}

// Describe a value's structure without echoing sensitive content.
function describe(v, depth = 0) {
  const pad = "  ".repeat(depth + 1);
  if (v === null) return "null";
  if (Array.isArray(v)) {
    if (!v.length) return "[] (empty)";
    return `[${v.length}] of:\n${pad}${describe(v[0], depth + 1)}`;
  }
  if (typeof v === "object") {
    return Object.entries(v)
      .map(([k, val]) => `\n${pad}${k}: ${typeof val === "object" && val !== null ? describe(val, depth + 1) : `${typeof val} = ${JSON.stringify(val)}`}`)
      .join("");
  }
  return `${typeof v} = ${JSON.stringify(v)}`;
}

async function probe(label, path, auth) {
  const url = `${BASE}${path}`;
  const headers = auth && JWT ? { Authorization: `JWT ${JWT}` } : {};
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
    console.log(`\n=== ${label} — GET ${path} → HTTP ${res.status} ===`);
    console.log(typeof body === "string" ? body : describe(body));
    return res.ok;
  } catch (e) {
    console.log(`\n=== ${label} — GET ${path} → REQUEST FAILED: ${e.message} ===`);
    return false;
  }
}

const results = {};
results.prices = await probe("PRICES (public)", "/misc/prices/", false);
results.wallet = await probe("WALLET (auth)", "/misc/wallet/", true);
results.user = await probe("USER LOOKUP (auth)", `/misc/user/${encodeURIComponent(LOOKUP)}/`, true);

console.log("\n================ SUMMARY ================");
console.log(`PRICES ENDPOINT : ${results.prices ? "PASS" : "FAIL"}`);
console.log(`WALLET ENDPOINT : ${results.wallet ? "PASS" : "FAIL"}`);
console.log(`USER LOOKUP     : ${results.user ? "PASS" : "FAIL"}`);
console.log("No order was created. This script never POSTs.");
