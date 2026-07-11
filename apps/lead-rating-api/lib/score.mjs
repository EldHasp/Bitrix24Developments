import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");

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

/**
 * @param {Record<string, unknown>} fields карта UF_CRM_* → ID значения списка
 */
export function calculateFromFields(fields) {
  const details = [];
  let sum = 0;
  let count = 0;

  for (const [fieldCode, weightMap] of Object.entries(scoringTable)) {
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
      ratingField: thresholdsMeta.ratingField,
      details,
    };
  }

  const avg = Math.round((sum / count) * 100) / 100;
  const match = thresholdsMeta.thresholds.find((t) => avg >= t.min && avg <= t.max);

  return {
    ok: true,
    avg,
    activeCount: count,
    sum,
    ratingEnumId: match ? match.enumId : null,
    ratingLabel: match ? match.label : null,
    ratingField: thresholdsMeta.ratingField,
    details,
  };
}

export function buildActivityDefinition(handlerUrl, authUserId) {
  const properties = {
    AutoFromLead: {
      Name: {
        ru: "Брать пустые поля из лида",
        en: "Fill empty fields from lead",
      },
      Type: "bool",
      Required: "N",
      Multiple: "N",
      Default: "Y",
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

  for (const f of fieldMeta.fields) {
    properties[f.prop] = {
      Name: { ru: f.name, en: f.name },
      Type: "select",
      Required: "N",
      Multiple: "N",
      Options: f.options,
    };
  }

  const def = {
    CODE: "lead_rating_calculate",
    HANDLER: handlerUrl,
    USE_SUBSCRIPTION: "Y",
    NAME: {
      ru: "Расчёт рейтинга лида",
      en: "Lead rating calculate",
    },
    DESCRIPTION: {
      ru: "Считает среднее весов по 7 критериям и возвращает А+/А/В/С",
      en: "Averages weights across 7 criteria and returns A+/A/B/C",
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
