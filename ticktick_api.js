// TickTick Open API v1 client backed by Fern's SecretsVault (${secret:access_token})
// and automatic OAuth 2.0 refresh via fern.oauth.refresh().

export const TICKTICK_API_BASE = "https://api.ticktick.com/open/v1";
export const TICKTICK_AUTHORIZE_URL = "https://ticktick.com/oauth/authorize";
export const TICKTICK_TOKEN_URL = "https://ticktick.com/oauth/token";
export const TICKTICK_SCOPES = ["tasks:read", "tasks:write"];

export function createTickTickClient(fern) {
  let refreshedInFlight = false;

  async function tryRefreshToken() {
    if (refreshedInFlight) return false;
    if (!fern.settings.hasSecret("refresh_token")) return false;
    const clientId = String(fern.settings.get("client_id") || "").trim();
    if (!clientId) return false;
    refreshedInFlight = true;
    try {
      await fern.oauth.refresh({
        tokenUrl: TICKTICK_TOKEN_URL,
        clientId,
        clientSecretKey: fern.settings.hasSecret("client_secret") ? "client_secret" : undefined,
        refreshTokenKey: "refresh_token",
        scopes: TICKTICK_SCOPES,
        tokenAuth: "basic",
        saveAccessTokenAs: "access_token",
        saveRefreshTokenAs: "refresh_token",
      });
      return true;
    } catch (_err) {
      return false;
    } finally {
      refreshedInFlight = false;
    }
  }

  async function request(method, path, body = undefined, allowRetry401 = true) {
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

    if (resp.status === 401 && allowRetry401) {
      const ok = await tryRefreshToken();
      if (ok) {
        return request(method, path, body, false);
      }
      throw new Error("TickTick token expired (HTTP 401). Please sign in again via OAuth.");
    }

    if (resp.status === 429) {
      throw new Error("TickTick rate limit reached (HTTP 429). Sync will retry automatically.");
    }

    if (resp.status === 404) {
      return { notFound: true, status: 404, data: null };
    }

    if (!resp.ok) {
      const preview = String(resp.text() || "").slice(0, 200);
      throw new Error(`TickTick API ${method} ${path} failed (HTTP ${resp.status}): ${preview}`);
    }

    const raw = resp.text();
    if (!raw || !raw.trim()) {
      return { notFound: false, status: resp.status, data: null };
    }
    return { notFound: false, status: resp.status, data: JSON.parse(raw) };
  }

  return {
    async listProjects() {
      const res = await request("GET", "/project");
      return Array.isArray(res.data) ? res.data : [];
    },

    async getProjectData(projectId) {
      const res = await request("GET", `/project/${encodeURIComponent(projectId)}/data`);
      if (res.notFound || !res.data) return { project: null, tasks: [], columns: [] };
      return {
        project: res.data.project || null,
        tasks: Array.isArray(res.data.tasks) ? res.data.tasks : [],
        columns: Array.isArray(res.data.columns) ? res.data.columns : [],
      };
    },

    async getInboxData(preferredInboxId) {
      const candidates = [];
      if (preferredInboxId && String(preferredInboxId).trim()) {
        candidates.push(String(preferredInboxId).trim());
      }
      if (!candidates.includes("inbox")) {
        candidates.push("inbox");
      }
      for (const candidate of candidates) {
        try {
          const res = await request("GET", `/project/${encodeURIComponent(candidate)}/data`);
          if (!res.notFound && res.data) {
            const tasks = Array.isArray(res.data.tasks) ? res.data.tasks : [];
            const detectedId =
              (res.data.project && res.data.project.id) ||
              (tasks.length > 0 && tasks[0].projectId) ||
              (candidate !== "inbox" ? candidate : null);
            return { ok: true, inboxId: detectedId, tasks };
          }
        } catch (_err) {
          // Try next candidate
        }
      }
      return { ok: false, inboxId: preferredInboxId || null, tasks: [] };
    },

    async getTask(projectId, taskId) {
      const res = await request(
        "GET",
        `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`
      );
      if (res.notFound || !res.data) return null;
      return res.data;
    },

    async createTask(payload) {
      const res = await request("POST", "/task", payload);
      if (!res.data || !res.data.id) {
        throw new Error("TickTick createTask response missing task id");
      }
      return res.data;
    },

    async updateTask(taskId, payload) {
      const res = await request("POST", `/task/${encodeURIComponent(taskId)}`, payload);
      return res.data || payload;
    },

    async completeTask(projectId, taskId) {
      await request(
        "POST",
        `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}/complete`
      );
      return true;
    },

    async deleteTask(projectId, taskId) {
      await request(
        "DELETE",
        `/project/${encodeURIComponent(projectId)}/task/${encodeURIComponent(taskId)}`
      );
      return true;
    },
  };
}
