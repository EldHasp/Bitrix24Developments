import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "../../..");

/**
 * Загружает простые KEY=VALUE из .env в корне репозитория (без зависимостей).
 * Не перезаписывает уже заданные process.env.
 */
export function loadEnv(envPath = path.join(REPO_ROOT, ".env")) {
  if (!fs.existsSync(envPath)) {
    return;
  }
  const text = fs.readFileSync(envPath, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function getWebhookUrl() {
  loadEnv();
  const url = (process.env.BITRIX_WEBHOOK_URL || "").trim();
  if (!url) {
    throw new Error(
      "Не задан BITRIX_WEBHOOK_URL. Скопируйте .env.example → .env и укажите вебхук."
    );
  }
  return url.endsWith("/") ? url : `${url}/`;
}

/**
 * Вызов REST Bitrix24 (POST JSON).
 * @param {string} method например crm.lead.fields
 * @param {Record<string, unknown>} [params]
 */
export async function callBitrix(method, params = {}) {
  const base = getWebhookUrl();
  const endpoint = `${base}${method}.json`;
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${method}: ${JSON.stringify(data)}`);
  }
  if (data.error) {
    throw new Error(
      `${method}: ${data.error}${data.error_description ? " — " + data.error_description : ""}`
    );
  }
  return data.result;
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
  );
}

/**
 * Русское имя пользовательского поля лида (как в BitrixCore_Library GetFieldsInfo).
 */
export function fieldLabelRu(fieldKey, meta) {
  if (String(fieldKey).startsWith("UF_CRM_")) {
    return meta.listLabel || meta.formLabel || meta.filterLabel || fieldKey;
  }
  return meta.title || meta.formLabel || fieldKey;
}

/**
 * Нормализация вариантов enumeration из crm.lead.fields / userfield.
 */
export function normalizeEnumItems(items) {
  if (!Array.isArray(items)) return [];
  return items.map((item) => ({
    id: item.ID != null ? String(item.ID) : "",
    value: item.VALUE != null ? String(item.VALUE) : "",
    xmlId: item.XML_ID != null ? String(item.XML_ID) : "",
    sort: item.SORT != null ? Number(item.SORT) : null,
    def: item.DEF === "Y" || item.DEF === true,
  }));
}
