import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORE_PATH = path.join(__dirname, "..", "data", "bitrix-oauth.json");

const CLIENT_ID = (process.env.BITRIX_CLIENT_ID || "").trim();
const CLIENT_SECRET = (process.env.BITRIX_CLIENT_SECRET || "").trim();
const ENV_REFRESH = (process.env.BITRIX_REFRESH_TOKEN || "").trim();
const ENV_DOMAIN = (process.env.BITRIX_DOMAIN || "")
  .trim()
  .replace(/^https?:\/\//, "")
  .replace(/\/$/, "");

export function oauthDurabilityStatus() {
  const stored = readOAuthStore();
  return {
    hasFileStore: Boolean(stored?.access_token || stored?.refresh_token),
    hasEnvRefresh: Boolean(ENV_REFRESH),
    hasClientCreds: Boolean(CLIENT_ID && CLIENT_SECRET),
    hasWebhook: Boolean((process.env.BITRIX_WEBHOOK_URL || "").trim()),
    domain: ENV_DOMAIN || stored?.domain || null,
  };
}

export function readOAuthStore() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function writeOAuthStore(data) {
  const dir = path.dirname(STORE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  const prev = readOAuthStore() || {};
  const next = {
    ...prev,
    ...data,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STORE_PATH, JSON.stringify(next, null, 2), "utf8");
  return next;
}

/**
 * Обмен refresh_token → access_token (как у обычных OAuth-приложений Маркета).
 * client_id / client_secret — из карточки ЛОКАЛЬНОГО приложения, не вебхук.
 */
export async function refreshAccessToken(refreshToken) {
  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error(
      "Задайте BITRIX_CLIENT_ID и BITRIX_CLIENT_SECRET в Layero (из карточки локального приложения)"
    );
  }
  if (!refreshToken) throw new Error("Нет refresh_token");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: refreshToken,
  });
  const res = await fetch("https://oauth.bitrix.info/oauth/token/", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`${data.error}: ${data.error_description || ""}`);
  }
  writeOAuthStore({
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_in: data.expires_in,
    domain:
      data.domain ||
      readOAuthStore()?.domain ||
      ENV_DOMAIN ||
      undefined,
  });
  return data;
}

/**
 * Достать рабочий access_token для REST:
 * 1) из текущего запроса активити
 * 2) из файла (живёт до деплоя/рестарта Layero)
 * 3) refresh из файла
 * 4) refresh из env BITRIX_REFRESH_TOKEN (переживает деплои)
 */
export async function resolvePortalAuth(requestAuth) {
  let accessToken = (requestAuth?.accessToken || "").trim();
  let domain = (requestAuth?.domain || "").trim();
  let source = accessToken ? "request" : null;

  const stored = readOAuthStore();
  if (!domain && stored?.domain) domain = stored.domain;
  if (!domain && ENV_DOMAIN) domain = ENV_DOMAIN;

  if (!accessToken && stored?.access_token) {
    accessToken = stored.access_token;
    source = "store";
  }

  if (!accessToken && stored?.refresh_token) {
    try {
      const refreshed = await refreshAccessToken(stored.refresh_token);
      accessToken = refreshed.access_token;
      if (refreshed.domain) {
        domain = String(refreshed.domain).replace(/^https?:\/\//, "");
      }
      source = "refresh-file";
    } catch (e) {
      // пробуем env ниже
      if (!ENV_REFRESH) {
        return {
          accessToken: "",
          domain: domain || "",
          source: null,
          error: `Refresh из файла не удался: ${e.message || e}`,
        };
      }
    }
  }

  if (!accessToken && ENV_REFRESH) {
    try {
      const refreshed = await refreshAccessToken(ENV_REFRESH);
      accessToken = refreshed.access_token;
      if (refreshed.domain) {
        domain = String(refreshed.domain).replace(/^https?:\/\//, "");
      }
      if (!domain && ENV_DOMAIN) domain = ENV_DOMAIN;
      source = "refresh-env";
    } catch (e) {
      return {
        accessToken: "",
        domain: domain || "",
        source: null,
        error: `Refresh из BITRIX_REFRESH_TOKEN не удался: ${e.message || e}. Откройте приложение из меню или обновите переменную в Layero.`,
      };
    }
  }

  if (!accessToken || !domain) {
    const hasWebhook = Boolean((process.env.BITRIX_WEBHOOK_URL || "").trim());
    return {
      accessToken: "",
      domain: domain || "",
      source: null,
      error: hasWebhook
        ? null // REST пойдёт через webhook в bxRest
        : "Нет OAuth-токена. Один раз: откройте приложение из меню ИЛИ задайте в Layero BITRIX_REFRESH_TOKEN / BITRIX_WEBHOOK_URL (см. README).",
    };
  }

  return { accessToken, domain, source, error: null };
}
