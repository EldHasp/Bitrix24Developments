/**
 * Массовая синхронизация «Группа источника» / «Группа групп» по справочнику 1086.
 * Порт логики из BitrixCore_Library/SourceGroupsLeadSyncService.js (Apps Script).
 */

import { buildBatchCmd, unwrapBatchMaps, sleep } from "./bitrix-batch.mjs";

export const SOURCE_GROUPS_ACTIVITY_CODE = "lead_source_groups_sync";

export const DEFAULT_SOURCE_GROUPS_CONFIG = {
  entityTypeId: 1086,
  sourceGroupsIblockId: 204,
  groupsOfGroupsIblockId: 206,
  iblockTypeId: "lists",
  directorySelect: [
    "id",
    "title",
    "ufCrm34Source",
    "ufCrm34SourceGroup",
    "ufCrm34GroupsGroup",
  ],
};

function normId(v) {
  if (v == null || v === "") return "";
  if (typeof v === "object") {
    if (v.id != null) return String(v.id).trim();
    if (Array.isArray(v) && v.length) return normId(v[0]);
    const keys = Object.keys(v);
    if (keys.length === 1) return normId(v[keys[0]]);
  }
  return String(v).trim();
}

function firstListPropertyValue(prop) {
  if (prop == null || prop === "") return "";
  if (typeof prop === "object" && !Array.isArray(prop)) {
    for (const key of Object.keys(prop)) {
      const cell = prop[key];
      if (cell && typeof cell === "object") {
        if (cell.value != null && cell.value !== "") return String(cell.value).trim();
        if (cell.VALUE != null && cell.VALUE !== "") return String(cell.VALUE).trim();
      }
      const nested = normId(cell);
      if (nested) return nested;
    }
    return "";
  }
  return normId(prop);
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

/** Дата → ISO с +03:00 (как в GAS ParseDateToIso). dateTo — exclusive upper bound. */
export function buildLeadSyncPeriod(dateFrom, dateTo, dateField = "DATE_MODIFY") {
  const field = dateField === "DATE_CREATE" ? "DATE_CREATE" : "DATE_MODIFY";
  const start = toIsoBound(dateFrom, "00:00:00");
  const end = toIsoBound(dateTo, "00:00:00");
  if (!start || !end) throw new Error("Некорректный диапазон дат (DateFrom / DateTo).");
  return { start, end, dateField: field };
}

function toIsoBound(raw, timeStr) {
  if (raw == null || raw === "") return "";
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return `${raw.getFullYear()}-${pad2(raw.getMonth() + 1)}-${pad2(raw.getDate())}T${timeStr}+03:00`;
  }
  const s = String(raw).trim();
  if (!s) return "";
  // DD.MM.YYYY or DD.MM.YYYY HH:MM:SS
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) {
    return `${m[3]}-${pad2(m[2])}-${pad2(m[1])}T${timeStr}+03:00`;
  }
  // YYYY-MM-DD…
  const m2 = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m2) {
    return `${m2[1]}-${m2[2]}-${m2[3]}T${timeStr}+03:00`;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Не удалось разобрать дату: ${s}`);
  }
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${timeStr}+03:00`;
}

function intProp(raw, fallback) {
  if (raw == null || String(raw).trim() === "") return fallback;
  const n = parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {Record<string, unknown>} properties — свойства активити БП
 */
export function parseSourceGroupsActivityProps(properties = {}) {
  const dateFieldRaw = String(properties.DateField || properties.dateField || "DATE_CREATE")
    .trim()
    .toUpperCase();
  return {
    dateFrom: properties.DateFrom ?? properties.dateFrom ?? "",
    dateTo: properties.DateTo ?? properties.dateTo ?? "",
    dateField: dateFieldRaw === "DATE_MODIFY" ? "DATE_MODIFY" : "DATE_CREATE",
    dryRun: isTruthy(properties.DryRun ?? properties.dryRun, false),
    writeToLead: isTruthy(properties.WriteToLead ?? properties.writeToLead, true),
    maxUpdateBatches: Math.max(0, intProp(properties.MaxBatches ?? properties.maxUpdateBatches, 15)),
    updateBatchSize: Math.max(1, Math.min(50, intProp(properties.UpdateBatchSize, 10))),
    sleepMs: Math.max(0, intProp(properties.SleepMs, 0)),
    strictAudit: isTruthy(properties.StrictAudit ?? properties.strictAudit, true),
    entityTypeId: intProp(properties.EntityTypeId, DEFAULT_SOURCE_GROUPS_CONFIG.entityTypeId),
    sourceGroupsIblockId: intProp(
      properties.SourceGroupsIblockId,
      DEFAULT_SOURCE_GROUPS_CONFIG.sourceGroupsIblockId
    ),
    groupsOfGroupsIblockId: intProp(
      properties.GroupsOfGroupsIblockId,
      DEFAULT_SOURCE_GROUPS_CONFIG.groupsOfGroupsIblockId
    ),
    sourceGroupField: String(properties.SourceGroupField || "").trim(),
    groupsGroupField: String(properties.GroupsGroupField || "").trim(),
  };
}

function isTruthy(value, defaultYes) {
  if (value == null || value === "") return defaultYes;
  if (Array.isArray(value)) value = value[0];
  const s = String(value).trim().toLowerCase();
  if (s === "") return defaultYes;
  if (["y", "yes", "true", "1", "да"].includes(s)) return true;
  if (["n", "no", "false", "0", "нет"].includes(s)) return false;
  return defaultYes;
}

/**
 * @param {(method: string, params?: object) => Promise<any>} bx
 * @param {object} options — из parseSourceGroupsActivityProps + log?
 */
export async function syncLeadSourceGroupsByPeriod(bx, options = {}) {
  const log = typeof options.log === "function" ? options.log : () => {};
  const dryRun = !!options.dryRun || options.writeToLead === false;
  const sleepMs = options.sleepMs != null ? options.sleepMs : 0;
  const updateBatchSize = Math.max(1, Math.min(50, options.updateBatchSize || 10));
  const maxUpdateBatches =
    options.maxUpdateBatches != null ? Math.max(0, options.maxUpdateBatches) : 15;
  const strictAudit = options.strictAudit !== false;
  const cfg = {
    ...DEFAULT_SOURCE_GROUPS_CONFIG,
    entityTypeId: options.entityTypeId || DEFAULT_SOURCE_GROUPS_CONFIG.entityTypeId,
    sourceGroupsIblockId:
      options.sourceGroupsIblockId || DEFAULT_SOURCE_GROUPS_CONFIG.sourceGroupsIblockId,
    groupsOfGroupsIblockId:
      options.groupsOfGroupsIblockId || DEFAULT_SOURCE_GROUPS_CONFIG.groupsOfGroupsIblockId,
  };

  const period = buildLeadSyncPeriod(options.dateFrom, options.dateTo, options.dateField);
  log(`Синхронизация групп источников: ${period.start} .. ${period.end} (${period.dateField}), dryRun=${dryRun}`);

  const sources = await fetchCrmSources(bx);
  log(`CRM SOURCE: ${sources.length}`);
  const directoryItems = await fetchAllSourceDirectoryItems(bx, cfg);
  log(`Справочник ${cfg.entityTypeId}: ${directoryItems.length} строк`);

  const sourceIndex = buildCrmSourceIndex(sources);
  const audit = auditSourceDirectory(sources, directoryItems, sourceIndex);
  if (strictAudit && !audit.ok) {
    throw new Error(formatAuditAbort(audit));
  }
  if (!audit.ok) {
    log(`WARN: аудит справочника с замечаниями (StrictAudit=N): ${audit.blockingErrors.join("; ")}`);
  }

  const list204 = await fetchListElementsAll(bx, cfg.sourceGroupsIblockId, cfg.iblockTypeId);
  const list206 = await fetchListElementsAll(bx, cfg.groupsOfGroupsIblockId, cfg.iblockTypeId);
  const iblock204ById = indexListElementsById(list204);
  const iblock206Ids = new Set(
    list206.map((el) => normId(el.ID)).filter(Boolean)
  );
  const groupsGroupPropKey = detectGroupsGroupPropertyKey(list204, directoryItems);

  const validation = validateSourceDirectoryStructure(
    directoryItems,
    iblock204ById,
    iblock206Ids,
    groupsGroupPropKey
  );
  if (validation.blockingErrors.length > 0) {
    throw new Error(
      "Структура справочника/списков: " + validation.blockingErrors.slice(0, 5).join("; ")
    );
  }

  const leadFields = await resolveLeadSourceGroupFieldIds(bx, options);
  const targetBySource = buildTargetBySourceMap(
    directoryItems,
    iblock204ById,
    groupsGroupPropKey,
    sourceIndex
  );

  const leadIdsResult = await collectLeadIdsByCursor(
    bx,
    {
      [`>=${period.dateField}`]: period.start,
      [`<${period.dateField}`]: period.end,
    },
    log
  );
  const leadIds = leadIdsResult.ids;
  log(`Лидов в диапазоне: ${leadIds.length}`);

  const selectFields = [
    "ID",
    "TITLE",
    "SOURCE_ID",
    leadFields.sourceGroupId,
    leadFields.groupsGroupId,
  ];
  const leads = await fetchLeadsByIdsInBatch(bx, leadIds, selectFields, log);

  const stats = {
    leadsTotal: leads.length,
    skippedNoSource: 0,
    skippedNoDirectory: 0,
    alreadyOk: 0,
    toUpdate: 0,
    updated: 0,
    updateErrors: 0,
    remaining: 0,
    applyStoppedEarly: false,
    applyBatchesExecuted: 0,
  };

  /** @type {Array<{id:string, fields:Object}>} */
  const pendingUpdates = [];

  for (const lead of leads) {
    const leadId = normId(lead.ID);
    const sourceId = normId(lead.SOURCE_ID);
    if (!sourceId) {
      stats.skippedNoSource++;
      continue;
    }
    const target = targetBySource.get(sourceId);
    if (!target) {
      stats.skippedNoDirectory++;
      continue;
    }
    const curSourceGroup = normId(lead[leadFields.sourceGroupId]);
    const curGroupsGroup = normId(lead[leadFields.groupsGroupId]);
    const needSourceGroup = curSourceGroup !== target.sourceGroupId;
    const needGroupsGroup = curGroupsGroup !== target.groupsGroupId;
    if (!needSourceGroup && !needGroupsGroup) {
      stats.alreadyOk++;
      continue;
    }
    const fields = {};
    if (needSourceGroup) fields[leadFields.sourceGroupId] = target.sourceGroupId;
    if (needGroupsGroup) fields[leadFields.groupsGroupId] = target.groupsGroupId;
    stats.toUpdate++;
    pendingUpdates.push({ id: leadId, fields });
  }

  log(
    `К обновлению: ${stats.toUpdate}, без изменений: ${stats.alreadyOk}, нет справочника: ${stats.skippedNoDirectory}, без источника: ${stats.skippedNoSource}`
  );

  if (!dryRun && pendingUpdates.length > 0) {
    const upd = await applyLeadFieldUpdatesBatch(
      bx,
      pendingUpdates,
      sleepMs,
      updateBatchSize,
      maxUpdateBatches,
      log
    );
    stats.updated = upd.updated;
    stats.updateErrors = upd.errors;
    stats.applyStoppedEarly = !!upd.stoppedEarly;
    stats.applyBatchesExecuted = upd.batchesExecuted;
    stats.remaining = upd.remainingInQueue || 0;
  } else if (dryRun) {
    // В dryRun Remaining = вся очередь (для отладки цикла БП)
    if (maxUpdateBatches > 0) {
      const cap = maxUpdateBatches * updateBatchSize;
      stats.remaining = Math.max(0, pendingUpdates.length - cap);
      stats.updated = 0;
    } else {
      stats.remaining = 0;
    }
  }

  // Если остановились по лимиту пачек — Remaining уже задан.
  // Если обновили всё из toUpdate за этот тик — Remaining=0, даже если в CRM ещё будут новые.
  if (!dryRun && !stats.applyStoppedEarly) {
    stats.remaining = 0;
  }

  const statusText = dryRun
    ? `dryRun: к обновлению ${stats.toUpdate}, remaining≈${stats.remaining}, лидов ${stats.leadsTotal}`
    : `обновлено ${stats.updated}/${stats.toUpdate}, remaining=${stats.remaining}, ошибок ${stats.updateErrors}`;

  return {
    ok: true,
    dryRun,
    period,
    dateField: period.dateField,
    targetSources: targetBySource.size,
    directoryRows: directoryItems.length,
    crmSourcesCount: sources.length,
    stats,
    statusText,
    returnValues: {
      Updated: String(stats.updated),
      AlreadyOk: String(stats.alreadyOk),
      ToUpdate: String(stats.toUpdate),
      Remaining: String(stats.remaining),
      SkippedNoSource: String(stats.skippedNoSource),
      SkippedNoDirectory: String(stats.skippedNoDirectory),
      UpdateErrors: String(stats.updateErrors),
      LeadsTotal: String(stats.leadsTotal),
      StatusText: statusText,
      Ok: "Y",
    },
  };
}

export function buildSourceGroupsActivityDefinition(handlerUrl, authUserId) {
  const properties = {
    DateFrom: {
      Name: { ru: "Дата с (включительно)", en: "Date from (inclusive)" },
      Description: {
        ru: "Нижняя граница периода. DATE_CREATE или DATE_MODIFY — см. поле ниже.",
        en: "Lower bound of the period.",
      },
      Type: "string",
      Required: "Y",
      Multiple: "N",
    },
    DateTo: {
      Name: { ru: "Дата по (исключительно)", en: "Date to (exclusive)" },
      Description: {
        ru: "Верхняя граница не включается (как в AppScript: dateTo exclusive).",
        en: "Exclusive upper bound.",
      },
      Type: "string",
      Required: "Y",
      Multiple: "N",
    },
    DateField: {
      Name: { ru: "Поле даты", en: "Date field" },
      Description: {
        ru: "DATE_CREATE или DATE_MODIFY",
        en: "DATE_CREATE or DATE_MODIFY",
      },
      Type: "string",
      Required: "N",
      Multiple: "N",
      Default: "DATE_CREATE",
    },
    MaxBatches: {
      Name: { ru: "Макс. пачек за вызов", en: "Max batches per call" },
      Description: {
        ru: "Пачка = UpdateBatchSize лидов. По умолчанию 15 (~150 лидов). 0 = без лимита (риск таймаута).",
        en: "Default 15. 0 = unlimited.",
      },
      Type: "int",
      Required: "N",
      Multiple: "N",
      Default: "15",
    },
    UpdateBatchSize: {
      Name: { ru: "Размер пачки обновления", en: "Update batch size" },
      Type: "int",
      Required: "N",
      Multiple: "N",
      Default: "10",
    },
    DryRun: {
      Name: { ru: "Только отчёт (без записи)", en: "Dry run" },
      Type: "bool",
      Required: "N",
      Multiple: "N",
      Default: "N",
    },
    WriteToLead: {
      Name: { ru: "Записывать в лиды", en: "Write to leads" },
      Type: "bool",
      Required: "N",
      Multiple: "N",
      Default: "Y",
    },
    StrictAudit: {
      Name: { ru: "Строгий аудит справочника", en: "Strict directory audit" },
      Description: {
        ru: "Да = остановить при дублях/дырах в справочнике 1086 (как в Google).",
        en: "Abort on directory vs CRM mismatches.",
      },
      Type: "bool",
      Required: "N",
      Multiple: "N",
      Default: "Y",
    },
  };

  const def = {
    CODE: SOURCE_GROUPS_ACTIVITY_CODE,
    HANDLER: handlerUrl,
    USE_SUBSCRIPTION: "Y",
    NAME: {
      ru: "Синхронизация групп источников (период)",
      en: "Sync lead source groups (period)",
    },
    DESCRIPTION: {
      ru: "Массово выставляет «Группа источника» и «Группа групп» по справочнику 1086 за период. Возврат Remaining — для цикла БП.",
      en: "Bulk sync source group fields from directory 1086 for a date range. Use Remaining to loop in BP.",
    },
    DOCUMENT_TYPE: ["crm", "CCrmDocumentLead", "LEAD"],
    FILTER: {
      INCLUDE: [["crm", "CCrmDocumentLead", "LEAD"]],
    },
    PROPERTIES: properties,
    RETURN_PROPERTIES: {
      Updated: { Name: { ru: "Обновлено", en: "Updated" }, Type: "int" },
      AlreadyOk: { Name: { ru: "Уже ок", en: "Already ok" }, Type: "int" },
      ToUpdate: { Name: { ru: "К обновлению", en: "To update" }, Type: "int" },
      Remaining: {
        Name: { ru: "Осталось в очереди", en: "Remaining" },
        Type: "int",
      },
      SkippedNoSource: {
        Name: { ru: "Без источника", en: "No source" },
        Type: "int",
      },
      SkippedNoDirectory: {
        Name: { ru: "Нет в справочнике", en: "Not in directory" },
        Type: "int",
      },
      UpdateErrors: { Name: { ru: "Ошибок записи", en: "Update errors" }, Type: "int" },
      LeadsTotal: { Name: { ru: "Лидов в выборке", en: "Leads total" }, Type: "int" },
      StatusText: { Name: { ru: "Статус (текст)", en: "Status text" }, Type: "string" },
      Ok: { Name: { ru: "Успех", en: "Ok" }, Type: "string" },
    },
  };

  const uid = Number(authUserId);
  if (Number.isFinite(uid) && uid > 0) {
    def.AUTH_USER_ID = uid;
  }
  return def;
}

// --- internals ---

async function fetchCrmSources(bx) {
  const result = await bx("crm.status.list", { filter: { ENTITY_ID: "SOURCE" } });
  if (!Array.isArray(result)) throw new Error("crm.status.list SOURCE: нет данных");
  return result;
}

async function fetchAllSourceDirectoryItems(bx, cfg) {
  const all = [];
  let start = 0;
  let total = Infinity;
  while (start < total) {
    const chunk = await fetchCrmItemListBatchChunk(bx, cfg, start);
    if (chunk.items.length) all.push(...chunk.items);
    if (chunk.total != null && !Number.isNaN(chunk.total)) total = chunk.total;
    if (!chunk.items.length) break;
    if (chunk.nextStart == null || chunk.nextStart <= start) break;
    start = chunk.nextStart;
  }
  return all;
}

async function fetchCrmItemListBatchChunk(bx, cfg, startOffset) {
  const pages = 50;
  const pageSize = 50;
  const cmd = {};
  for (let i = 0; i < pages; i++) {
    cmd[`p${i}`] = buildBatchCmd("crm.item.list", {
      entityTypeId: cfg.entityTypeId,
      order: { id: "ASC" },
      select: cfg.directorySelect,
      start: startOffset + i * pageSize,
    });
  }
  const batchRes = await bx("batch", { halt: 1, cmd });
  const { resultMap, errorMap } = unwrapBatchMaps(batchRes);
  if (Object.keys(errorMap).length > 0) {
    throw new Error("crm.item.list batch: " + JSON.stringify(errorMap));
  }
  const items = [];
  let total = null;
  let lastNonEmptyStart = startOffset;
  let shouldStop = false;
  for (let i = 0; i < pages; i++) {
    const page = extractCrmItemListPage(resultMap[`p${i}`]);
    if (page.total != null) total = page.total;
    if (page.items.length > 0) {
      items.push(...page.items);
      lastNonEmptyStart = startOffset + (i + 1) * pageSize;
    }
    if (page.items.length < pageSize) {
      shouldStop = true;
      break;
    }
  }
  let nextStart = null;
  if (!shouldStop && items.length >= pages * pageSize) nextStart = lastNonEmptyStart;
  return { items, total, nextStart };
}

function extractCrmItemListPage(raw) {
  if (!raw) return { items: [], total: null };
  if (Array.isArray(raw)) return { items: raw, total: null };
  if (raw.items && Array.isArray(raw.items)) {
    const total = raw.total != null ? Number(raw.total) : null;
    return { items: raw.items, total: Number.isNaN(total) ? null : total };
  }
  return { items: [], total: null };
}

async function fetchListElementsAll(bx, iblockId, iblockTypeId) {
  const all = [];
  let start = 0;
  for (;;) {
    const rows = await bx("lists.element.get", {
      IBLOCK_TYPE_ID: iblockTypeId,
      IBLOCK_ID: iblockId,
      start,
    });
    const list = Array.isArray(rows) ? rows : [];
    if (list.length) all.push(...list);
    if (list.length < 50) break;
    start += 50;
  }
  return all;
}

function indexListElementsById(elements) {
  const map = new Map();
  for (const el of elements) {
    const id = normId(el.ID);
    if (id) map.set(id, el);
  }
  return map;
}

function detectGroupsGroupPropertyKey(list204, directoryItems) {
  const sampleDir = directoryItems.find(
    (d) => normId(d.ufCrm34SourceGroup) && normId(d.ufCrm34GroupsGroup)
  );
  if (!sampleDir) return "PROPERTY_2824";
  const el204Id = normId(sampleDir.ufCrm34SourceGroup);
  const expectedGg = normId(sampleDir.ufCrm34GroupsGroup);
  const el = list204.find((e) => normId(e.ID) === el204Id);
  if (!el) return "PROPERTY_2824";
  for (const key of Object.keys(el)) {
    if (!key.startsWith("PROPERTY_")) continue;
    const v = firstListPropertyValue(el[key]);
    if (v && v === expectedGg) return key;
  }
  return "PROPERTY_2824";
}

function buildCrmSourceIndex(sources) {
  const byStatusId = new Map();
  const idToStatusId = new Map();
  for (const s of sources) {
    const statusId = normId(s.STATUS_ID);
    const numId = normId(s.ID);
    if (statusId) byStatusId.set(statusId, s);
    if (numId && statusId) idToStatusId.set(numId, statusId);
  }
  return { byStatusId, idToStatusId };
}

function normalizeDirectorySourceKey(raw, sourceIndex) {
  const v = normId(raw);
  if (!v) return "";
  if (sourceIndex.byStatusId.has(v)) return v;
  if (sourceIndex.idToStatusId.has(v)) return sourceIndex.idToStatusId.get(v);
  return v;
}

function auditSourceDirectory(sources, directoryItems, sourceIndex) {
  const crmByStatusId = sourceIndex.byStatusId;
  const keyToRows = new Map();
  const emptyRows = [];
  for (const row of directoryItems) {
    const dirId = normId(row.id);
    const key = normalizeDirectorySourceKey(row.ufCrm34Source, sourceIndex);
    if (!key) {
      emptyRows.push({ directoryId: dirId, title: row.title || "" });
      continue;
    }
    if (!keyToRows.has(key)) keyToRows.set(key, []);
    keyToRows.get(key).push({ directoryId: dirId, title: row.title || "" });
  }
  const duplicateSources = [];
  for (const [key, rows] of keyToRows) {
    if (rows.length <= 1) continue;
    const crmRow = crmByStatusId.get(key);
    duplicateSources.push({
      sourceId: key,
      name: crmRow ? String(crmRow.NAME || "") : "",
      ids: rows.map((r) => r.directoryId),
    });
  }
  const missingSources = [];
  for (const s of sources) {
    const sid = normId(s.STATUS_ID);
    if (!sid) continue;
    if (!keyToRows.has(sid)) {
      missingSources.push({
        statusId: sid,
        name: String(s.NAME || "").trim(),
        id: normId(s.ID),
      });
    }
  }
  const extraInDirectory = [];
  for (const [key, rows] of keyToRows) {
    if (crmByStatusId.has(key)) continue;
    for (const r of rows) {
      extraInDirectory.push({
        directoryId: r.directoryId,
        ufCrm34Source: key,
        title: r.title,
      });
    }
  }
  const blockingErrors = [];
  if (duplicateSources.length)
    blockingErrors.push(`Дубли источника в справочнике: ${duplicateSources.length}`);
  if (missingSources.length)
    blockingErrors.push(`В справочнике нет источников CRM: ${missingSources.length}`);
  if (emptyRows.length)
    blockingErrors.push(`Строки без «Источник»: ${emptyRows.length}`);
  if (extraInDirectory.length)
    blockingErrors.push(`Лишние строки справочника: ${extraInDirectory.length}`);
  return {
    ok: blockingErrors.length === 0,
    crmCount: sources.length,
    directoryRowCount: directoryItems.length,
    duplicateSources,
    missingSources,
    extraInDirectory,
    emptyRows,
    blockingErrors,
  };
}

function formatAuditAbort(audit) {
  const parts = [...audit.blockingErrors];
  if (audit.missingSources?.length) {
    parts.push(
      "нет в справочнике: " +
        audit.missingSources
          .slice(0, 12)
          .map((m) => m.statusId)
          .join(", ")
    );
  }
  return "Начальная проверка не пройдена. " + parts.join(". ");
}

function validateSourceDirectoryStructure(
  directoryItems,
  iblock204ById,
  iblock206Ids,
  groupsGroupPropKey
) {
  const blockingErrors = [];
  const warnings = [];
  for (const row of directoryItems) {
    const src = normId(row.ufCrm34Source);
    if (!src) continue;
    const g204 = normId(row.ufCrm34SourceGroup);
    if (!g204) {
      warnings.push(`Источник ${src}: пустая ufCrm34SourceGroup`);
      continue;
    }
    if (!iblock204ById.has(g204)) {
      blockingErrors.push(`Источник ${src}: группа 204 id=${g204} не найдена`);
      continue;
    }
    const el204 = iblock204ById.get(g204);
    const g206from204 = firstListPropertyValue(el204[groupsGroupPropKey]);
    if (!g206from204) {
      blockingErrors.push(`Источник ${src}: у 204 id=${g204} пустая группа групп`);
      continue;
    }
    if (!iblock206Ids.has(g206from204)) {
      blockingErrors.push(`Источник ${src}: группа групп ${g206from204} нет в 206`);
    }
  }
  return { blockingErrors, warnings };
}

function buildTargetBySourceMap(directoryItems, iblock204ById, groupsGroupPropKey, sourceIndex) {
  const map = new Map();
  for (const row of directoryItems) {
    const src = normalizeDirectorySourceKey(row.ufCrm34Source, sourceIndex);
    if (!src || map.has(src)) continue;
    const el204Id = normId(row.ufCrm34SourceGroup);
    const el204 = iblock204ById.get(el204Id);
    if (!el204) continue;
    const sourceGroupId = normId(el204.ID);
    const groupsGroupId = firstListPropertyValue(el204[groupsGroupPropKey]);
    if (!sourceGroupId || !groupsGroupId) continue;
    map.set(src, {
      sourceGroupId,
      groupsGroupId,
      directoryId: normId(row.id),
    });
  }
  return map;
}

async function resolveLeadSourceGroupFieldIds(bx, options = {}) {
  if (options.sourceGroupField && options.groupsGroupField) {
    return {
      sourceGroupId: options.sourceGroupField,
      groupsGroupId: options.groupsGroupField,
    };
  }
  const allFields = await bx("crm.lead.fields", {});
  if (!allFields || typeof allFields !== "object") {
    throw new Error("crm.lead.fields: нет данных");
  }
  const liveMap = {};
  for (const key of Object.keys(allFields)) {
    const f = allFields[key];
    let russianName = "";
    if (key.indexOf("UF_CRM_") === 0) {
      russianName = f.listLabel || f.formLabel || f.filterLabel || key;
    } else {
      russianName = f.title || key;
    }
    liveMap[String(russianName)] = { id: key, type: f.type };
  }
  const sg =
    liveMap["Группа источника"] ||
    (options.sourceGroupField ? { id: options.sourceGroupField } : null);
  const gg =
    liveMap["Группа групп источников"] ||
    liveMap["Группа групп"] ||
    (options.groupsGroupField ? { id: options.groupsGroupField } : null);
  if (!sg?.id) throw new Error('Поле лида «Группа источника» не найдено в crm.lead.fields');
  if (!gg?.id) throw new Error('Поле лида «Группа групп источников» не найдено в crm.lead.fields');
  return { sourceGroupId: sg.id, groupsGroupId: gg.id };
}

async function collectLeadIdsByCursor(bx, filter, log) {
  const ids = [];
  const seen = new Set();
  const pagesPerBatch = 20;
  let lastId = 0;
  let batchNo = 0;

  for (;;) {
    const cmd = {};
    for (let i = 0; i < pagesPerBatch; i++) {
      const key = `p${i}`;
      if (i === 0) {
        const reqFilter = { ...filter };
        if (lastId > 0) reqFilter[">ID"] = lastId;
        cmd[key] = buildBatchCmd("crm.lead.list", {
          filter: reqFilter,
          order: { ID: "ASC" },
          select: ["ID"],
          start: 0,
        });
      } else {
        cmd[key] = buildBatchCmd("crm.lead.list", {
          filter: { ...filter, ">ID": `$result[p${i - 1}][49][ID]` },
          order: { ID: "ASC" },
          select: ["ID"],
          start: 0,
        });
      }
    }
    batchNo++;
    const batchRes = await bx("batch", { halt: 1, cmd });
    const { resultMap, errorMap } = unwrapBatchMaps(batchRes);
    if (Object.keys(errorMap).length > 0) {
      log(`WARN: ошибки batch при сборе ID: ${JSON.stringify(errorMap)}`);
      break;
    }
    let anyRows = false;
    let shouldStop = false;
    let lastTailIdInBatch = lastId;
    let addedInBatch = 0;
    for (let i = 0; i < pagesPerBatch; i++) {
      const rows = Array.isArray(resultMap[`p${i}`]) ? resultMap[`p${i}`] : [];
      if (rows.length > 0) anyRows = true;
      for (const row of rows) {
        const id = row?.ID != null ? String(row.ID) : "";
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        addedInBatch++;
      }
      if (rows.length > 0) {
        const tailId = Number(rows[rows.length - 1]?.ID);
        if (Number.isFinite(tailId) && tailId > lastTailIdInBatch) lastTailIdInBatch = tailId;
      }
      if (rows.length < 50) {
        shouldStop = true;
        break;
      }
    }
    log(`ID batch ${batchNo}: +${addedInBatch}, всего ${ids.length}`);
    if (!anyRows) break;
    if (lastTailIdInBatch <= lastId) break;
    lastId = lastTailIdInBatch;
    if (shouldStop) break;
  }
  return { ids, total: ids.length };
}

async function fetchLeadsByIdsInBatch(bx, leadIds, selectFields, log) {
  const rowsOut = [];
  const seen = new Set();
  let i = 0;
  let batchNo = 0;
  while (i < leadIds.length) {
    const cmd = {};
    let cmdCount = 0;
    while (cmdCount < 50 && i < leadIds.length) {
      const chunk = leadIds.slice(i, i + 50);
      cmd[`lead_by_id_${cmdCount}`] = buildBatchCmd("crm.lead.list", {
        filter: { "@ID": chunk },
        select: selectFields,
      });
      i += 50;
      cmdCount++;
    }
    batchNo++;
    const batchRes = await bx("batch", { halt: 0, cmd });
    const { resultMap } = unwrapBatchMaps(batchRes);
    for (const key of Object.keys(resultMap)) {
      const rows = resultMap[key];
      if (!Array.isArray(rows)) continue;
      for (const lead of rows) {
        const leadId = lead?.ID != null ? String(lead.ID) : "";
        if (!leadId || seen.has(leadId)) continue;
        seen.add(leadId);
        rowsOut.push(lead);
      }
    }
    log(`Данные лидов batch ${batchNo}: ${Math.min(i, leadIds.length)}/${leadIds.length}`);
  }
  return rowsOut;
}

async function applyLeadFieldUpdatesBatch(
  bx,
  updates,
  sleepMs,
  batchSize,
  maxBatches,
  log
) {
  batchSize = Math.max(1, Math.min(50, batchSize || 10));
  maxBatches = maxBatches > 0 ? maxBatches : 0;
  const total = updates.length;
  let updated = 0;
  let errors = 0;
  let batchNo = 0;
  let stoppedEarly = false;
  let remainingInQueue = 0;
  const errorSamples = [];

  for (let i = 0; i < updates.length; i += batchSize) {
    if (maxBatches > 0 && batchNo >= maxBatches) {
      stoppedEarly = true;
      remainingInQueue = updates.length - i;
      log(`Стоп по MaxBatches=${maxBatches}, осталось ${remainingInQueue}`);
      break;
    }
    if (sleepMs > 0) await sleep(sleepMs);
    const slice = updates.slice(i, i + batchSize);
    batchNo++;
    let batchResult = await runLeadUpdateBatchOnce(bx, slice);
    if (batchResult.rateLimited && batchResult.batchErr === slice.length) {
      log("Rate limit — пауза 5с и повтор пачки");
      await sleep(5000);
      batchResult = await runLeadUpdateBatchOnce(bx, slice);
    }
    updated += batchResult.batchOk;
    errors += batchResult.batchErr;
    for (const msg of batchResult.errorSamples) {
      if (errorSamples.length < 8 && !errorSamples.includes(msg)) errorSamples.push(msg);
    }
    log(
      `Пачка ${batchNo}: OK=${batchResult.batchOk}, err=${batchResult.batchErr}, всего OK=${updated}`
    );
  }
  return {
    updated,
    errors,
    errorSamples,
    stoppedEarly,
    batchesExecuted: batchNo,
    remainingInQueue,
  };
}

async function runLeadUpdateBatchOnce(bx, slice) {
  const cmd = {};
  const keyToLeadId = {};
  slice.forEach((item, idx) => {
    const key = `u_${idx}`;
    keyToLeadId[key] = item.id;
    cmd[key] = buildBatchCmd("crm.lead.update", {
      id: item.id,
      fields: item.fields,
    });
  });
  let batchRes;
  try {
    batchRes = await bx("batch", { halt: 0, cmd });
  } catch (e) {
    const topErr = e.message || String(e);
    return {
      batchOk: 0,
      batchErr: slice.length,
      errorSamples: [topErr],
      rateLimited: isRateLimit(topErr),
    };
  }
  const { resultMap, errorMap } = unwrapBatchMaps(batchRes);
  let batchOk = 0;
  let batchErr = 0;
  const errorSamples = [];
  let rateLimited = false;
  for (const k of Object.keys(cmd)) {
    const errVal = errorMap[k];
    const resultVal = resultMap[k];
    if (isBatchCmdSuccess(resultVal, errVal)) {
      batchOk++;
      continue;
    }
    batchErr++;
    const errText =
      formatBatchError(errVal) ||
      (resultVal === false ? "crm.lead.update false" : "нет result");
    if (errorSamples.length < 3) errorSamples.push(`лид ${keyToLeadId[k]}: ${errText}`);
    if (isRateLimit(errText)) rateLimited = true;
  }
  return { batchOk, batchErr, errorSamples, rateLimited };
}

function isBatchCmdSuccess(resultVal, errVal) {
  if (errVal) return false;
  if (resultVal === true || resultVal === 1) return true;
  if (resultVal && typeof resultVal === "object" && resultVal.result === true) return true;
  return false;
}

function formatBatchError(err) {
  if (err == null) return "";
  if (typeof err === "string") return err;
  if (typeof err === "object") {
    const code = err.error || err.ERROR || "";
    const desc = err.error_description || err.ERROR_DESCRIPTION || "";
    if (code || desc) return `${code}${desc ? ": " + desc : ""}`;
    try {
      return JSON.stringify(err);
    } catch {
      return String(err);
    }
  }
  return String(err);
}

function isRateLimit(errText) {
  const t = String(errText || "").toUpperCase();
  return (
    t.includes("QUERY_LIMIT") ||
    t.includes("TOO_MANY") ||
    t.includes("503") ||
    t.includes("OPERATION_TIME") ||
    t.includes("RATE LIMIT")
  );
}
