# Binance Pay Merchant

Integration is implemented but disabled until merchant credentials and an explicit selling rate are configured. A personal Binance account or Pay ID is not enough: obtain access to the Binance Pay Merchant API first. Merchant approval, supported countries, business categories and currencies must be confirmed with Binance for this business.

## Connect

1. Open [Binance Merchant Portal](https://merchant.binance.com/) and apply for merchant access. Complete the onboarding requested by Binance. Do not use Spot trading API keys for this integration.
2. Once approved, create the payment API identity key and secret in the merchant portal's developer settings. Keep them in Railway Variables, never in chat, source files or screenshots.
3. Configure the following variables for the service running both Next.js and the bot:

| Variable | Value |
| --- | --- |
| `BINANCE_PAY_API_KEY` | Merchant payment API identity key |
| `BINANCE_PAY_API_SECRET` | Merchant payment API secret |
| `BINANCE_PAY_WEBHOOK_URL` | `https://YOUR-PUBLIC-DOMAIN/api/binance-pay` |
| `BINANCE_PAY_CURRENCY` | `USDT` or `USDC`, available to your merchant account |
| `BINANCE_PAY_UZS_PER_UNIT` | Your selling rate: UZS for one unit of the selected currency |
| `BINANCE_PAY_ENABLED` | `1` after the values above are configured; otherwise `0` |

No exchange rate is assumed. For example, a rate of 12500 means a 25000 UZS product costs 2 units; this is arithmetic only, not a current market quote. The amount is rounded up to eight decimal places and saved per invoice. Changing the configured rate affects only new invoices. Ensure the rate covers your chosen margin and merchant fees.

4. Set the same HTTPS webhook URL in the merchant portal. Each create-order request also supplies it explicitly. Keep the server clock synchronized, and satisfy any API IP restrictions configured on the merchant account.
5. Deploy using the existing Railway workflow. No database migration or new bot process is required. The Binance Pay button appears on the existing product checkout and promotional checkout screens, with the quoted amount and currency. `/health` shows configuration readiness, not a live merchant connectivity check.
6. Make one small real purchase once approved and configured. Confirm the exact amount on Binance's checkout, one approved `TopUp`, one UZS balance credit and the normal product delivery. Check expiry, a duplicate notification and a delayed notification before making the payment method broadly available. Local automated tests do not replace this merchant acceptance check.

## Payment processing

- Requests use Create Order v3 and Query Order v2. Only virtual goods are declared (`goodsType=02`).
- The existing `TopUp` row stores the UZS price, purchase note (including recipient), and referral spend. `externalId` stores a unique random merchant trade number. `txnRef` stores a versioned JSON snapshot of currency, quoted amount, rate, prepay ID and, after payment, transaction ID. Binance rows are excluded from manual admin approval/rejection.
- Invoices expire after 30 minutes. A creation timeout leaves the record pending, because Binance may already have accepted the request.
- Webhooks are verified against Binance's RSA certificate using the exact request body. Both webhook and recovery poller query Binance for the authoritative order, then check trade number, prepay ID when known, amount and currency.
- Only `PAID` credits the balance. A conditional pending-to-approved update and the credit execute in one database transaction. Concurrent callbacks/polling cannot credit it twice. Browser redirects never approve payments.
- The existing bot delivery poller picks up approved Binance top-ups. It preserves the existing at-most-once delivery claim behavior: a crash after a delivery claim or supplier failure can require admin recovery; reconciliation must not blindly redeliver a claimed purchase.
- Recovery scans pending invoices in rotating batches of ten, including after process restarts. Local expiry alone does not discard a confirmed payment. Confirmed canceled/expired orders are rejected; orders not found by Binance are rejected only after invoice expiry plus a one-minute grace period.
- Setting `BINANCE_PAY_ENABLED=0` hides new checkouts while existing payments keep settling. Keep API credentials installed until all outstanding payments are reconciled.
- Refunds and disputes require merchant/admin handling; this integration does not initiate refunds or automatically reverse an already delivered order. Unknown/provider-error states stay pending for investigation.
- If checkout creation fails, the bot logs a generic error and keeps the other payment methods available. No secrets or full payment payloads are logged.

## Validation

Run `npm run typecheck` and `npm test`. Protocol/service tests cover signatures and tampering, conversion rounding, wrong currency/amount/identity, concurrent settlement, invoice creation timeouts, closed orders and disabled new checkouts. No production database, live payment or deployment is exercised by those tests.

Official protocol references: [Create Order](https://developers.binance.com/en/docs/products/binance-pay-merchant/api-order-create-v3), [Query Order](https://developers.binance.com/en/docs/products/binance-pay-merchant/api-order-query-v2), [Webhook signatures](https://developers.binance.com/en/docs/products/binance-pay-merchant/webhook-common), [Order notifications](https://developers.binance.com/en/docs/products/binance-pay-merchant/order-notification).
