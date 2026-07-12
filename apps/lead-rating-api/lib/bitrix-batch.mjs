/**
 * Сборка cmd для Bitrix batch (query-string с encodeURIComponent).
 * @param {string} method
 * @param {Record<string, unknown>} params
 */
export function buildBatchCmd(method, params = {}) {
  const parts = [];
  function buildString(obj, prefix) {
    for (const key of Object.keys(obj || {})) {
      const k = prefix ? `${prefix}[${key}]` : key;
      const v = obj[key];
      if (v != null && typeof v === "object" && !Array.isArray(v)) {
        buildString(v, k);
      } else if (Array.isArray(v)) {
        v.forEach((item, idx) => {
          if (item != null && typeof item === "object") {
            buildString(item, `${k}[${idx}]`);
          } else {
            parts.push(
              `${encodeURIComponent(`${k}[${idx}]`)}=${encodeURIComponent(
                item == null ? "" : String(item)
              )}`
            );
          }
        });
      } else {
        parts.push(
          `${encodeURIComponent(k)}=${encodeURIComponent(v == null ? "" : String(v))}`
        );
      }
    }
  }
  buildString(params);
  return `${method}?${parts.join("&")}`;
}

/**
 * @param {unknown} batchResult — уже data.result от REST (без обёртки error)
 * @returns {{ resultMap: Record<string, unknown>, errorMap: Record<string, unknown> }}
 */
export function unwrapBatchMaps(batchResult) {
  const root = batchResult && typeof batchResult === "object" ? batchResult : {};
  const resultMap =
    root.result && typeof root.result === "object" && !Array.isArray(root.result)
      ? root.result
      : root;
  const errorMap =
    root.result_error && typeof root.result_error === "object"
      ? root.result_error
      : {};
  return { resultMap, errorMap };
}

export function sleep(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (!n) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, n));
}
