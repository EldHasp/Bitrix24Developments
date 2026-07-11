/**
 * Дамп enum-полей блока «Категория клиента» / рейтинга лида.
 * 1) crm.lead.fields — ID поля, подписи, items
 * 2) при необходимости crm.lead.userfield.get — XML_ID, SORT
 *
 * Результат:
 * - snapshots/bitrix/lead-rating-enums_*.json
 * - internal/lead-rating/bitrix-enums.json
 * - internal/lead-rating/bitrix-enums.md
 *
 * Запуск:
 *   node tools/bitrix/dump-lead-rating-enums.mjs
 */
import fs from "node:fs";
import path from "node:path";
import {
  REPO_ROOT,
  callBitrix,
  ensureDir,
  fieldLabelRu,
  normalizeEnumItems,
  stamp,
} from "./lib/rest.mjs";

/** Подстроки RU-названий (ищем без учёта регистра). */
const LABEL_NEEDLES = [
  "категория/сумма долга",
  "сумма долга",
  "готовность ко встрече",
  "готовность внести аванс",
  "платежеспособность",
  "контактность",
  "статус клиента",
  "обрушающ",
  "рейтинг лида",
];

function matchesRatingField(labelRu) {
  const n = String(labelRu || "").toLowerCase();
  return LABEL_NEEDLES.some((needle) => n.includes(needle));
}

function toMarkdown(payload) {
  const lines = [];
  lines.push("# Enum-поля рейтинга лида (из Битрикс24)");
  lines.push("");
  lines.push(`Экспорт: \`${payload.exportedAt}\``);
  lines.push("");
  lines.push("Источник правды для БП — **ID из этой выгрузки**, не текст Google-таблицы.");
  lines.push("");

  for (const f of payload.fields) {
    lines.push(`## ${f.labelRu}`);
    lines.push("");
    lines.push(`- Код поля: \`${f.field}\``);
    lines.push(`- Multiple: ${f.multiple ? "да" : "нет"}`);
    if (f.userFieldId) lines.push(`- userfield id: \`${f.userFieldId}\``);
    lines.push("");
    lines.push("| ID значения | VALUE | XML_ID | SORT | DEF |");
    lines.push("|------------|-------|--------|------|-----|");
    for (const item of f.items) {
      lines.push(
        `| ${item.id} | ${item.value.replace(/\|/g, "\\|")} | ${item.xmlId || ""} | ${item.sort ?? ""} | ${item.def ? "Y" : ""} |`
      );
    }
    lines.push("");
  }

  if (payload.missingNeedles?.length) {
    lines.push("## Не найдено по названиям");
    lines.push("");
    for (const m of payload.missingNeedles) {
      lines.push(`- \`${m}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * crm.lead.userfield.get ждёт внутренний ID поля, а не хвост UF_CRM_<timestamp>.
 * Берём список userfield и ищем по FIELD_NAME.
 */
async function loadLeadUserfieldsByName() {
  const list = await callBitrix("crm.lead.userfield.list", {});
  const byName = new Map();
  for (const uf of list || []) {
    if (uf?.FIELD_NAME) byName.set(String(uf.FIELD_NAME), uf);
  }
  return byName;
}

function enrichFromUserfieldMap(fieldKey, itemsFromFields, userfieldsByName) {
  const uf = userfieldsByName.get(fieldKey);
  if (!uf) {
    return { items: itemsFromFields, userFieldId: null };
  }
  const list = normalizeEnumItems(uf.LIST || uf.list || []);
  return {
    items: list.length ? list : itemsFromFields,
    userFieldId: uf.ID != null ? String(uf.ID) : null,
  };
}

const allFields = await callBitrix("crm.lead.fields", {});
const userfieldsByName = await loadLeadUserfieldsByName();
const matched = [];

for (const [key, meta] of Object.entries(allFields || {})) {
  const labelRu = fieldLabelRu(key, meta);
  if (!matchesRatingField(labelRu)) continue;
  if (meta?.type !== "enumeration") {
    matched.push({
      field: key,
      labelRu,
      type: meta?.type || "unknown",
      multiple: Boolean(meta?.isMultiple),
      items: [],
      note: "Поле найдено по имени, но тип не enumeration — варианты списка не выгружены",
    });
    continue;
  }

  const baseItems = normalizeEnumItems(meta.items);
  const enriched = enrichFromUserfieldMap(key, baseItems, userfieldsByName);
  matched.push({
    field: key,
    labelRu,
    type: "enumeration",
    multiple: Boolean(meta.isMultiple),
    userFieldId: enriched.userFieldId,
    items: enriched.items,
  });
}

matched.sort((a, b) => a.labelRu.localeCompare(b.labelRu, "ru"));

const foundLabels = matched.map((f) => f.labelRu.toLowerCase());
const missingNeedles = LABEL_NEEDLES.filter(
  (needle) => !foundLabels.some((l) => l.includes(needle))
);

const payload = {
  exportedAt: new Date().toISOString(),
  method: "crm.lead.fields (+ crm.lead.userfield.get)",
  entity: "lead",
  purpose: "lead-rating / категория клиента",
  labelNeedles: LABEL_NEEDLES,
  missingNeedles,
  count: matched.length,
  fields: matched,
};

const snapDir = path.join(REPO_ROOT, "snapshots", "bitrix");
const taskDir = path.join(REPO_ROOT, "internal", "lead-rating");
ensureDir(snapDir);
ensureDir(taskDir);

const stamped = path.join(snapDir, `lead-rating-enums_${stamp()}.json`);
const latestSnap = path.join(snapDir, "lead-rating-enums_latest.json");
const taskJson = path.join(taskDir, "bitrix-enums.json");
const taskMd = path.join(taskDir, "bitrix-enums.md");

const jsonText = JSON.stringify(payload, null, 2);
fs.writeFileSync(stamped, jsonText, "utf8");
fs.writeFileSync(latestSnap, jsonText, "utf8");
fs.writeFileSync(taskJson, jsonText, "utf8");
fs.writeFileSync(taskMd, toMarkdown(payload), "utf8");

console.log(`OK: найдено полей ${matched.length}`);
if (missingNeedles.length) {
  console.log(`WARN: не найдены иглы: ${missingNeedles.join(", ")}`);
}
for (const f of matched) {
  console.log(` - ${f.labelRu} [${f.field}] items=${f.items?.length ?? 0}`);
}
console.log(`→ ${path.relative(REPO_ROOT, stamped)}`);
console.log(`→ ${path.relative(REPO_ROOT, taskJson)}`);
console.log(`→ ${path.relative(REPO_ROOT, taskMd)}`);
