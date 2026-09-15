import type { VercelRequest, VercelResponse } from "@vercel/node";
import { requireTenant } from "../../../lib/auth.js";
import { signToken } from "../../../lib/crypto.js";
import { env } from "../../../lib/env.js";
import { GOOGLE_SCOPES, oauthClient } from "../../../lib/google.js";

/** Sends the customer to Google to connect their own calendar, inbox and Drive. */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  const t = await requireTenant(req, res);
  if (!t) return;
  if (!env.google.clientId()) return res.status(501).json({ error: "Google integration is not configured on this server" });
  const state = signToken({ uid: t.id, purpose: "google" }, 600);
  const url = oauthClient(`${env.appUrl()}/api/google/callback`).generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: GOOGLE_SCOPES,
    state,
    login_hint: t.email,
  });
  res.writeHead(302, { Location: url });
  res.end();
}
