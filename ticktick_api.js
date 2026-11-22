// TickTick Open API v1 client backed by Fern's SecretsVault (${secret:access_token})
// and automatic OAuth 2.0 refresh via fern.oauth.refresh().

export const TICKTICK_API_BASE = "https://api.ticktick.com/open/v1";
export const TICKTICK_AUTHORIZE_URL = "https://ticktick.com/oauth/authorize";
export const TICKTICK_TOKEN_URL = "https://ticktick.com/oauth/token";
export const TICKTICK_SCOPES = ["tasks:read", "tasks:write"];

const DEFAULT_RATE_LIMIT_MS = 60_000;
const MIN_RATE_LIMIT_MS = 5_000;
const MAX_RATE_LIMIT_MS = 600_000;

function createApiError(message, meta = {}) {
  const err = new Error(message);
  if (meta.status !== undefined) err.status = meta.status;
  if (meta.code !== undefined) err.code = meta.code;
  err.fatal = Boolean(meta.fatal);
  if (meta.retryAfterMs !== undefined) err.retryAfterMs = meta.retryAfterMs;
  return err;
}

function requireId(val, name) {
  const s = val === null || val === undefined ? "" : String(val).trim();
  if (!s || s === "null" || s === "undefined") {
    throw createApiError(`Missing required TickTick ${name}`, { code: "INVALID_ARGUMENT" });
  }
  return s;
}

function getHeaderCaseInsensitive(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  if (typeof headers.get === "function") {
    return headers.get(name);
  }
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === target) {
      return v == null ? null : String(v);
    }
  }
  return null;
}

function parseRetryAfterMs(resp) {
  const raw = getHeaderCaseInsensitive(resp && resp.headers, "retry-after");
  if (!raw) return DEFAULT_RATE_LIMIT_MS;
  const trimmed = raw.trim();
  if (/^\d+$/.test(trimmed)) {
    const ms = Number(trimmed) * 1000;
    return Math.min(MAX_RATE_LIMIT_MS, Math.max(MIN_RATE_LIMIT_MS, ms));
  }
  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    const delta = dateMs - Date.now();
    return Math.min(MAX_RATE_LIMIT_MS, Math.max(MIN_RATE_LIMIT_MS, delta));
  }
  return DEFAULT_RATE_LIMIT_MS;
}

export function createTickTickClient(fern, options = {}) {
  let refreshPromise = null;
  let rateLimitedUntil = 0;

  function defaultOAuthSetup() {
    const clientId = String(fern.settings.get("client_id") || "").trim();
    const hasSecret = Boolean(fern.settings.hasSecret("client_secret"));
    return {
      mode: "personal",
      clientId,
      hasSecret,
      tokenUrl: TICKTICK_TOKEN_URL,
      clientSecretKey: hasSecret ? "client_secret" : undefined,
      tokenAuth: "basic",
      ready: Boolean(clientId && hasSecret),
    };
  }

  const getOAuthSetup =
    typeof options.getOAuthSetup === "function" ? options.getOAuthSetup : defaultOAuthSetup;
  const onAuthExpired =
    typeof options.onAuthExpired === "function" ? options.onAuthExpired : null;

  async function tryRefreshToken() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      if (!fern.settings.hasSecret("refresh_token")) return false;
      const setup = getOAuthSetup();
      if (!setup || !setup.ready || !setup.clientId || !setup.tokenUrl) return false;
      try {
        const res = await fern.oauth.refresh({
          tokenUrl: setup.tokenUrl,
          clientId: setup.clientId,
          clientSecretKey: setup.clientSecretKey,
          refreshTokenKey: "refresh_token",
          scopes: TICKTICK_SCOPES,
          tokenAuth: setup.tokenAuth || "basic",
          saveAccessTokenAs: "access_token",
          saveRefreshTokenAs: "refresh_token",
        });
        return Boolean(res === undefined || res === null || res.ok !== false);
      } catch (_err) {
        return false;
      }
    })();
    try {
      return await refreshPromise;
    } finally {
      refreshPromise = null;
    }
  }

  function handleUnrecoverable401() {
    const msg = "TickTick token expired (HTTP 401). Please sign in again via OAuth.";
    try {
      if (fern.oauth && typeof fern.oauth.clearTokens === "function") {
        fern.oauth.clearTokens(["access_token", "refresh_token"]);
      }
    } catch (_err) {
      // Best-effort token clearing
    }
    if (onAuthExpired) {
      try {
        onAuthExpired(msg);
      } catch (_err) {
        // Never mask the 401 error
      }
    }
    throw createApiError(msg, { status: 401, code: "AUTH_EXPIRED", fatal: true });
  }

  async function request(method, path, body = undefined, reqOpts = {}) {
    const { allowRetry401 = true, allow404 = false, expectJson = true } = reqOpts;

    const now = Date.now();
    if (rateLimitedUntil > now) {
      const waitSec = Math.max(1, Math.ceil((rateLimitedUntil - now) / 1000));
      throw createApiError(
        `TickTick rate limit active — retrying after ${waitSec}s cooldown.`,
        { status: 429, code: "RATE_LIMITED", fatal: true, retryAfterMs: rateLimitedUntil - now }
      );
    }

    const url = `${TICKTICK_API_BASE}${path}`;
    const headers = {
      Authorization: "Bearer ${secret:access_token}",
      Accept: "application/json",
    };
    const opts = { method, headers, timeoutMs: 20000 };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }

    const resp = await fern.http.fetch(url, opts);

    if (resp.status === 401) {
      if (allowRetry401) {
        const ok = await tryRefreshToken();
        if (ok) {
          return request(method, path, body, { allowRetry401: false, allow404, expectJson });
        }
      }
      handleUnrecoverable401();
    }

    if (resp.status === 429) {
      const retryAfterMs = parseRetryAfterMs(resp);
      rateLimitedUntil = Date.now() + retryAfterMs;
      throw createApiError(
        "TickTick rate limit reached (HTTP 429). Sync paused temporarily.",
        { status: 429, code: "RATE_LIMITED", fatal: true, retryAfterMs }
      );
    }

    if (resp.status === 404) {
      if (allow404) {
        return { notFound: true, status: 404, data: null };
      }
      const preview = typeof resp.text === "function" ? String(resp.text() || "").slice(0, 200) : "";
      throw createApiError(
        `TickTick API ${method} ${path} failed (HTTP 404): ${preview || "Not Found"}`,
        { status: 404, code: "NOT_FOUND" }
      );
    }

    if (!resp.ok) {
      const preview = typeof resp.text === "function" ? String(resp.text() || "").slice(0, 200) : "";
      throw createApiError(
        `TickTick API ${method} ${path} failed (HTTP ${resp.status}): ${preview}`,
        { status: resp.status, code: "HTTP_ERROR" }
      );
    }

    if (!expectJson) {
      return { notFound: false, status: resp.status, data: null };
    }

    const raw = typeof resp.text === "function" ? resp.text() : "";
    if (!raw || !String(raw).trim()) {
      return { notFound: false, status: resp.status, data: null };
    }
    try {
      return { notFound: false, status: resp.status, data: JSON.parse(raw) };
    } catch (_parseErr) {
      const preview = String(raw).slice(0, 200);
      throw createApiError(
        `TickTick API ${method} ${path} returned invalid JSON (HTTP ${resp.status}): ${preview}`,
        { status: resp.status, code: "INVALID_JSON" }
      );
    }
  }

  return {
    getRateLimitedUntil() {
      return rateLimitedUntil;
    },

    resetRateLimit() {
      rateLimitedUntil = 0;
    },

    async listProjects() {
      const res = await request("GET", "/project");
      return Array.isArray(res.data) ? res.data : [];
    },

    async createProject(name, color = null) {
      const trimmed = String(name || "").trim();
      if (!trimmed) {
        throw createApiError("Missing required TickTick project name", { code: "INVALID_ARGUMENT" });
      }
      const payload = { name: trimmed, kind: "TASK" };
      if (color && typeof color === "string" && color.trim()) {
        payload.color = color.trim();
      }
      const res = await request("POST", "/project", payload);
      if (!res.data || !res.data.id) {
        throw createApiError("TickTick createProject response missing project id", {
          status: res.status,
          code: "INVALID_RESPONSE",
        });
      }
      return res.data;
    },

    async listTags() {
      const res = await request("GET", "/tag", undefined, { allow404: true });
      if (res.notFound || !Array.isArray(res.data)) return [];
      return res.data;
    },

    async createTag(name, label = null) {
      const rawLabel = String(label || name || "").trim().slice(0, 64);
      const lowerName = String(name || rawLabel).trim().slice(0, 64).toLowerCase();
      if (!lowerName) {
        throw createApiError("Missing required TickTick tag name", { code: "INVALID_ARGUMENT" });
      }
      const safeLabel = rawLabel && rawLabel.toLowerCase() === lowerName ? rawLabel : lowerName;
      const res = await request("POST", "/tag", { name: lowerName, label: safeLabel });
      return res.data || { name: lowerName, label: safeLabel };
    },

    async moveTask(fromProjectId, toProjectId, taskId) {
      const fromPid = requireId(fromProjectId, "fromProjectId");
      const toPid = requireId(toProjectId, "toProjectId");
      const tid = requireId(taskId, "taskId");
      const res = await request("POST", "/task/move", [
        { fromProjectId: fromPid, toProjectId: toPid, taskId: tid },
      ]);
      return res.data || [];
    },

    async getProjectData(projectId) {
      const pid = requireId(projectId, "projectId");
      const res = await request("GET", `/project/${encodeURIComponent(pid)}/data`, undefined, {
        allow404: true,
      });
      if (res.notFound || !res.data) {
        return { notFound: Boolean(res.notFound), project: null, tasks: [], columns: [] };
      }
      return {
        notFound: false,
        project: res.data.project || null,
        tasks: Array.isArray(res.data.tasks) ? res.data.tasks : [],
        columns: Array.isArray(res.data.columns) ? res.data.columns : [],
      };
    },

    async getInboxData(preferredInboxId) {
      const candidates = [];
      if (preferredInboxId && String(preferredInboxId).trim()) {
        const trimmed = String(preferredInboxId).trim();
        if (trimmed !== "null" && trimmed !== "undefined") {
          candidates.push(trimmed);
        }
      }
      if (!candidates.includes("inbox")) {
        candidates.push("inbox");
      }
      for (const candidate of candidates) {
        const res = await request("GET", `/project/${encodeURIComponent(candidate)}/data`, undefined, {
          allow404: true,
        });
        if (!res.notFound && res.data) {
          const tasks = Array.isArray(res.data.tasks) ? res.data.tasks : [];
          const detectedId =
            (res.data.project && res.data.project.id) ||
            (tasks.length > 0 && tasks[0].projectId) ||
            (candidate !== "inbox" ? candidate : null);
          return { ok: true, inboxId: detectedId, tasks };
        }
      }
      return { ok: false, inboxId: preferredInboxId || null, tasks: [] };
    },

    async getTask(projectId, taskId) {
      const pid = requireId(projectId, "projectId");
      const tid = requireId(taskId, "taskId");
      const res = await request(
        "GET",
        `/project/${encodeURIComponent(pid)}/task/${encodeURIComponent(tid)}`,
        undefined,
        { allow404: true }
      );
      if (res.notFound || !res.data) return null;
      return res.data;
    },

    async createTask(payload) {
      const res = await request("POST", "/task", payload);
      if (!res.data || !res.data.id) {
        throw createApiError("TickTick createTask response missing task id", {
          status: res.status,
          code: "INVALID_RESPONSE",
        });
      }
      return res.data;
    },

    async updateTask(taskId, payload) {
      const tid = requireId(taskId, "taskId");
      const res = await request("POST", `/task/${encodeURIComponent(tid)}`, payload);
      return res.data || payload;
    },

    async completeTask(projectId, taskId) {
      const pid = requireId(projectId, "projectId");
      const tid = requireId(taskId, "taskId");
      await request(
        "POST",
        `/project/${encodeURIComponent(pid)}/task/${encodeURIComponent(tid)}/complete`,
        undefined,
        { expectJson: false }
      );
      return true;
    },

    async deleteTask(projectId, taskId) {
      const pid = requireId(projectId, "projectId");
      const tid = requireId(taskId, "taskId");
      await request(
        "DELETE",
        `/project/${encodeURIComponent(pid)}/task/${encodeURIComponent(tid)}`,
        undefined,
        { expectJson: false }
      );
      return true;
    },
  };
}
