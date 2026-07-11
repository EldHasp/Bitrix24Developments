# lead-rating-api

Мини-сервис расчёта **Рейтинга лида** + **активити БП** Битрикс24 (Express, Layero `node_web`).

Источник весов: `data/scoring-table.json`.  
Полный разбор граблей: [`docs/bitrix-local-app-activity.md`](../../docs/bitrix-local-app-activity.md).

**Статус (2026-07, portal `braincon.bitrix24.ru`):** рабочий прод-контур — локальное приложение + активити + OAuth + отдельный входящий вебхук в Layero; БП `[AUTO] Категория клиента` на create/update; запись рейтинга только при изменении значения.

## Локальный запуск

```powershell
cd apps/lead-rating-api
$env:API_KEY="test-secret"
node server.mjs
```

## Деплой на Layero

Проект: [lead-rating-api](https://app.layero.ru/projects/8327e003-1996-4d22-a060-7732e3e98375)

| URL | Назначение |
|-----|------------|
| `https://eldaga-lead-rating-api.preview.layero.ru` | **рабочий** URL для Битрикс (preview) |
| `https://eldaga-lead-rating-api.layero.ru` | apex (для handler’ов Битрикс не предпочитать) |

```powershell
npx layero deploy --json --yes --promote
```

После деплоя новые env подхватываются только с этим redeploy. Файл OAuth на диске контейнера **стирается**.

### Env в Layero

| Переменная | Зачем |
|------------|--------|
| `API_KEY` | защита HTTP API |
| `PUBLIC_BASE_URL` | `https://eldaga-lead-rating-api.preview.layero.ru` |
| `BITRIX_CLIENT_ID` | код приложения (`local.…`) из карточки локального приложения |
| `BITRIX_CLIENT_SECRET` | ключ приложения из той же карточки |
| `BITRIX_WEBHOOK_URL` | **отдельный** входящий вебхук портала (`crm`+`bizproc`) — запас после деплоев |
| `BITRIX_REFRESH_TOKEN` | альтернатива вебхуку (реже нужно) |
| `BITRIX_DOMAIN` | `braincon.bitrix24.ru` (с refresh) |

### Отдельный вебхук (не переиспользовать чужой)

1. Разработчикам → **Другое** → **Входящий вебхук** (создание).
2. Права: **crm** + **bizproc**.
3. Список: **Интеграции** (`/devops/list/`) → открыть → переименовать (напр. `lead-rating-api (Layero)`).
4. URL → только Layero `BITRIX_WEBHOOK_URL` (не git, не чат).
5. **Не** жать «Перегенерировать» на вебхуках, которые уже стоят в других системах — старый URL умрёт.
6. Redeploy после добавления env.

Это **ваш** секрет на **вашем** сервере для одного портала. Чужим порталам / приложениям Маркета вебхук не отдают; им нужен OAuth при установке.

Проверка устойчивости: `GET /bitrix/debug/oauth-status` → `hasWebhook: true`.  
Зависания БП: `GET /bitrix/debug/last-activity`.

## Локальное приложение на портале

| Поле | Значение |
|------|----------|
| Тип | Серверное |
| Путь обработчика | `…preview.layero.ru/bitrix/handler` |
| Путь установки | `…preview.layero.ru/bitrix/install` |
| Права | `crm`, `bizproc` |
| Пункт меню | напр. «Рейтинг лида [Агаев Э.А.]» |

`/bitrix/activity` в карточку приложения **не** ставить — только в `bizproc.activity.add`.

Пункт меню — справка + save OAuth + «Перерегистрировать активити».  
«Готово» — только после **Переустановить** / install.

## БП лида

Шаблон: `[AUTO] Категория клиента` (или аналог).

- Запуск: **при создании** + **при изменении**.
- Действие: **Действия приложений → Расчёт рейтинга лида**.
- AutoFromLead = Да, WriteToLead = Да; критерии можно не мапить.
- Период ожидания 10+ мин (таймаут; ответ обычно секунды).
- Активити пишет `UF_CRM_1783504656939` **только если рейтинг изменился**.
- Не пишите каждый раз отладочное поле без условия — иначе лишний цикл «при изменении».

Возвраты активити: `RatingEnumId`, `RatingLabel`, `Avg`, `ActiveCount`.

## Эндпоинты

| Метод | Путь | Назначение |
|-------|------|------------|
| POST | `/bitrix/install` | установка → регистрация активити |
| ALL | `/bitrix/handler` | UI меню + BX24 save-auth |
| ALL | `/bitrix/activity` | шаг БП → расчёт → `bizproc.event.send` |
| POST | `/bitrix/save-auth` | сохранить OAuth |
| GET | `/bitrix/debug/last-activity` | лог вызовов активити |
| GET | `/bitrix/debug/oauth-status` | есть ли webhook/refresh/file |
| POST | `/v1/lead-rating/calculate` | HTTP API (`X-Api-Key`) |

## HTTP API (запасной путь)

```http
POST /v1/lead-rating/calculate
X-Api-Key: <API_KEY>
Content-Type: application/json

{"fields":{"UF_CRM_1783351191840":"3198","UF_CRM_1783352136338":"3212"}}
```

## Смена весов

1. `internal/lead-rating/bp-scoring-table.json` → копия в `apps/lead-rating-api/data/`
2. при смене подписей списков — ещё `data/field-meta.json`
3. `npx layero deploy --yes --promote`
4. при смене HANDLER URL — переустановить локальное приложение
