import express from "express";
import {
  calculateFromFields,
  buildActivityDefinition,
  fieldMeta,
  scoringTable,
  resolveScoringTable,
  resolveRatingConfig,
} from "./lib/score.mjs";
import {
  SOURCE_GROUPS_ACTIVITY_CODE,
  buildSourceGroupsActivityDefinition,
  parseSourceGroupsActivityProps,
  syncLeadSourceGroupsByPeriod,
} from "./lib/source-groups-sync.mjs";
import {
  bitrixCall,
  bitrixCallWebhook,
  pickAuth,
  pickLeadId,
  propFlag,
  bx24BootstrapHtml,
  normalizeBitrixBody,
} from "./lib/bitrix.mjs";
import {
  writeOAuthStore,
  resolvePortalAuth,
  oauthDurabilityStatus,
} from "./lib/auth-store.mjs";

const PORT = Number(process.env.PORT || 3000);
const API_KEY = (process.env.API_KEY || "").trim();
const BITRIX_WEBHOOK_URL = (process.env.BITRIX_WEBHOOK_URL || "").trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "");
const ACTIVITY_CODE = "lead_rating_calculate";
const ACTIVITY_CODES = [ACTIVITY_CODE, SOURCE_GROUPS_ACTIVITY_CODE];

/** Последние вызовы /bitrix/activity — для отладки зависаний БП */
const activityDebugLog = [];
function pushActivityDebug(entry) {
  activityDebugLog.unshift({ ts: new Date().toISOString(), ...entry });
  if (activityDebugLog.length > 20) activityDebugLog.length = 20;
}

const app = express();
app.use(express.json({ limit: "512kb" }));
app.use(express.urlencoded({ extended: true, limit: "512kb" }));

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, X-Api-Key"
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

function checkAuth(req) {
  if (!API_KEY) return true;
  const header =
    req.headers["x-api-key"] ||
    (String(req.headers.authorization || "").startsWith("Bearer ")
      ? String(req.headers.authorization).slice(7)
      : "");
  return header === API_KEY;
}

function publicBase(req) {
  if (PUBLIC_BASE_URL) return PUBLIC_BASE_URL;
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

async function fetchLeadFieldsViaWebhook(leadId) {
  if (!BITRIX_WEBHOOK_URL) {
    throw new Error("BITRIX_WEBHOOK_URL не задан — нельзя загрузить лид по ID");
  }
  const base = BITRIX_WEBHOOK_URL.endsWith("/")
    ? BITRIX_WEBHOOK_URL
    : `${BITRIX_WEBHOOK_URL}/`;
  const select = ["ID", ...Object.keys(scoringTable)];
  const res = await fetch(`${base}crm.lead.get.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: leadId, select }),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`${data.error}: ${data.error_description || ""}`);
  }
  return data.result || {};
}

async function bxRest(method, params, { domain, accessToken }) {
  if (accessToken && domain) {
    return bitrixCall(domain, accessToken, method, params);
  }
  if (BITRIX_WEBHOOK_URL) {
    return bitrixCallWebhook(BITRIX_WEBHOOK_URL, method, params);
  }
  throw new Error(
    "Нет auth от активити и не задан BITRIX_WEBHOOK_URL (fallback)"
  );
}

function fieldsFromProperties(properties = {}) {
  const fields = {};
  for (const f of fieldMeta.fields) {
    const raw = properties[f.prop] ?? properties[f.code];
    const id = String(raw ?? "").trim();
    if (id) fields[f.code] = id;
  }
  return fields;
}

function mergeLeadFields(fromProps, fromLead, table = scoringTable) {
  const out = { ...fromProps };
  for (const code of Object.keys(table)) {
    if (!out[code] && fromLead?.[code] != null && fromLead[code] !== "") {
      out[code] = fromLead[code];
    }
  }
  return out;
}

function pickActivityCode(body = {}) {
  const raw =
    body.code ||
    body.CODE ||
    body.activity ||
    body.ACTIVITY ||
    body.properties?.ActivityCode ||
    "";
  return String(raw || "").trim();
}

async function registerActivities(domain, accessToken, baseUrl, authUserId) {
  const handler = `${baseUrl}/bitrix/activity`;
  const defs = [
    buildActivityDefinition(handler, authUserId),
    buildSourceGroupsActivityDefinition(handler, authUserId),
  ];

  for (const def of defs) {
    try {
      await bitrixCall(domain, accessToken, "bizproc.activity.delete", {
        CODE: def.CODE,
      });
    } catch {
      /* ещё не было */
    }
    await bitrixCall(domain, accessToken, "bizproc.activity.add", def);
  }
  return { handler, defs, codes: defs.map((d) => d.CODE) };
}

/** @deprecated use registerActivities */
async function registerActivity(domain, accessToken, baseUrl, authUserId) {
  const { defs } = await registerActivities(domain, accessToken, baseUrl, authUserId);
  return defs[0];
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "lead-rating-api",
    activities: ACTIVITY_CODES,
  });
});

app.get("/", (req, res) => {
  const base = publicBase(req);
  res.type("html").send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>lead-rating-api</title>
<style>
  body{font:16px/1.45 system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;color:#111}
  code,pre{background:#f4f4f5;padding:.15rem .35rem;border-radius:4px}
  pre{padding:1rem;overflow:auto}
  h1{font-size:1.4rem}
</style></head><body>
<h1>lead-rating-api</h1>
<p>Локальное приложение Битрикс24: рейтинг лида + синхронизация групп источников.</p>
<ul>
  <li><code>POST /v1/lead-rating/calculate</code> — HTTP API рейтинга</li>
  <li><code>POST /v1/source-groups/sync</code> — HTTP API массовой синхронизации групп</li>
  <li><code>POST /bitrix/install</code> — установка / регистрация активити</li>
  <li><code>POST /bitrix/activity</code> — handler активити БП</li>
</ul>
<p>Активити: <code>${ACTIVITY_CODE}</code>, <code>${SOURCE_GROUPS_ACTIVITY_CODE}</code></p>
<p>Установка:</p>
<pre>${base}/bitrix/install</pre>
</body></html>`);
});

app.post("/v1/lead-rating/calculate", async (req, res) => {
  try {
    if (!checkAuth(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    const body = req.body || {};
    let fields = body.fields || {};

    if (body.leadId && (!fields || Object.keys(fields).length === 0)) {
      const lead = await fetchLeadFieldsViaWebhook(body.leadId);
      fields = {};
      for (const code of Object.keys(scoringTable)) {
        fields[code] = lead[code];
      }
    }

    res.json(calculateFromFields(fields));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.post("/v1/source-groups/sync", async (req, res) => {
  try {
    if (!checkAuth(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    const body = req.body || {};
    const props = parseSourceGroupsActivityProps(body);
    if (body.dryRun != null) props.dryRun = !!body.dryRun;
    if (body.maxUpdateBatches != null) props.maxUpdateBatches = Number(body.maxUpdateBatches);
    if (!BITRIX_WEBHOOK_URL && !(body.domain && body.access_token)) {
      return res.status(400).json({
        ok: false,
        error: "Нужен BITRIX_WEBHOOK_URL или domain+access_token в теле",
      });
    }
    const domain = String(body.domain || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    const accessToken = String(body.access_token || "").trim();
    const bx = (method, params) => bxRest(method, params, { domain, accessToken });
    const logs = [];
    const result = await syncLeadSourceGroupsByPeriod(bx, {
      ...props,
      log: (m) => {
        logs.push(m);
        console.log(m);
      },
    });
    res.json({ ...result, logs });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

function isBitrixInstallEvent(body = {}) {
  const event = String(body.event || body.EVENT || "").toUpperCase();
  if (event === "ONAPPINSTALL") return true;
  if (body.install === "Y" || body.INSTALL === "Y") return true;
  // Явный флаг с нашей кнопки/query
  if (body.force_install === "1" || body.force_install === 1) return true;
  return false;
}

async function tryRegisterFromRequest(req, res, { finishInstall }) {
  try {
    const body = { ...req.query, ...req.body };
    const { accessToken, domain } = pickAuth(body);
    const base = publicBase(req);
    const activityHandler = `${base}/bitrix/activity`;

    // Обычное открытие — справка. callInstallFinish: если Битрикс открыл /install без ONAPPINSTALL
    if (!finishInstall) {
      return res.status(200).type("html").send(
        bx24BootstrapHtml({
          finishInstall: false,
          callInstallFinish: Boolean(req._bitrixSoftInstallFinish),
          title: "БП-активити CRM (рейтинг + группы источников)",
          activityCode: ACTIVITY_CODES.join(", "),
          activityHandler,
        })
      );
    }

    // Установка: есть POST-auth от Битрикс → регистрируем сразу
    if (accessToken && domain) {
      const { userId } = pickAuth(body);
      const { defs, codes, handler } = await registerActivities(
        domain,
        accessToken,
        base,
        userId
      );
      const names = defs.map((d) => d.NAME.ru).join(", ");
      return res.type("html").send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Установка</title>
<script src="//api.bitrix24.com/api/v1/"></script>
</head>
<body style="font:16px system-ui;padding:2rem;max-width:720px;margin:0 auto">
  <h1>Готово</h1>
  <p>Зарегистрированы активити: <b>${names}</b></p>
  <p>Коды: <code>${codes.join("</code>, <code>")}</code></p>
  <p>В дизайнере БП лида: «Действия приложений».</p>
  <p>Handler: <code>${handler}</code></p>
  <p style="color:#667085">Пункт меню открывает справку. Этот экран — только при установке/переустановке.</p>
  <script>BX24.init(function(){ BX24.installFinish(); });</script>
</body></html>`);
    }

    // Установка без POST-auth → BX24 + авторегистрация
    return res.status(200).type("html").send(
      bx24BootstrapHtml({
        finishInstall: true,
        title: "БП-активити CRM (рейтинг + группы источников)",
        activityCode: ACTIVITY_CODES.join(", "),
        activityHandler,
      })
    );
  } catch (e) {
    res.status(500).type("html").send(`<p>Ошибка установки: ${e.message || e}</p>`);
  }
}

/**
 * Оба URL можно указать в карточке приложения.
 * «Готово» только при реальном событии установки; иначе — справка
 * (чтобы пункт меню не показывал экран переустановки).
 */
app.all("/bitrix/install", (req, res) => {
  // «Переустановить» должно снова зарегистрировать активити
  const body = normalizeBitrixBody({ ...req.query, ...req.body });
  const hasAnyAuth = Boolean(
    pickAuth(body).accessToken || body.AUTH_ID || body.DOMAIN
  );
  const finishInstall = isBitrixInstallEvent(body) || hasAnyAuth;
  if (!finishInstall) req._bitrixSoftInstallFinish = true;
  tryRegisterFromRequest(req, res, { finishInstall });
});

app.all("/bitrix/handler", (req, res) => {
  tryRegisterFromRequest(req, res, { finishInstall: false });
});

/** Регистрация из BX24.js (когда POST-auth нет) */
app.post("/bitrix/save-auth", (req, res) => {
  try {
    const body = req.body || {};
    const access_token = String(body.access_token || "").trim();
    const domain = String(body.domain || "")
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
    const refresh_token = String(body.refresh_token || "").trim();
    if (!access_token || !domain) {
      return res.status(400).json({ ok: false, error: "Нужны domain и access_token" });
    }
    writeOAuthStore({
      domain,
      access_token,
      refresh_token: refresh_token || undefined,
      member_id: String(body.member_id || "").trim() || undefined,
      user_id: String(body.user_id || "").trim() || undefined,
    });
    const durable = oauthDurabilityStatus();
    res.json({
      ok: true,
      saved: true,
      // чтобы один раз положить в Layero (переживает деплои); не логировать в чаты
      refresh_token: refresh_token || null,
      domain,
      durable,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get("/bitrix/debug/oauth-status", (_req, res) => {
  res.json({ ok: true, ...oauthDurabilityStatus() });
});

app.post("/bitrix/register-from-bx24", async (req, res) => {
  try {
    const body = normalizeBitrixBody(req.body || {});
    const { accessToken, domain, userId } = pickAuth(body);
    if (!accessToken || !domain) {
      return res.status(400).json({ ok: false, error: "Нет domain/access_token" });
    }
    const def = await registerActivities(
      domain,
      accessToken,
      publicBase(req),
      userId || body.user_id
    );
    res.json({
      ok: true,
      codes: def.codes,
      code: def.codes.join(","),
      handler: def.handler,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get("/bitrix/debug/last-activity", (_req, res) => {
  res.json({ ok: true, count: activityDebugLog.length, items: activityDebugLog });
});

/** Выполнение активити в БП */
app.all("/bitrix/activity", async (req, res) => {
  // Открытие в браузере / iframe без тела БП — не считать, а подсказать правильные URL
  if (req.method === "GET" || req.method === "HEAD") {
    return res.status(200).type("html").send(`<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><title>Activity handler</title></head>
<body style="font:16px system-ui;padding:2rem;max-width:720px;margin:0 auto">
  <h1>Это handler активити БП</h1>
  <p>Сюда Битрикс шлёт <b>POST</b> при выполнении шага бизнес-процесса. В карточке локального приложения этот URL <b>указывать нельзя</b>.</p>
  <ul>
    <li>Обработчик приложения: <code>/bitrix/handler</code></li>
    <li>Установка: <code>/bitrix/install</code></li>
    <li>Активити (только в bizproc.activity.add): <code>/bitrix/activity</code></li>
    <li>Коды: <code>${ACTIVITY_CODE}</code>, <code>${SOURCE_GROUPS_ACTIVITY_CODE}</code></li>
  </ul>
</body></html>`);
  }

  const body = normalizeBitrixBody({ ...req.query, ...req.body });
  const properties = body.properties || body.PROPERTIES || {};
  let activityCode = pickActivityCode(body);
  // Fallback: Битрикс иногда не шлёт code явно — эвристика по свойствам
  if (!activityCode) {
    if (properties.DateFrom || properties.dateFrom) {
      activityCode = SOURCE_GROUPS_ACTIVITY_CODE;
    } else {
      activityCode = ACTIVITY_CODE;
    }
  }
  if (activityCode === SOURCE_GROUPS_ACTIVITY_CODE) {
    return handleSourceGroupsActivity(req, res, body);
  }
  return handleLeadRatingActivity(req, res, body);
});

async function handleSourceGroupsActivity(req, res, body) {
  const requestAuth = pickAuth(body);
  const eventToken = body.event_token || body.EVENT_TOKEN;
  const properties = body.properties || body.PROPERTIES || {};
  const resolved = await resolvePortalAuth(requestAuth);
  let accessToken = resolved.accessToken;
  let domain = resolved.domain;
  const authSource = resolved.source;
  const canCallRest = Boolean((accessToken && domain) || BITRIX_WEBHOOK_URL);

  const debugBase = {
    method: req.method,
    activityCode: SOURCE_GROUPS_ACTIVITY_CODE,
    domain: domain || null,
    hasAuth: Boolean(requestAuth.accessToken && requestAuth.domain),
    authSource,
    hasWebhookFallback: Boolean(BITRIX_WEBHOOK_URL),
    canCallRest,
    hasEventToken: Boolean(eventToken),
    propKeys: Object.keys(properties || {}),
  };

  let returnValues = {
    Updated: "0",
    AlreadyOk: "0",
    ToUpdate: "0",
    Remaining: "0",
    SkippedNoSource: "0",
    SkippedNoDirectory: "0",
    UpdateErrors: "0",
    LeadsTotal: "0",
    StatusText: "",
    Ok: "N",
  };
  let logMessage = "";

  try {
    if (!canCallRest) {
      throw new Error(
        resolved.error ||
          "Нет auth: откройте приложение из меню или задайте BITRIX_WEBHOOK_URL"
      );
    }
    const props = parseSourceGroupsActivityProps(properties);
    const bx = (method, params) => bxRest(method, params, { domain, accessToken });
    const logs = [];
    const result = await syncLeadSourceGroupsByPeriod(bx, {
      ...props,
      log: (m) => {
        logs.push(m);
        console.log("[source-groups]", m);
      },
    });
    returnValues = result.returnValues;
    logMessage = result.statusText;
    if (logs.length) logMessage += "; " + logs.slice(-3).join(" | ");

    if (eventToken) {
      await bxRest(
        "bizproc.event.send",
        {
          event_token: eventToken,
          return_values: returnValues,
          log_message: logMessage,
        },
        { domain, accessToken }
      );
      logMessage += `; event.send OK (${authSource || "oauth"})`;
    } else {
      logMessage += "; НЕ отправлен event.send (нет event_token)";
    }

    pushActivityDebug({ ...debugBase, ok: true, logMessage, returnValues });
    res.status(200).json({ ok: true, ...result, logMessage });
  } catch (e) {
    const errText = e.message || String(e);
    returnValues.StatusText = errText;
    returnValues.Ok = "N";
    pushActivityDebug({ ...debugBase, ok: false, error: errText });
    try {
      if (eventToken && canCallRest) {
        await bxRest(
          "bizproc.event.send",
          {
            event_token: eventToken,
            return_values: returnValues,
            log_message: `Ошибка синхронизации групп источников: ${errText}`,
          },
          { domain, accessToken }
        );
      }
    } catch (e2) {
      pushActivityDebug({
        ...debugBase,
        ok: false,
        error: errText,
        eventSendError: e2.message || String(e2),
      });
    }
    res.status(200).json({ ok: false, error: errText });
  }
}

async function handleLeadRatingActivity(req, res, body) {
  // Сначала event.send, потом HTTP-ответ — иначе Layero гасит процесс и БП висит.
  const requestAuth = pickAuth(body);
  const eventToken = body.event_token || body.EVENT_TOKEN;
  const properties = body.properties || body.PROPERTIES || {};
  const leadId = pickLeadId(body);

  // Как у приложений Маркета: токен из запроса или сохранённый OAuth (после открытия приложения)
  const resolved = await resolvePortalAuth(requestAuth);
  let accessToken = resolved.accessToken;
  let domain = resolved.domain;
  const authSource = resolved.source;
  const canCallRest = Boolean(
    (accessToken && domain) || BITRIX_WEBHOOK_URL
  );

  const debugBase = {
    method: req.method,
    activityCode: ACTIVITY_CODE,
    leadId: leadId || null,
    domain: domain || null,
    hasAuth: Boolean(requestAuth.accessToken && requestAuth.domain),
    authSource,
    hasWebhookFallback: Boolean(BITRIX_WEBHOOK_URL),
    canCallRest,
    hasEventToken: Boolean(eventToken),
    authKeys: requestAuth.authKeys || [],
    propKeys: Object.keys(properties || {}),
    topKeys: Object.keys(body || {}).slice(0, 40),
    resolveError: resolved.error || null,
    durable: oauthDurabilityStatus(),
  };

  let result = {
    ok: false,
    avg: null,
    activeCount: 0,
    ratingEnumId: null,
    ratingLabel: null,
  };
  let logMessage = "";

  try {
    let fields = fieldsFromProperties(properties);
    const writeToLead = propFlag(properties.WriteToLead, true);
    let currentRatingId = "";

    const { table: activeTable, source: scoringSource } = resolveScoringTable(
      properties.ScoringTable ?? properties.scoringTable
    );
    const { config: ratingConfig, source: ratingSource } = resolveRatingConfig(
      properties.RatingConfig ?? properties.ratingConfig
    );
    const ratingField = ratingConfig.field;
    debugBase.scoringSource = scoringSource;
    debugBase.scoringFieldCount = Object.keys(activeTable).length;
    debugBase.ratingSource = ratingSource;
    debugBase.ratingField = ratingField;

    // Критерии всегда с лида (ключи ScoringTable); рейтинг — для сравнения перед записью
    if (leadId && canCallRest) {
      const select = ["ID", ratingField, ...Object.keys(activeTable)];
      const lead = await bxRest(
        "crm.lead.get",
        { id: leadId, select },
        { domain, accessToken }
      );
      fields = mergeLeadFields(fields, lead, activeTable);
      currentRatingId = String(lead?.[ratingField] ?? "").trim();
    }

    result = calculateFromFields(fields, activeTable, ratingConfig);
    logMessage = result.ratingLabel
      ? `Рейтинг: ${result.ratingLabel} (avg=${result.avg}, n=${result.activeCount}; scoring=${scoringSource}; rating=${ratingSource})`
      : `Рейтинг не рассчитан (нет рабочих критериев; leadId=${leadId || "—"}; scoring=${scoringSource}; rating=${ratingSource})`;
    if (scoringSource === "file") {
      logMessage +=
        "; WARN: ScoringTable пуста — взят файл на сервере. В БП укажите константу в «Таблица весов (JSON)».";
    }
    if (ratingSource === "file") {
      logMessage +=
        "; WARN: RatingConfig пуст — взят файл на сервере. В БП укажите константу в «Конфиг рейтинга (JSON)».";
    }

    // Пишем рейтинг только если значение реально изменилось —
    // иначе crm.lead.update снова дергает БП «при изменении» → лишний цикл.
    if (writeToLead && result.ratingEnumId && leadId && canCallRest) {
      const nextRatingId = String(result.ratingEnumId).trim();
      if (nextRatingId === currentRatingId) {
        logMessage += "; без записи (рейтинг не изменился)";
      } else {
        await bxRest(
          "crm.lead.update",
          {
            id: leadId,
            fields: { [ratingField]: result.ratingEnumId },
          },
          { domain, accessToken }
        );
        logMessage += currentRatingId
          ? `; записано в ${ratingField} (${currentRatingId} → ${nextRatingId})`
          : `; записано в ${ratingField}`;
      }
    }

    if (eventToken && canCallRest) {
      await bxRest(
        "bizproc.event.send",
        {
          event_token: eventToken,
          return_values: {
            RatingEnumId: result.ratingEnumId ?? "",
            RatingLabel: result.ratingLabel ?? "",
            Avg: result.avg ?? "",
            ActiveCount: result.activeCount ?? 0,
          },
          log_message: logMessage,
        },
        { domain, accessToken }
      );
      logMessage += accessToken
        ? `; event.send OK (${authSource || "oauth"})`
        : "; event.send OK (webhook)";
    } else {
      logMessage +=
        "; НЕ отправлен event.send. " +
        (resolved.error || "Откройте приложение из меню Битрикс, чтобы сохранить OAuth.");
    }

    pushActivityDebug({
      ...debugBase,
      ok: true,
      logMessage,
      avg: result.avg,
      ratingLabel: result.ratingLabel,
      fieldKeys: Object.keys(fields),
    });

    res.status(200).json({
      ok: true,
      leadId,
      ...result,
      logMessage,
    });
  } catch (e) {
    const errText = e.message || String(e);
    pushActivityDebug({ ...debugBase, ok: false, error: errText });
    try {
      if (eventToken && canCallRest) {
        await bxRest(
          "bizproc.event.send",
          {
            event_token: eventToken,
            return_values: {
              RatingEnumId: "",
              RatingLabel: "",
              Avg: "",
              ActiveCount: 0,
            },
            log_message: `Ошибка расчёта рейтинга: ${errText}`,
          },
          { domain, accessToken }
        );
      }
    } catch (e2) {
      pushActivityDebug({
        ...debugBase,
        ok: false,
        error: errText,
        eventSendError: e2.message || String(e2),
      });
    }
    res.status(200).json({ ok: false, error: errText });
  }
}

/** Ручная перерегистрация активити (с API_KEY) */
app.post("/bitrix/register-activity", async (req, res) => {
  try {
    if (!checkAuth(req)) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    const { domain, access_token: accessToken } = req.body || {};
    if (!domain || !accessToken) {
      return res.status(400).json({
        ok: false,
        error: "Нужны domain и access_token в JSON-теле",
      });
    }
    const def = await registerActivities(domain, accessToken, publicBase(req));
    res.json({ ok: true, codes: def.codes, handler: def.handler });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.use((_req, res) => {
  res.status(404).json({ ok: false, error: "Not found" });
});

app.listen(PORT, () => {
  console.log(`lead-rating-api listening on :${PORT}`);
  console.log(`activities: ${ACTIVITY_CODES.join(", ")}`);
  if (!API_KEY) {
    console.warn("WARNING: API_KEY не задан — HTTP API открыт без авторизации");
  }
});
