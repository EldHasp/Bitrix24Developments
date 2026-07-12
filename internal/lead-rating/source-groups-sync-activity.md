# Массовая синхронизация групп источников (активити БП)

**Код активити:** `lead_source_groups_sync`  
**Сервис:** [`apps/lead-rating-api`](../../apps/lead-rating-api/) (то же локальное приложение, что и рейтинг)  
**Источник логики:** [GasBitrixCoreLibrary `SourceGroupsLeadSyncService.js`](https://github.com/EldHasp/GasBitrixCoreLibrary)

## Зачем

Ручной БП «в диапазоне» раньше: пачки ID → итератор → **вложенный** `[AUTO] Обновить Группу Источника` на каждый лид → медленно и зависания.

Онлайн-БП **на один лид** (`[AUTO] Обновить Группу Источника`) **не трогаем** — он работает.

Это активити заменяет **массовую** оболочку (и AppScript-планировщик).

## Схема MANUAL-БП

1. Параметры: `ДатаС`, `ДатаПо` (+ опционально поле даты).
2. Уведомление «запущен».
3. **Цикл пока Remaining > 0** (или один раз, если объём мал):
   - Действия приложений → **Синхронизация групп источников (период)**
   - DateFrom / DateTo / DateField / MaxBatches=15 / WriteToLead=Да
   - Период ожидания ≥ 10 мин
4. Уведомление с `StatusText`.

Убрать: REST список ID, итератор, «Запустить БП Обновить Группу Источника».

## Свойства / возвраты

| Свойство | По умолчанию |
|----------|--------------|
| DateFrom, DateTo | обязательны (DateTo — исключительно) |
| DateField | `DATE_CREATE` |
| MaxBatches | `15` (~150 лидов) |
| UpdateBatchSize | `10` |
| DryRun | Нет |
| WriteToLead | Да |
| StrictAudit | Да (как в Google: дыры/дубли справочника → стоп) |

Возвраты: `Updated`, `AlreadyOk`, `ToUpdate`, `Remaining`, `Skipped*`, `UpdateErrors`, `LeadsTotal`, `StatusText`, `Ok`.

## После деплоя

1. Layero deploy.
2. Права приложения и вебхука: **crm + bizproc + lists**.
3. Переустановить / «Перерегистрировать активити» в меню приложения.
4. В MANUAL-БП добавить новое активити.

HTTP-проверка без БП: `POST /v1/source-groups/sync` с `DateFrom`, `DateTo`, `dryRun: true` (+ API_KEY).
