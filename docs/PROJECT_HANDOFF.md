> ## ⚠️ УСТАРЕЛО — держи как исторический снимок, не как инструкцию
>
> Актуальное состояние проекта описано в `CLAUDE.md`. Здесь встречаются устаревшие
> утверждения: «101 тест» (сейчас 157), раздел «Подарки» (отключён), прямая оплата
> «только для администратора» (давно включена всем), а также описания, сделанные до
> аудита и cleanup-батча.
>
> При расхождении верь `CLAUDE.md` и коду.

---
# AI OBUNA / SB Store — передача проекта (handoff)

Документ для агента/разработчика, который продолжит работу. Прочитай целиком до
первого изменения кода — здесь описаны архитектура, текущее состояние и грабли.

---

## 1. Что это за проект

Telegram-бот-магазин цифровых товаров (подписки и аккаунты: Gemini, Canva,
CapCut, Telegram Stars, Telegram Premium и т.п.) для рынка Узбекистана. Валюта —
**узбекский сум (UZS)**. Есть публичный бот (для клиентов) и веб-админка (для
владельца). Реальные клиенты и деньги — **только в боте**.

Владелец — не программист. Общается по-русски. Все изменения деплоятся на Railway.

---

## 2. Стек и структура

- **Next.js 14 (App Router) + TypeScript** — веб (админка + webhook'и оплаты).
- **grammy** — Telegram-бот (long-polling).
- **Prisma + PostgreSQL** — одна БД на всё.
- **vitest** — тесты (чистая доменная логика).

**Два процесса, одна база:**
- Веб (Next.js) — админка на `/admin/*` и webhook'и оплаты `/api/payme`, `/api/click`.
- Бот (`src/bot/index.ts`, long-polling) — HTTP-порт НЕ слушает.
- Оба смотрят в один и тот же Postgres.

### Важные файлы

| Путь | Что это |
|---|---|
| `src/bot/index.ts` | Весь бот (~4700 строк). Команды, покупки, оплата, рефералы, опрос. |
| `src/bot/i18n.ts` | Переводы (RU/EN/UZ). `t(lang, key, vars)`. Все 3 языка держать в синхроне. |
| `src/bot/db.ts` | Prisma-клиент бота. Proxy: `db.setting` → `botSetting`. |
| `src/lib/botDb.ts` | Тот же Proxy для веба (`botDb.setting` → `botSetting`). |
| `src/lib/env.ts` | Централизованный доступ к env (server-only). |
| `src/lib/domain/*.ts` | Чистая логика (без БД/HTTP), покрыта тестами: `payme.ts`, `click.ts`, `bulk-pricing.ts`, `telegram-username.ts`. |
| `src/lib/services/*-repo.ts` | Prisma-адаптеры для payme/click. |
| `src/app/api/payme/route.ts` | Payme Merchant API webhook. |
| `src/app/api/click/route.ts` | Click SHOP-API webhook (Prepare+Complete). |
| `src/app/admin/(protected)/*` | Страницы админки (server components + server actions). |
| `prisma/schema.prisma` | Схема БД. |
| `tests/*.test.ts` | 101 тест (payme, click, bulk-pricing, referral, username и др.). |

### Запуск / деплой

- Прод: Railway, `railway.json` → startCommand `npm run start:all`
  (`scripts/start-all.mjs`: `prisma db push` → `next start -p $PORT` + бот через tsx).
- Локально: `npm run dev` (веб) + `npm run bot` (бот). Тесты: `npm test`.
  Типы: `npx tsc --noEmit`. Сборка: `npm run build`.
- Публичный домен: `https://aiobuna-production.up.railway.app`.
- **`ensureSchema()` в боте** при старте создаёт недостающие таблицы/колонки
  сырым SQL (идемпотентно). Поэтому изменения схемы «сами мигрируются» на деплое —
  при добавлении поля правь И `schema.prisma`, И блок `ensureSchema`.

---

## 3. Бизнес-модель и ГЛАВНЫЙ переход (не перепутать!)

**Сейчас:** модель баланса. Клиент пополняет баланс в сумах, потом тратит на товары.

**Переходим на:** прямую оплату (Payme/Click) без баланса. **ВАЖНО:** прямая оплата
сейчас включена **ТОЛЬКО ДЛЯ АДМИНА** — флаг `directPayEnabled(ctx) = isAdmin(ctx)`
в `src/bot/index.ts`. Обычные пользователи видят СТАРУЮ модель с балансом без
изменений. Это сделано специально: тестируем на админе, пока Payme и Click не
одобрят. После одобрения — поменять `directPayEnabled` с «только админ» на настройку/всех.

Что у админа в режиме прямой оплаты (не трогать у обычных юзеров):
- Кнопка «Баланс» скрыта (меню, профиль, каталог) — параметры `hideWallet`/`hideBalance`.
- Покупка товара → сразу «выбор банка» (Payme/Click с премиум-эмодзи), без баланса, без видео.
- Payme/Click кнопки — прямые URL (одно нажатие открывает приложение банка).
- После оплаты нет сообщения «баланс пополнен» и строки «Осталось: …».

---

## 4. Оплата (ключевой модуль)

Обе системы кредитуют строку `TopUp` (method `payme`/`click`), webhook помечает
`approved` + зачисляет баланс, затем **поллер бота** `deliverPaidPaymeTopUps()`
(каждые 12 c) выдаёт товар (если в `note` есть `buy:variantId:qty[:username]`) или
показывает баланс (обычное пополнение). Баланс тут — внутренняя «сантехника».

### Payme — ГОТОВО, песочница пройдена

- Файлы: `src/lib/domain/payme.ts` (чистая логика + тесты), `payme-repo.ts`, `/api/payme`.
- Env: `PAYME_ENABLED=1`, `PAYME_MERCHANT_ID`, `PAYME_KEY` (секрет), `PAYME_CHECKOUT_URL`
  (`https://checkout.paycom.uz` бой / `checkout.test.paycom.uz` песочница).
- Merchant API: CheckPerform/Create/Perform/Cancel/Check/GetStatement + ChangePassword.
- Ответ `transaction` = НАШ id (не Payme id). Суммы в **тийинах** (сум×100).
- ChangePassword ротирует ключ (хранится в `BotSetting("payme_password")`), есть
  авто-heal и кнопка сброса в админке (Пополнения бота).
- Идемпотентность: perform в одной транзакции с `FOR UPDATE`, зачисляет один раз.
- Тест-хелперы в админке (Пополнения бота): «Создать тестовый счёт», «Сбросить
  тестовый счёт», «Сбросить ключ Payme», синяя панель с `topup_id`+сумма в тийинах.

### Click — РЕАЛИЗОВАНО, ждём настройку кабинета

- Файлы: `src/lib/domain/click.ts` (+ тесты), `click-repo.ts`, `/api/click`.
- SHOP-API: **Prepare (action=0)** и **Complete (action=1)** на ОДИН URL `/api/click`.
- Подпись MD5 (сверено с click-integration-php):
  - Prepare: `md5(click_trans_id + service_id + KEY + merchant_trans_id + amount + action + sign_time)`
  - Complete: + `merchant_prepare_id` после `merchant_trans_id`.
- Коды: 0 ок, −1 подпись, −2 сумма, −4 уже оплачено, −5 заказ не найден, −6 txn не найдена, −9 отмена.
- Env: `CLICK_ENABLED=1`, `CLICK_SERVICE_ID` (ID сервиса из кабинета Click),
  `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY` (секрет).
- **Осталось на стороне владельца:** в кабинете merchant.click.uz прописать
  callback-адрес `https://aiobuna-production.up.railway.app/api/click` в ОБА поля
  (Prepare URL и Complete URL), сверить env, пройти тесты Click. Логи: строки `[click] …`.
- Инструкции: `docs/PAYME_SETUP.md`, `docs/CLICK_SETUP.md`.

### ⚠️ Фискализация (ИКПУ) — НЕ сделана, ждём данные

И Payme, и Click требуют фискализацию чеков. Нужно добавить `detail` (позиции с
кодом **ИКПУ**, package_code, НДС) в ответ CheckPerformTransaction (Payme) и,
при необходимости, в Click. **Заблокировано:** владелец должен получить ИКПУ у
бухгалтера (для «электронной услуги / пополнения баланса», вероятно 1 ИКПУ, НДС
уточнить). Пока ИКПУ нет — не выдумывать код, ждать.

---

## 5. Рефералы

- Ссылка `?start=refXXX`. `referredBy` пишется всегда (даже если рефералка выключена).
- Реферал засчитывается ТОЛЬКО после подписки приглашённого на обязательный канал —
  ставится `channelVerifiedAt`. Счёт: `countVerifiedRefs()`.
- Доступные очки: `availableReferralPoints = verified + bonusReferrals − spentReferrals`.
- Тратятся в «Подарках» (`buyForReferrals`), товары с `pointsCost > 0`.
- Уведомления пригласившему на двух стадиях (зашёл / засчитан).
- Флаг `referrals_enabled` (BotSetting) ставит на паузу начисление/трату.
- Админ-команды: `/refinfo` (полный отчёт), `/reffix` (перепроверить подписки),
  `/refgive` (начислить вручную), `/refrepair` (вернуть потерянные очки),
  `/refzero`, `/refban`, `/refunban`, `/unref`, `/refs`, `/channels`, `/reftest`.
- Веб: `/admin/bot-referrals`.

---

## 6. Прочие фичи

- **Опрос про банки:** `/poll` (превью админу), `/pollsend` (рассылка всем в фоне),
  callback `vote:<bank>`, таблица `BotPollVote`, статистика `/admin/bot-poll`
  (автообновление 60 c). Premium-эмодзи на кнопках; цвета кнопок — только
  primary/success/danger (Telegram больше не даёт).
- **Рассылки** `/post`, `/sendgifts` — НЕ блокируют бота (`broadcastInBackground`,
  ~18 сообщений/сек, оставляет запас для живых юзеров). Раньше лагало на 10–20 мин.
- **Отзыв в Instagram:** после кнопки «Я получил» показывается просьба отзыва
  (`/review` настраивает; по умолчанию выключено).
- **Промо-пост в канал:** `/promopost` (превью/send), deep-link `?start=gifts` →
  сразу вкладка «Подарки».
- **Лента продаж в группе:** `notifySalesGroup`, `/salesgroup` (маскирует имя/id).
- **Fragment (Stars/Premium):** выдача РУЧНАЯ (официального API нет). У варианта
  `needsUsername`, `fragmentKind` (stars/premium), `fragmentAmount`. Бот спрашивает
  `@username` ДО оплаты (перевод необратим), присылает админу задание на выдачу.
  Инструкция: `docs/FRAGMENT_SETUP.md`. Автоматизацию не делали (риск seed-фразы).
- **Оптовые цены:** у варианта `bulkPrices` («2=55000,3=80000») и `bulkBonus`
  («2+1»). Логика — `src/lib/domain/bulk-pricing.ts` (+ тесты).

---

## 7. Грабли (частые ошибки — не наступать)

1. **Premium-эмодзи** (`icon_custom_emoji_id` на кнопках, `<tg-emoji>` в тексте)
   могут стать невалидными → Telegram отклоняет ВСЁ сообщение (400). Есть
   центральный фолбэк в API-трансформере (`stripPremiumDecorations`): при ошибке
   повторяет отправку без премиум-эмодзи. Не ломать этот retry.
2. **Бот отвечает только в личке** (guard `isUserAction` + проверка `ctx.chat.type`).
   События канала (chat_member, chat_join_request) НЕ фильтровать — они начисляют рефералы.
3. **Прямая оплата — только админ** (`directPayEnabled = isAdmin`). Не включать всем
   до одобрения Payme+Click.
4. **`ADMIN_ID`** = `process.env.TELEGRAM_ADMIN_CHAT_ID`. `isAdmin(ctx)` сверяет `ctx.from.id`.
5. **i18n:** при добавлении ключа — во все три словаря (RU/EN/UZ), иначе `t()` вернёт
   сам ключ (виден пользователю). Проверка: сравнить число ключей в RU/EN/UZ.
6. **Схема:** новое поле — и в `schema.prisma`, и в `ensureSchema` (сырой ALTER),
   и `npx prisma generate`.
7. **Деньги — только целыми:** суммы Payme/Click сверять в тийинах (сум×100),
   не во float. `TopUp.amount` хранится как Float сум (легаси) — сравнивать через round.
8. **Секреты** (`PAYME_KEY`, `CLICK_SECRET_KEY`, seed-фразы) — только в Railway →
   Variables, НИКОГДА в коде/чате/логах. `.env` в .gitignore.
9. **Windows/PowerShell:** git-коммиты с кириллицей или `-` в начале строки ломают
   here-string — писать сообщение коммита в файл и `git commit -F <файл>`.
10. **Postgres «SSL error: unexpected eof / connection reset by peer»** в логах —
    это норма (закрытие соединений/перезапуск), не баг.

---

## 8. Что сделано / что в работе / что заблокировано

**Готово:** Payme (песочница пройдена), Click (код готов), рефералы, опрос,
фоновые рассылки, прямая оплата для админа, оптовые цены, Fragment (ручная выдача),
отзывы, промо-пост, лента продаж.

**В работе (настройка, не код):** Click — прописать callback-URL в кабинете
(оба поля = `/api/click`), сверить env (`CLICK_SERVICE_ID=110470` и секретный ключ),
пройти тесты Click, активировать сервис (в кабинете сервис уже «Активен»).

**Заблокировано (ждём владельца):**
- **ИКПУ** для фискализации (Payme и Click) — от бухгалтера.
- После одобрения Payme+Click — снять флаг «только админ» у прямой оплаты.
- Автоматизация Fragment — решение про кошелёк/seed (пока ручная выдача).

---

## 9. Как проверять после изменений

1. `npx tsc --noEmit` — типы.
2. `npm test` — 101 тест (доменная логика).
3. `npm run build` — сборка Next.
4. Деплой — `git push` (Railway сам собирает). Endpoints живые:
   `GET /api/payme` и `/api/click` → `{"ok":true,...}`.
5. Бот — проверять в личке под аккаунтом админа (`TELEGRAM_ADMIN_CHAT_ID`).
