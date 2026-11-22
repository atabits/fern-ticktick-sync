// Optional stateless Cloudflare Worker OAuth token-exchange proxy for 1-click TickTick login.
// Holds TICKTICK_CLIENT_ID and TICKTICK_CLIENT_SECRET as encrypted Cloudflare Worker secrets.
// Never stores user tokens or touches task data — only signs /oauth/token exchanges.
//
// Deploy:
//   npx wrangler secret put TICKTICK_CLIENT_ID
//   npx wrangler secret put TICKTICK_CLIENT_SECRET
//   npx wrangler deploy

const TICKTICK_TOKEN_URL = "https://ticktick.com/oauth/token";
const ALLOWED_REDIRECT_URI = "http://127.0.0.1:18481/callback";
const ALLOWED_SCOPES = new Set(["tasks:read", "tasks:write"]);
const PINNED_SCOPE = "tasks:read tasks:write";
const MAX_BODY_BYTES = 4096;
const MAX_CODE_LEN = 1024;
const MAX_REFRESH_TOKEN_LEN = 2048;
const PKCE_VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

function jsonError(error, status) {
  return Response.json(
    { error },
    {
      status,
      headers: { "Cache-Control": "no-store" },
    }
  );
}

function isExactAllowedRedirectUri(raw) {
  if (typeof raw !== "string" || raw !== ALLOWED_REDIRECT_URI) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return false;
  }
  return (
    parsed.protocol === "http:" &&
    parsed.hostname === "127.0.0.1" &&
    parsed.port === "18481" &&
    parsed.pathname === "/callback" &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    parsed.href === ALLOWED_REDIRECT_URI
  );
}

async function readBoundedBodyText(request, maxBytes) {
  const clHeader = request.headers.get("content-length");
  if (clHeader !== null) {
    const trimmed = clHeader.trim();
    if (!/^\d+$/.test(trimmed)) {
      return { ok: false, status: 400, error: "invalid_content_length" };
    }
    if (Number(trimmed) > maxBytes) {
      return { ok: false, status: 413, error: "payload_too_large" };
    }
  }

  if (!request.body) {
    return { ok: true, text: "" };
  }

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Ignore stream cancel errors
        }
        return { ok: false, status: 413, error: "payload_too_large" };
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Ignore lock release errors
    }
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged) };
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { Allow: "POST", "Cache-Control": "no-store" },
      });
    }

    // Reject browser cross-origin / CSRF requests; native desktop clients never send Origin.
    if (request.headers.has("origin")) {
      return jsonError("forbidden_origin", 403);
    }

    const contentType = request.headers.get("content-type");
    if (contentType && contentType.toLowerCase().split(";")[0].trim() !== "application/x-www-form-urlencoded") {
      return jsonError("unsupported_media_type", 415);
    }

    const clientId = typeof env?.TICKTICK_CLIENT_ID === "string" ? env.TICKTICK_CLIENT_ID.trim() : "";
    const clientSecret = typeof env?.TICKTICK_CLIENT_SECRET === "string" ? env.TICKTICK_CLIENT_SECRET.trim() : "";
    if (!clientId || !clientSecret) {
      return jsonError("server_misconfigured", 500);
    }

    const bodyRes = await readBoundedBodyText(request, MAX_BODY_BYTES);
    if (!bodyRes.ok) {
      return jsonError(bodyRes.error, bodyRes.status);
    }

    const form = new URLSearchParams(bodyRes.text);
    const grantType = form.get("grant_type") || "";
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return jsonError("unsupported_grant_type", 400);
    }

    const rawScope = form.get("scope");
    if (rawScope !== null && rawScope.trim() !== "") {
      const tokens = rawScope.trim().split(/\s+/);
      if (tokens.some((tok) => !ALLOWED_SCOPES.has(tok))) {
        return jsonError("invalid_scope", 400);
      }
    }

    const forward = new URLSearchParams();
    forward.set("grant_type", grantType);
    forward.set("scope", PINNED_SCOPE);

    const code = form.get("code");
    const refreshToken = form.get("refresh_token");
    const redirectUri = form.get("redirect_uri");
    const codeVerifier = form.get("code_verifier");

    if (grantType === "authorization_code") {
      if (!code || !code.trim() || code.length > MAX_CODE_LEN) {
        return jsonError("invalid_request", 400);
      }
      if (refreshToken !== null && refreshToken !== "") {
        return jsonError("invalid_request", 400);
      }
      if (!isExactAllowedRedirectUri(redirectUri)) {
        return jsonError("invalid_redirect_uri", 400);
      }
      forward.set("code", code.trim());
      forward.set("redirect_uri", ALLOWED_REDIRECT_URI);
      if (codeVerifier !== null && codeVerifier !== "") {
        if (!PKCE_VERIFIER_RE.test(codeVerifier)) {
          return jsonError("invalid_request", 400);
        }
        forward.set("code_verifier", codeVerifier);
      }
    } else {
      if (!refreshToken || !refreshToken.trim() || refreshToken.length > MAX_REFRESH_TOKEN_LEN) {
        return jsonError("invalid_request", 400);
      }
      if ((code !== null && code !== "") || (redirectUri !== null && redirectUri !== "")) {
        return jsonError("invalid_request", 400);
      }
      forward.set("refresh_token", refreshToken.trim());
    }

    const basic = btoa(`${clientId}:${clientSecret}`);
    const upstream = await fetch(TICKTICK_TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: forward.toString(),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    });
  },
};
