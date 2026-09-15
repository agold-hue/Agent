import type { VercelRequest, VercelResponse } from "@vercel/node";
import { verifyToken } from "../../../lib/crypto.js";
import { env } from "../../../lib/env.js";
import { oauthClient } from "../../../lib/google.js";
import { setGoogleToken, tenantById } from "../../../lib/tenant.js";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";
  const payload = verifyToken(state);
  if (!code || !payload || payload.purpose !== "google" || typeof payload.uid !== "string") {
    res.writeHead(302, { Location: `${env.appUrl()}/app.html?google=error` });
    return res.end();
  }
  const t = await tenantById(payload.uid);
  if (!t) return res.status(404).end();
  const { tokens } = await oauthClient(`${env.appUrl()}/api/google/callback`).getToken(code);
  if (tokens.refresh_token) await setGoogleToken(t, tokens.refresh_token);
  res.writeHead(302, { Location: `${env.appUrl()}/app.html?google=${tokens.refresh_token ? "connected" : "no-refresh-token"}` });
  res.end();
}
