# Meta Conversions API for Telegram bot conversions

The bot records ad-link starts as `Lead` events and successfully delivered, paid
orders as `Purchase` events. Events enter the `MetaConversionEvent` outbox first;
the bot sends pending rows to Meta and retries after temporary errors. Stable
event IDs let Meta deduplicate retries. Events created before this feature are
not backfilled.

## Configure Meta

1. In Events Manager, create or select the data source (dataset/pixel) that will
   receive these server events. Copy its dataset ID.
2. Generate a Conversions API access token for that data source in Meta and keep
   it in Railway's server-side environment variables. The token must be allowed
   to send events to that source.
3. Set `META_DATASET_ID` and `META_CAPI_ACCESS_TOKEN`. `META_API_VERSION` is
   shared with the existing Marketing API integration and defaults to `v20.0`
   in code; the repository's sample currently pins `v21.0`.
4. Deploy the application. `start:all` applies the additive Prisma schema before
   starting the bot. The admin page at `/admin/bot-ads/meta-settings` shows
   whether CAPI is configured and the pending/sent counts.

Never place the CAPI token in browser code, an ad URL, source control, or chat.
Do not reuse a token unless it has access to the selected data source. No raw
Telegram IDs, usernames, names, phone numbers, IP addresses, or chat contents
are sent. The `external_id` match value is SHA-256 hashed; the ad code and order
value are sent as conversion metadata.

## What is counted

- `Lead`: a Telegram bot start carrying an active `AdLink` code. Repeated starts
  from the same user and code use the same event ID and are deduplicated.
- `Purchase`: a paid order with ad attribution after successful automatic or
  manual delivery. Referral gifts, admin-created orders, zero-value orders, and
  orders without an ad code are excluded.

Meta attribution depends on matching and its own attribution window. These
server events improve conversion signals but do not guarantee that every order
will appear as attributed to an ad. The application's per-link database funnel
remains the source for exact ad-code counts and revenue.
