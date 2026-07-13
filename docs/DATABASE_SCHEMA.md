# DATABASE_SCHEMA.md

Источник истины — `prisma/schema.prisma` (PostgreSQL). Ниже — назначение таблиц.

## RBAC / администрирование
- **Admin** — учётка администратора (bcrypt-хэш пароля, роль, активность).
- **Role**, **Permission**, **RolePermission** — роли и права (many-to-many).
- **AdminSession** — серверные сессии (хранится SHA-256 токена, TTL).
- **AuditLog** — все чувствительные действия; `metadata` очищается от секретов.

## Клиенты
- **User** — покупатель (email, опц. пароль, локаль, telegramId).

## Поставщики
- **Supplier** — поставщик: `adapterKey`, `apiBaseUrl`, `status`, `balance`,
  метрики надёжности (`successRate`, `avgFulfilSeconds`, `reliabilityRating`,
  `manualPriority`, `isBlacklisted`).
- **SupplierApiCredential** — API-ключ **зашифрован** (AES-256-GCM), `keyLast4`.
- **SupplierProduct** — сырой товар поставщика: цена, наличие, тексты
  (conditions/guarantee/instructions/deliveryTerms/refundPolicy/rules),
  `premiumEmojiCode` (**VARCHAR**), `rawPayload`. Уникален по `(supplierId, externalId)`.

## Каталог
- **CanonicalProduct** — наш товар (slug, статус DRAFT/PUBLISHED/HIDDEN/ARCHIVED,
  `salesCount`, `totalProfit`).
- **ProductCategory** — категории (дерево) + `categoryMarkupPercent`.
- **ProductSupplierLink** — связка canonical ↔ supplierProduct: `isConfirmed`
  (ручное подтверждение), `isPrimary`, `fallbackOrder`, `isEnabled`.

## Цены
- **ProductPriceRule** — правило на товар: `useFixedPrice/fixedPrice`,
  `markupPercent`, `minPrice/maxPrice`, `minProfit`, `roundingMode`, `manualPrice`.
- **PriceHistory** — история изменений цены (себест., цена, наценка, причина).
- **CurrencyRate** — курсы (USDT→UZS и т.д.).
- **Setting** — глобальные настройки (JSON): наценка по умолчанию, округление.

## Контент (условия/гарантии/описания)
- **ProductContent** — оригиналы поставщика + публичные тексты + режим
  синхронизации на каждое поле (`AUTO/MANUAL/SUPPLIER_PLUS_OURS`), `appendedBlock`,
  `lastSupplierContentSyncAt`, `contentVersion`.
- **ProductContentVersion** — снапшоты версий контента (для истории и diff).

## Premium Emoji
- **PremiumEmojiConfig** — `premiumEmojiCode` (**String**),
  `premiumEmojiFallbackImageUrl`, `premiumEmojiAltText`, `productLogoUrl`,
  `iconDisplayMode` (PREMIUM_EMOJI/LOGO/BOTH/NONE), `rendererProvider`.

## Кандидаты
- **Candidate** — найденный, но не опубликованный товар: `status`
  (NEW/IGNORED/HIDDEN/LINKED/PUBLISHED), рекомендуемые наценка/цена/прибыль,
  число похожих, возможные совпадения.

## Заказы / деньги
- **Order** — заказ: `publicCode`, статус (PENDING_PAYMENT…REFUNDED/CANCELLED),
  суммы (client/cost/profit), `actionLog`.
- **OrderItem** — позиция: цены поставщика/клиента/прибыль на момент покупки,
  `contentSnapshot` (**неизменяемый** снапшот условий/гарантии/описания),
  `deliveryData`, `supplierOrderId`.
- **Payment** — платёж (провайдер, статус, `externalRef`). **Данные карт не хранятся.**
- **ProfitRecord** — запись прибыли по заказу (для аналитики).

## Логи / прочее
- **SupplierSyncLog** — история синхронизаций (счётчики, длительность, статус).
- **SupplierApiError** — ошибки API (сообщение без ключей).
- **Notification** — уведомления (INTERNAL/TELEGRAM).

## Enum'ы
`SupplierStatus, ProductStatus, RoundingMode, ContentSyncMode, IconDisplayMode,
CandidateStatus, OrderStatus, PaymentStatus, SyncStatus, NotificationChannel`.
