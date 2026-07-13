# API_INTEGRATION_GUIDE.md — подключение реального поставщика

Система не содержит выдуманных эндпоинтов поставщиков. Каждый поставщик
реализует интерфейс `SupplierAdapter` (`src/lib/suppliers/adapter.ts`). По
умолчанию активен `MockSupplierAdapter`. Чтобы подключить настоящий Reseller API:

## Шаг 1. Заполните HTTP-адаптер

Откройте `src/lib/suppliers/http-adapter.ts`. Все места, требующие реальных
данных из документации поставщика, помечены комментарием:

```ts
// TODO(supplier-api): ...
```

Заполните:

1. **Auth-заголовок** — в функции `call()`. Замените
   `Authorization: Bearer <key>` на реальную схему (`X-Api-Key`, подпись и т.д.).
   Ключ приходит в `ctx.apiKey` (уже расшифрован), **никогда не логируется**.
2. **`ping`** — реальный лёгкий эндпоинт (например `/account`).
3. **`fetchProducts`** — реальный путь и маппинг ответа в `SupplierProductDTO`.
   Важно: `premiumEmojiCode` маппить как **строку** (`String(...)`), не число.
4. **`fetchBalance`** — путь и маппинг баланса.
5. **`placeOrder`** — путь, тело запроса и маппинг ответа в `PlaceOrderResult`.
   Передавайте `idempotencyKey`, если поставщик поддерживает идемпотентность.

Целевые типы (то, во что нужно замапить ответ поставщика):

```ts
SupplierProductDTO {
  externalId, title, supplierPrice, currency, inStock,
  stock?, durationLabel?, description?, conditions?, guarantee?,
  instructions?, deliveryTerms?, refundPolicy?, rules?,
  premiumEmojiCode? (string!), logoUrl?, raw?
}
PlaceOrderResult { supplierOrderId, status, deliveryData?, error? }
```

## Шаг 2. (Опц.) Свой адаптер под нестандартный API

Если поставщик сильно отличается — создайте отдельный файл-адаптер по образцу
`http-adapter.ts` и зарегистрируйте его:

```ts
// src/lib/suppliers/registry.ts
import { mySupplierAdapter } from "./my-supplier-adapter";
registerAdapter(mySupplierAdapter); // key: "my-supplier"
```

## Шаг 3. Создайте поставщика в админке

1. Переключите `SUPPLIER_MODE=live` в `.env` (в `mock` реестр принудительно
   использует mock-адаптер, чтобы разработка не била по реальному API).
2. В админке **/admin/suppliers** → «Добавить поставщика»: имя, адаптер `http`
   (или ваш ключ), `API Base URL`, `API ключ`.
   Ключ шифруется (AES-256-GCM) и хранится как зашифрованный blob; в UI видны
   только последние 4 символа.
3. Нажмите **«Синхронизировать»** — товары попадут в `SupplierProduct`, а
   несвязанные — в **Кандидаты**.

## Шаг 4. Автоматизация синхронизации

Синхронизацию можно ставить в очередь (`enqueueSupplierSync(supplierId)` из
`src/lib/queue/queues.ts`); воркер (`npm run worker`) обрабатывает её. Для
расписания добавьте repeatable job BullMQ (cron) — точка расширения помечена в
`src/worker/index.ts`.

## Что логируется

- Успех/ошибки синхронизации → `SupplierSyncLog`.
- Ошибки API (без ключей) → `SupplierApiError` (видны в /admin/api-errors).
- Изменения цен → уведомление + `PriceHistory`.

## Оплата

`/api/orders/[code]/pay` — это **mock** платёж. Для реального провайдера замените
его на webhook-обработчик подтверждения оплаты, который вызывает
`markOrderPaid(orderId)` и затем ставит `enqueueOrderFulfil(orderId)`. Данные
банковских карт не принимаются и не хранятся.
