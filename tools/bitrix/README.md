# Bitrix REST tools

Локальные скрипты для запросов к облачному Битрикс24 и сохранения ответов в этот репозиторий.

## Настройка (один раз)

1. Скопируйте `.env.example` → `.env` в **корне** `Bitrix24Developments`.
2. Вставьте полный URL входящего вебхука:

```env
BITRIX_WEBHOOK_URL=https://YOUR.bitrix24.ru/rest/USER_ID/WEBHOOK_CODE/
```

Файл `.env` в git не попадает.

## Как пользоваться

Из корня репозитория:

```powershell
# Все enum-поля лида (снимок в snapshots/bitrix/)
node tools/bitrix/dump-lead-enums.mjs

# Только поля рейтинга / категории клиента → ещё и в internal/lead-rating/
node tools/bitrix/dump-lead-rating-enums.mjs
```

Общий клиент: `tools/bitrix/lib/rest.mjs` — его же используют новые дампы.

## Куда пишутся данные

| Путь | Назначение |
|------|------------|
| `snapshots/bitrix/*.json` | Сырые снимки API с датой (история) |
| `internal/.../*.json` + `.md` | Актуальная выжимка под конкретную задачу |

## Новый типичный дамп

1. Скопируйте `dump-lead-rating-enums.mjs` как шаблон.
2. Поменяйте фильтр полей / метод REST.
3. Пишите результат в `snapshots/bitrix/` и при необходимости в папку задачи в `internal/` или `external/`.
