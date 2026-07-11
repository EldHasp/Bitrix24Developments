/**
 * Дамп всех enumeration-полей лида из crm.lead.fields.
 * Пишет JSON в snapshots/bitrix/.
 *
 * Запуск из корня репо:
 *   node tools/bitrix/dump-lead-enums.mjs
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

const fields = await callBitrix("crm.lead.fields", {});
const enums = [];

for (const [key, meta] of Object.entries(fields || {})) {
  if (meta?.type !== "enumeration") continue;
  enums.push({
    field: key,
    labelRu: fieldLabelRu(key, meta),
    multiple: Boolean(meta.isMultiple),
    items: normalizeEnumItems(meta.items),
  });
}

enums.sort((a, b) => a.labelRu.localeCompare(b.labelRu, "ru"));

const payload = {
  exportedAt: new Date().toISOString(),
  method: "crm.lead.fields",
  entity: "lead",
  filter: "type === enumeration",
  count: enums.length,
  fields: enums,
};

const outDir = path.join(REPO_ROOT, "snapshots", "bitrix");
ensureDir(outDir);
const file = path.join(outDir, `lead-enums_${stamp()}.json`);
const latest = path.join(outDir, "lead-enums_latest.json");
fs.writeFileSync(file, JSON.stringify(payload, null, 2), "utf8");
fs.writeFileSync(latest, JSON.stringify(payload, null, 2), "utf8");

console.log(`OK: ${enums.length} enum-полей`);
console.log(`→ ${path.relative(REPO_ROOT, file)}`);
console.log(`→ ${path.relative(REPO_ROOT, latest)}`);
