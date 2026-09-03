# Vexoran Reseller API (ранее Vex)

- **Official Base URL:** `https://api.vexoran.app` (старый `supabase.co/...` также поддерживается).
- **Документация и тест-консоль:** `https://docs.vexoran.app`
- **Auth:** `Authorization: Bearer <vex_sk_...>`
- **Действия:** через query-параметр `?action=` (`products`, `balance`, `order`, `stock`, `orders`).

| Action | Метод | Параметры | Ответ (сокр.) | Статус |
| --- | --- | --- | --- | --- |
| `products` | GET | — | `{ products: [...] }` | ✅ реализовано |
| `stock` | GET | `product_id` | `{ ...product, quantity }` | ✅ (используем `products`) |
| `balance` | GET | — | `{ balance: <number> }` | ✅ реализовано |
| `orders` | GET | `limit`, `offset` | `{ orders: [], limit, offset }` | ✅ (история) |
| `order` | POST | `{ product_id, quantity }` | заказ (списывает баланс) | ⚠️ авто-выдача |

## Поля товара (`products[]`)

`id, name, description, delivery_instructions, price, base_price, custom_price,
category, stock, available, manual_delivery, requires_stock, warranty_type ("none"|"full")`,
плюс блок скидок (`offer, flash_sale, campaign, bulk_discounts, price_locked, discount_ends_at`).

Маппинг в `SupplierProductDTO`:

| Наше | Из Vex |
| --- | --- |
| `externalId` | `id` |
| `title` | `name` |
| `supplierPrice` | `price` (уже с учётом скидок) |
| `currency` | `USDT` (API не возвращает валюту — задано в адаптере) |
| `stock` | `stock` |
| `inStock` | `available` |
| `durationLabel` | извлекается из `name` (18m/6m/…) |
| `description` | `description` с вырезанными `{ce:...}` токенами |
| `instructions` | `delivery_instructions` |
| `deliveryTerms` | по `manual_delivery` |
| `premiumEmojiCode` | первый код `{ce:<id>}` из `description` (**строка**) |

## Premium emoji в описании

Коды приходят инлайн: `{ce:5278711610775457808}` или `{ce:5350619413533958825:⚡}`
(Telegram custom emoji: длинный numeric id + опц. fallback-символ). Парсер —
`src/lib/emoji/ce-tokens.ts`:
- первый код → `premiumEmojiCode` товара (для `<ProductTitleIcon>`),
- в публичном описании токены заменяются на fallback-символ или удаляются.

Telegram custom emoji не рендерятся на обычном сайте, поэтому `ProductTitleIcon`
показывает текстовую иконку/лого (провайдер `default` не резолвит код) — но код
сохранён, и позже можно подключить провайдер (`registerEmojiProvider`) с реальным
CDN/спрайтами эмодзи.

## Что осталось уточнить

Ответ `POST ?action=order` (структура выдачи: где логин/пароль/ключ, значения
`status`). Проверяется на первом реальном заказе; затем при необходимости уточнить
маппинг в `vex-adapter.ts › placeOrder`. Баланс на аккаунте сейчас `1`.

## Важное про валюту и цены

Цены Vex — уже конечная закупочная стоимость (с учётом flash-sale/скидок). Наши
наценки применяются поверх (`ProductPriceRule`). Bulk-скидки Vex (`bulk_discounts`)
пока не используются — точка расширения, если понадобится закупка партиями.
