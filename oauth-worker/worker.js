// Optional stateless Cloudflare Worker OAuth token-exchange proxy for 1-click TickTick login.
// Holds TICKTICK_CLIENT_ID and TICKTICK_CLIENT_SECRET as encrypted Cloudflare Worker secrets.
// Never stores user tokens or touches task data — only signs /oauth/token exchanges.
//
// Deploy:
//   npx wrangler secret put TICKTICK_CLIENT_ID
//   npx wrangler secret put TICKTICK_CLIENT_SECRET
//   npx wrangler deploy

const TICKTICK_TOKEN_URL = "https://ticktick.com/oauth/token";
const ALLOWED_REDIRECT_PREFIX = "http://127.0.0.1:";

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }
    const form = new URLSearchParams(await request.text());
    const grantType = form.get("grant_type") || "";
    if (grantType !== "authorization_code" && grantType !== "refresh_token") {
      return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
    }
    if (grantType === "authorization_code") {
      const redirectUri = form.get("redirect_uri") || "";
      if (!redirectUri.startsWith(ALLOWED_REDIRECT_PREFIX)) {
        return Response.json({ error: "invalid_redirect_uri" }, { status: 400 });
      }
    }

    const forward = new URLSearchParams();
    forward.set("grant_type", grantType);
    if (form.get("code")) forward.set("code", form.get("code"));
    if (form.get("redirect_uri")) forward.set("redirect_uri", form.get("redirect_uri"));
    if (form.get("refresh_token")) forward.set("refresh_token", form.get("refresh_token"));
    if (form.get("scope")) forward.set("scope", form.get("scope"));

    const basic = btoa(`${env.TICKTICK_CLIENT_ID}:${env.TICKTICK_CLIENT_SECRET}`);
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
