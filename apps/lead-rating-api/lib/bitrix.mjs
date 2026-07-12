/**
 * Вызов REST Битрикс24 по OAuth-токену из активити / установки приложения.
 * @param {string} domain например braincon.bitrix24.ru
 * @param {string} accessToken
 * @param {string} method
 * @param {Record<string, unknown>} params
 */
export async function bitrixCall(domain, accessToken, method, params = {}) {
  const host = String(domain || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  if (!host || !accessToken) {
    throw new Error("Нет domain/access_token для вызова Битрикс");
  }
  const url = `https://${host}/rest/${method}.json?auth=${encodeURIComponent(accessToken)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`${data.error}: ${data.error_description || ""}`);
  }
  return data.result;
}

/** Вызов через входящий вебхук (fallback, если в активити нет access_token) */
export async function bitrixCallWebhook(webhookUrl, method, params = {}) {
  if (!webhookUrl) throw new Error("BITRIX_WEBHOOK_URL не задан");
  const base = webhookUrl.endsWith("/") ? webhookUrl : `${webhookUrl}/`;
  const url = `${base}${method}.json`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(params),
  });
  const data = await res.json();
  if (data.error) {
    throw new Error(`${data.error}: ${data.error_description || ""}`);
  }
  return data.result;
}

function parseMaybeJson(value) {
  if (value == null || typeof value === "object") return value;
  if (typeof value !== "string") return value;
  const s = value.trim();
  if (!s) return value;
  if (
    (s.startsWith("{") && s.endsWith("}")) ||
    (s.startsWith("[") && s.endsWith("]"))
  ) {
    try {
      return JSON.parse(s);
    } catch {
      return value;
    }
  }
  return value;
}

/** Нормализация тела запроса Битрикс (auth/properties часто приходят JSON-строкой) */
export function normalizeBitrixBody(raw = {}) {
  const body = { ...raw };
  for (const key of [
    "auth",
    "properties",
    "PROPERTIES",
    "document_id",
    "DOCUMENT_ID",
    "document_type",
    "DOCUMENT_TYPE",
  ]) {
    if (key in body) body[key] = parseMaybeJson(body[key]);
  }
  // Иногда весь payload лежит в data
  if (typeof body.data === "string") body.data = parseMaybeJson(body.data);
  if (body.data && typeof body.data === "object") {
    for (const [k, v] of Object.entries(body.data)) {
      if (body[k] == null) body[k] = parseMaybeJson(v);
    }
  }
  return body;
}

/**
 * Битрикс шлёт auth по-разному:
 * - auth[access_token] / auth[domain]
 * - AUTH_ID + DOMAIN (iframe / установка)
 * - auth как JSON-строка
 */
export function pickAuth(body = {}) {
  let auth = body.auth ?? {};
  auth = parseMaybeJson(auth);
  if (typeof auth !== "object" || auth == null) auth = {};

  const accessToken =
    auth.access_token ||
    auth.accessToken ||
    body.access_token ||
    body.AUTH_ID ||
    body.auth_id ||
    body.AUTH_ID_TO_UPLOAD ||
    auth.AUTH_ID ||
    "";
  let domain =
    auth.domain || body.domain || body.DOMAIN || body.domain_name || "";
  if (domain) {
    domain = String(domain)
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");
  }
  const userId = auth.user_id || body.user_id || body.USER_ID || "";
  return {
    accessToken: String(accessToken || "").trim(),
    domain: String(domain || "").trim(),
    memberId: auth.member_id || body.member_id || body.MEMBER_ID || "",
    applicationToken:
      auth.application_token || body.application_token || body.APP_SID || "",
    userId: String(userId || "").trim(),
    authKeys: Object.keys(auth),
  };
}

export function isYes(value) {
  if (value === true || value === 1 || value === "1") return true;
  const s = String(value ?? "")
    .trim()
    .toLowerCase();
  return s === "y" || s === "yes" || s === "true" || s === "да";
}

/** Для свойств БП: пустая строка из «второй линии» = взять default (обычно Да) */
export function propFlag(value, defaultYes = true) {
  if (value == null) return defaultYes;
  if (Array.isArray(value)) value = value[0];
  const s = String(value).trim();
  if (s === "") return defaultYes;
  if (isYes(s)) return true;
  const low = s.toLowerCase();
  if (low === "n" || low === "no" || low === "false" || low === "нет") return false;
  return defaultYes;
}

export function pickLeadId(body) {
  const candidates = [
    body?.document_id,
    body?.DOCUMENT_ID,
    body?.documentId,
    body?.data?.DOCUMENT_ID,
    body?.data?.document_id,
  ];
  for (const doc of candidates) {
    if (doc == null || doc === "") continue;
    if (Array.isArray(doc) && doc.length) {
      const last = doc[doc.length - 1];
      const m = String(last).match(/(\d+)\s*$/);
      if (m) return m[1];
      return String(last);
    }
    if (typeof doc === "object") {
      const vals = Object.values(doc);
      if (vals.length) {
        const last = vals[vals.length - 1];
        const m = String(last).match(/(\d+)\s*$/);
        if (m) return m[1];
      }
    }
    if (typeof doc === "string" && doc) {
      const m = doc.match(/(\d+)\s*$/);
      return m ? m[1] : doc;
    }
  }
  return "";
}

/** HTML: install = сразу регистрирует; info = карточка приложения в меню */
export function bx24BootstrapHtml({
  finishInstall = false,
  title = "Расчёт рейтинга лида",
  activityCode = "lead_rating_calculate",
  activityHandler = "",
  callInstallFinish = false,
} = {}) {
  const mode = finishInstall ? "install" : "info";
  const finishCall =
    finishInstall || callInstallFinish
      ? "try { BX24.installFinish(); } catch (e) {}"
      : "";
  const safeHandler = String(activityHandler || "").replace(/'/g, "\\'");

  return `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <title>${title}</title>
  <script src="//api.bitrix24.com/api/v1/"></script>
  <style>
    :root { --bg:#f6f7f9; --card:#fff; --text:#1a1a1a; --muted:#667085; --line:#e6e8ec; --ok:#067647; --err:#b42318; --btn:#111; }
    body{font:15px/1.45 system-ui,sans-serif;margin:0;background:var(--bg);color:var(--text)}
    .wrap{max-width:720px;margin:0 auto;padding:1.25rem}
    h1{font-size:1.35rem;margin:0 0 .35rem}
    .sub{color:var(--muted);margin:0 0 1.25rem}
    .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1rem 1.1rem;margin:0 0 .85rem}
    .card h2{font-size:1rem;margin:0 0 .65rem}
    ul{margin:.35rem 0 0;padding-left:1.2rem}
    li{margin:.25rem 0}
    code,pre{background:#f2f4f7;border-radius:6px}
    code{padding:.1rem .35rem;font-size:.92em}
    pre{padding:.75rem;overflow:auto;margin:.5rem 0 0}
    .row{display:flex;flex-wrap:wrap;gap:.5rem;margin-top:.75rem}
    button,.linkbtn{
      appearance:none;border:0;border-radius:8px;padding:.55rem .9rem;font:inherit;cursor:pointer;
      background:var(--btn);color:#fff;text-decoration:none;display:inline-block
    }
    button.secondary{background:#fff;color:var(--text);border:1px solid var(--line)}
    .ok{color:var(--ok)} .err{color:var(--err)} .muted{color:var(--muted)}
    #status{margin:.25rem 0 .75rem}
  </style>
</head>
<body>
  <div class="wrap">
    <h1>${title}</h1>
    <p class="sub">Локальное приложение Битрикс24 · активити БП <code>${activityCode}</code></p>
    <p id="status" class="muted">Подключение к Битрикс24…</p>

    <div id="panel" style="display:none">
      <div class="card">
        <h2>Что это</h2>
        <ul>
          <li>Считает рейтинг лида (А+ / А / В / С) по критериям из ScoringTable.</li>
          <li>В БП: <b>Действия приложений → Расчёт рейтинга лида</b>.</li>
          <li>Handler активити: <code id="handlerUrl">${safeHandler || "…"}</code></li>
        </ul>
      </div>

      <div class="card">
        <h2>Настройка активити в БП</h2>
        <ul>
          <li><b>Таблица весов (JSON)</b> = константа портала или шаблона БП</li>
          <li><b>Конфиг рейтинга (JSON)</b> = поле записи + пороги avg→enumId</li>
          <li><b>Записать рейтинг в лид</b> = Да</li>
          <li>Критерии всегда читаются с лида по ключам ScoringTable</li>
          <li>«Период ожидания» 10+ мин — это таймаут; ответ обычно за секунды</li>
        </ul>
      </div>

      <div class="card">
        <h2>Карточка приложения (Переустановить)</h2>
        <p class="muted">Пункт меню открывает эту страницу. Кнопка «Переустановить» — только в карточке DevOps.</p>
        <div class="row">
          <a class="linkbtn" id="devopsList" href="#" target="_blank" rel="noopener">Открыть Интеграции</a>
          <a class="linkbtn secondary" id="devopsEdit" href="#" target="_blank" rel="noopener">Карточка приложения (если известен ID)</a>
        </div>
        <p class="muted" style="margin-top:.75rem">Путь: Приложения → Разработчикам → <b>Интеграции</b> → «Расчёт рейтинга лида…»</p>
      </div>

      <div class="card">
        <h2>После деплоя Layero</h2>
        <p class="muted">Файл с OAuth на сервере стирается. Чтобы <b>не</b> открывать меню каждый раз — один раз в Layero:</p>
        <ul>
          <li><b>Рекомендуется:</b> входящий вебхук портала → env <code>BITRIX_WEBHOOK_URL</code> (права <b>crm</b> + <b>bizproc</b>). Это ваш секрет на вашем сервере, не «передача вебхука чужим приложениям».</li>
          <li>Или: после сохранения ниже скопируйте <code>refresh_token</code> → env <code>BITRIX_REFRESH_TOKEN</code> + <code>BITRIX_DOMAIN=braincon.bitrix24.ru</code>.</li>
        </ul>
        <p id="durableStatus" class="muted">Проверка устойчивости…</p>
        <pre id="refreshBox" style="display:none"></pre>
      </div>

      <div class="card">
        <h2>Активити</h2>
        <p id="regStatus" class="muted">Статус регистрации неизвестен.</p>
        <div class="row">
          <button type="button" id="btnRegister">Перерегистрировать активити</button>
        </div>
        <pre id="log"></pre>
      </div>
    </div>
  </div>

  <script>
    const MODE = ${JSON.stringify(mode)};
    const statusEl = document.getElementById('status');
    const logEl = document.getElementById('log');
    const panel = document.getElementById('panel');
    const regStatus = document.getElementById('regStatus');
    const durableStatus = document.getElementById('durableStatus');
    const refreshBox = document.getElementById('refreshBox');

    function log(msg){ if (logEl) logEl.textContent += msg + '\\n'; }

    function setLinks(domain) {
      const list = document.getElementById('devopsList');
      const edit = document.getElementById('devopsEdit');
      if (list) list.href = 'https://' + domain + '/devops/list/';
      if (edit) edit.href = 'https://' + domain + '/devops/edit/application/390/';
    }

    function showDurable(d, refreshToken) {
      if (!durableStatus) return;
      var ok = d && (d.hasWebhook || d.hasEnvRefresh);
      if (ok) {
        durableStatus.className = 'ok';
        durableStatus.textContent = d.hasWebhook
          ? 'Устойчиво: задан BITRIX_WEBHOOK_URL — после деплоя меню не нужно.'
          : 'Устойчиво: задан BITRIX_REFRESH_TOKEN — после деплоя меню обычно не нужно.';
      } else {
        durableStatus.className = 'err';
        durableStatus.textContent = 'Пока только файл на сервере. После следующего деплоя снова откройте меню ИЛИ добавьте webhook/refresh в Layero (см. выше).';
      }
      if (refreshBox && refreshToken && !(d && d.hasEnvRefresh) && !(d && d.hasWebhook)) {
        refreshBox.style.display = 'block';
        refreshBox.textContent = 'BITRIX_DOMAIN=' + (d && d.domain ? d.domain : '') + '\\nBITRIX_REFRESH_TOKEN=' + refreshToken;
      }
    }

    function saveAuth(auth) {
      return fetch('/bitrix/save-auth', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          domain: auth.domain,
          access_token: auth.access_token,
          refresh_token: auth.refresh_token || '',
          member_id: auth.member_id || '',
          user_id: auth.user_id || ''
        })
      }).then(function (r) { return r.json(); });
    }

    function registerActivity(auth) {
      return fetch('/bitrix/register-from-bx24', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain: auth.domain, access_token: auth.access_token, user_id: auth.user_id })
      }).then(function (r) {
        return r.json().then(function (j) { return { ok: r.ok, j: j }; });
      }).then(function (x) {
        if (!x.ok || !x.j.ok) throw new Error((x.j && x.j.error) || 'Ошибка регистрации');
        if (x.j.handler) {
          var hu = document.getElementById('handlerUrl');
          if (hu) hu.textContent = x.j.handler;
        }
        return x.j;
      });
    }

    BX24.init(function () {
      const raw = BX24.getAuth() || {};
      const domain = (raw.domain || '').replace(/^https?:\\/\\//,'').replace(/\\/$/,'');
      const access_token = raw.access_token || '';
      if (!domain || !access_token) {
        statusEl.className = 'err';
        statusEl.textContent = 'BX24 не отдал auth. Откройте приложение из меню Битрикс.';
        return;
      }
      const auth = {
        domain: domain,
        access_token: access_token,
        refresh_token: raw.refresh_token || '',
        member_id: raw.member_id || '',
        user_id: raw.user_id
      };
      setLinks(domain);

      // Как у приложений Маркета: сохраняем OAuth на нашем сервере
      saveAuth(auth).then(function (j) {
        showDurable(j && j.durable, j && j.refresh_token);
      }).catch(function () {
        showDurable(null, auth.refresh_token || '');
      });

      if (MODE === 'install') {
        statusEl.textContent = 'Регистрация активити…';
        registerActivity(auth)
          .then(function (j) {
            statusEl.className = 'ok';
            statusEl.textContent = 'Готово: активити зарегистрировано';
            log('Код: ' + j.code);
            log('Handler: ' + j.handler);
            ${finishCall}
          })
          .catch(function (e) {
            statusEl.className = 'err';
            statusEl.textContent = e.message || String(e);
            log(String(e));
          });
        return;
      }

      statusEl.textContent = '';
      panel.style.display = 'block';
      regStatus.textContent = 'OAuth сохранён. Можно перерегистрировать активити кнопкой ниже.';
      ${finishCall}
      document.getElementById('btnRegister').onclick = function () {
        regStatus.className = 'muted';
        regStatus.textContent = 'Регистрация…';
        logEl.textContent = '';
        registerActivity(auth)
          .then(function (j) {
            regStatus.className = 'ok';
            regStatus.textContent = 'Активити перерегистрировано: ' + j.code;
            log('Handler: ' + j.handler);
          })
          .catch(function (e) {
            regStatus.className = 'err';
            regStatus.textContent = e.message || String(e);
            log(String(e));
          });
      };
    });
  </script>
</body>
</html>`;
}
