import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

/** Чертёж / fallback, если в активити не передали ScoringTable */
export const scoringTable = JSON.parse(
  fs.readFileSync(path.join(root, "data", "scoring-table.json"), "utf8")
);
export const thresholdsMeta = JSON.parse(
  fs.readFileSync(path.join(root, "data", "thresholds.json"), "utf8")
);
export const fieldMeta = JSON.parse(
  fs.readFileSync(path.join(root, "data", "field-meta.json"), "utf8")
);

export function normId(value) {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) value = value[0];
  return String(value).trim();
}

/** Достать объект/строку JSON из свойства БП (массив, кавычки, уже-объект). */
function unwrapJsonProp(raw, emptyMsg) {
  let text = raw;
  if (text == null) throw new Error(emptyMsg);
  if (Array.isArray(text)) text = text[0];
  if (typeof text === "object" && text !== null) return text;
  text = String(text).trim();
  if (!text) throw new Error(emptyMsg);
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    try {
      const once = JSON.parse(text);
      if (typeof once === "object" && once !== null) return once;
      text = String(once).trim();
    } catch {
      /* ниже */
    }
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`${emptyMsg}: невалидный JSON (${e.message || e})`);
  }
}

function isPropEmpty(raw) {
  if (raw == null) return true;
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v == null) return true;
  if (typeof v === "string" && !v.trim()) return true;
  if (typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 0) {
    return true;
  }
  return false;
}

/**
 * Распарсить JSON таблицы весов из свойства БП / глобальной константы.
 * Формат: { "UF_CRM_…": { "enumId": 1|2|3|4 } }
 * «Нет данных» в таблицу не включать.
 */
export function parseScoringTable(raw) {
  return validateScoringTable(
    unwrapJsonProp(raw, "Таблица весов пуста")
  );
}

function validateScoringTable(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Таблица весов: корень должен быть объектом полей UF_CRM_*");
  }
  const out = {};
  let weightCount = 0;
  for (const [fieldCode, weightMap] of Object.entries(parsed)) {
    if (!fieldCode || typeof weightMap !== "object" || weightMap == null || Array.isArray(weightMap)) {
      throw new Error(
        `Таблица весов: поле «${fieldCode}» должно быть объектом { "ID": вес }`
      );
    }
    const clean = {};
    for (const [enumId, weight] of Object.entries(weightMap)) {
      const id = String(enumId).trim();
      const w = Number(weight);
      if (!id) continue;
      if (!Number.isFinite(w) || w < 1 || w > 4) {
        throw new Error(
          `Таблица весов: ${fieldCode}.${id} — вес должен быть числом 1…4 (сейчас ${weight})`
        );
      }
      clean[id] = w;
      weightCount += 1;
    }
    if (Object.keys(clean).length) out[fieldCode] = clean;
  }
  if (weightCount === 0) {
    throw new Error("Таблица весов: нет ни одного веса 1…4");
  }
  return out;
}

/**
 * Таблица из свойства активити или fallback на файл в репозитории.
 * @returns {{ table: Record<string, Record<string, number>>, source: "request"|"file" }}
 */
export function resolveScoringTable(rawFromProps) {
  if (isPropEmpty(rawFromProps)) {
    return { table: scoringTable, source: "file" };
  }
  return { table: parseScoringTable(rawFromProps), source: "request" };
}

/**
 * Конфиг итога: куда писать + пороги avg → enumId.
 * Формат:
 * { "field"|"ratingField": "UF_CRM_…", "thresholds": [{ min, max, enumId, label? }] }
 */
export function parseRatingConfig(raw) {
  const parsed = unwrapJsonProp(raw, "RatingConfig пуст");
  return validateRatingConfig(parsed);
}

function validateRatingConfig(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("RatingConfig: корень должен быть объектом");
  }
  const field = String(parsed.field || parsed.ratingField || "").trim();
  if (!field) {
    throw new Error("RatingConfig: укажите field (или ratingField) — код UF поля рейтинга");
  }
  const list = parsed.thresholds;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error("RatingConfig: нужен непустой массив thresholds");
  }
  const thresholds = list.map((t, i) => {
    if (!t || typeof t !== "object") {
      throw new Error(`RatingConfig: thresholds[${i}] не объект`);
    }
    const min = Number(t.min);
    const max = Number(t.max);
    const enumId = String(t.enumId ?? t.id ?? "").trim();
    const label = t.label != null ? String(t.label) : enumId;
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new Error(`RatingConfig: thresholds[${i}] — некорректные min/max`);
    }
    if (!enumId) {
      throw new Error(`RatingConfig: thresholds[${i}] — нужен enumId`);
    }
    return { min, max, enumId, label };
  });
  return { field, ratingField: field, thresholds };
}

/**
 * @returns {{ config: { field: string, ratingField: string, thresholds: object[] }, source: "request"|"file" }}
 */
export function resolveRatingConfig(rawFromProps) {
  if (isPropEmpty(rawFromProps)) {
    const field = String(thresholdsMeta.ratingField || "").trim();
    return {
      config: {
        field,
        ratingField: field,
        thresholds: thresholdsMeta.thresholds,
      },
      source: "file",
    };
  }
  return { config: parseRatingConfig(rawFromProps), source: "request" };
}

/**
 * @param {Record<string, unknown>} fields карта UF_CRM_* → ID значения списка
 * @param {Record<string, Record<string, number>>} [table] таблица весов
 * @param {{ field?: string, ratingField?: string, thresholds: object[] }} [ratingConfig]
 */
export function calculateFromFields(
  fields,
  table = scoringTable,
  ratingConfig = null
) {
  const cfg = ratingConfig || {
    field: thresholdsMeta.ratingField,
    ratingField: thresholdsMeta.ratingField,
    thresholds: thresholdsMeta.thresholds,
  };
  const ratingField = String(cfg.field || cfg.ratingField || "").trim();
  const details = [];
  let sum = 0;
  let count = 0;

  for (const [fieldCode, weightMap] of Object.entries(table)) {
    const enumId = normId(fields?.[fieldCode]);
    if (!enumId) {
      details.push({ field: fieldCode, enumId: null, weight: null, skipped: "empty" });
      continue;
    }
    if (!Object.prototype.hasOwnProperty.call(weightMap, enumId)) {
      details.push({
        field: fieldCode,
        enumId,
        weight: null,
        skipped: "no-data-or-unknown",
      });
      continue;
    }
    const weight = Number(weightMap[enumId]);
    sum += weight;
    count += 1;
    details.push({ field: fieldCode, enumId, weight, skipped: null });
  }

  if (count === 0) {
    return {
      ok: true,
      avg: null,
      activeCount: 0,
      ratingEnumId: null,
      ratingLabel: null,
      ratingField,
      details,
    };
  }

  const avg = Math.round((sum / count) * 100) / 100;
  const match = cfg.thresholds.find((t) => avg >= t.min && avg <= t.max);

  return {
    ok: true,
    avg,
    activeCount: count,
    sum,
    ratingEnumId: match ? match.enumId : null,
    ratingLabel: match ? match.label : null,
    ratingField,
    details,
  };
}

export function buildActivityDefinition(handlerUrl, authUserId) {
  const properties = {
    ScoringTable: {
      Name: {
        ru: "Таблица весов (JSON)",
        en: "Scoring table (JSON)",
      },
      Description: {
        ru: "JSON UF_CRM → { id: вес 1…4 }. Константа портала или шаблона БП (без «Нет данных»).",
        en: "JSON UF_CRM → { id: weight 1…4 }. Portal or template constant (omit «no data»).",
      },
      Type: "text",
      Required: "N",
      Multiple: "N",
    },
    RatingConfig: {
      Name: {
        ru: "Конфиг рейтинга (JSON)",
        en: "Rating config (JSON)",
      },
      Description: {
        ru: 'JSON: { "field": "UF_CRM_…", "thresholds": [{ "min", "max", "enumId", "label" }] }',
        en: 'JSON: { "field": "UF_CRM_…", "thresholds": [{ "min", "max", "enumId", "label" }] }',
      },
      Type: "text",
      Required: "N",
      Multiple: "N",
    },
    WriteToLead: {
      Name: {
        ru: "Записать рейтинг в лид",
        en: "Write rating to lead",
      },
      Type: "bool",
      Required: "N",
      Multiple: "N",
      Default: "Y",
    },
  };

  // Критерии всегда с лида по ключам ScoringTable (отдельных select'ов нет).
  const def = {
    CODE: "lead_rating_calculate",
    HANDLER: handlerUrl,
    USE_SUBSCRIPTION: "Y",
    NAME: {
      ru: "Расчёт рейтинга лида",
      en: "Lead rating calculate",
    },
    DESCRIPTION: {
      ru: "Среднее весов → рейтинг. Нужны ScoringTable и RatingConfig; критерии всегда с лида.",
      en: "Average weights → rating. Pass ScoringTable and RatingConfig; criteria always from the lead.",
    },
    DOCUMENT_TYPE: ["crm", "CCrmDocumentLead", "LEAD"],
    FILTER: {
      INCLUDE: [["crm", "CCrmDocumentLead", "LEAD"]],
    },
    PROPERTIES: properties,
    RETURN_PROPERTIES: {
      RatingEnumId: {
        Name: { ru: "ID рейтинга", en: "Rating enum ID" },
        Type: "string",
      },
      RatingLabel: {
        Name: { ru: "Рейтинг", en: "Rating label" },
        Type: "string",
      },
      Avg: {
        Name: { ru: "Средний балл", en: "Average score" },
        Type: "double",
      },
      ActiveCount: {
        Name: { ru: "Учтено критериев", en: "Criteria used" },
        Type: "int",
      },
    },
  };

  const uid = Number(authUserId);
  if (Number.isFinite(uid) && uid > 0) {
    def.AUTH_USER_ID = uid;
  }

  return def;
}
