# Click (SHOP-API) — интеграция

Оплата товаров в боте через Click (метод «ссылка/кнопка оплаты»). Аналог Payme:
клиент жмёт кнопку Click → открывается Click Up / my.click.uz → оплачивает →
Click подтверждает через наши callback'и → товар выдаётся.

## Как это работает

```
Бот: кнопка «Click» = ссылка my.click.uz (service_id, merchant_id, amount,
     transaction_param = id пополнения)
   │
   ▼
Клиент оплачивает в Click
   │
   ▼
Click вызывает наш webhook  POST /api/click  (form-urlencoded)
   ├─ Prepare  (action=0) — проверяем заказ, сумму, подпись
   └─ Complete (action=1) — подтверждаем: баланс зачислен
   │
   ▼
Бот выдаёт товар автоматически (тот же поллер, что и Payme)
```

Источник правды — подпись (MD5) и статус в Complete, а не редирект браузера.

## Переменные окружения (Railway → Variables)

| Переменная | Значение |
|---|---|
| `CLICK_ENABLED` | `1` — включить кнопку Click. Пока `0`: кнопка пишет «скоро» |
| `CLICK_SERVICE_ID` | ID сервиса из кабинета merchant.click.uz |
| `CLICK_MERCHANT_ID` | ID мерчанта |
| `CLICK_SECRET_KEY` | Секретный ключ (для проверки подписи). Не логируется |

## Callback-адрес для кабинета Click

В merchant.click.uz → Сервисы → карандаш → впишите **и Prepare, и Complete**:

```
https://aiobuna-production.up.railway.app/api/click
```

Один адрес обрабатывает оба запроса (Click передаёт `action`: 0=Prepare, 1=Complete).

После настройки уведомите Click, чтобы активировали сервис (по умолчанию выключен).

## Подпись (сверено с click-integration-php)

- Prepare: `md5(click_trans_id + service_id + KEY + merchant_trans_id + amount + action + sign_time)`
- Complete: `md5(click_trans_id + service_id + KEY + merchant_trans_id + merchant_prepare_id + amount + action + sign_time)`

`merchant_trans_id` = id пополнения (TopUp) · `merchant_prepare_id` = его же id ·
сумма — в сумах.

## Коды ошибок

`0` успех · `-1` подпись неверна · `-2` неверная сумма · `-3` действие не найдено ·
`-4` уже оплачено · `-5` заказ не найден · `-6` транзакция не найдена · `-9` отменено.

## Идемпотентность и деньги

- Complete зачисляет баланс в одной транзакции БД с блокировкой строки, переход
  строго pending → approved — повтор Complete не зачисляет дважды.
- Суммы сверяются целыми тийинами.
- Логика покрыта юнит-тестами без сети: `npx vitest run tests/click.test.ts`.

## Тест

Прогоните тесты Click (docs.click.uz/click-api-testing), указав endpoint
`https://<домен>/api/click`. Перед первым реальным платежом активируйте сервис
в кабинете.

## Статический IP / TAS-IX

Callback'и идут Click → к нам, домен Railway стабильный. Если Click требует
белый список — дайте им домен `aiobuna-production.up.railway.app`.
