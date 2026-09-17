import { randomToken, sha256 } from "./crypto.js";
import { one, q } from "./db.js";
import type { SessionRow } from "./sessions.js";
import type { Tenant } from "./tenant.js";

/**
 * The local browser relay: the customer's own browser, driven through a small extension. Sites that
 * block data-center browsers (banks, airlines) work from a residential machine the customer already
 * trusts, and the residential-proxy bill goes away for them. The extension long-polls this server
 * for commands over HTTPS (serverless functions cannot hold a socket), runs them in a tab of its own,
 * and posts the result. A command is one round trip of a second or two.
 */
export const RELAY_ONLINE_MS = Number(process.env.RELAY_ONLINE_MS ?? 25_000);
const COMMAND_TIMEOUT_MS = Number(process.env.RELAY_COMMAND_TIMEOUT_MS ?? 30_000);

export interface RelayCommand {
  kind: "goto" | "snapshot" | "click" | "type" | "text" | "find" | "back";
  url?: string;
  ref?: string;
  text?: string;
  enter?: boolean;
}

/** A fresh device token for the extension; only its hash is stored. Returned once. */
export async function issueToken(t: Tenant, name = "My computer"): Promise<string> {
  const token = `rl_${randomToken(24).replace(/[^a-zA-Z0-9]/g, "")}`;
  await q("insert into relay_devices (user_id, token_hash, name) values ($1, $2, $3)", [t.id, sha256(token), name.slice(0, 80)]);
  return token;
}

export async function revokeTokens(t: Tenant): Promise<void> {
  await q("delete from relay_devices where user_id = $1", [t.id]);
}

/** The customer a token belongs to, updating its heartbeat. */
export async function deviceForToken(token: string, currentUrl?: string): Promise<{ user_id: string; name: string | null } | undefined> {
  if (!/^rl_[a-zA-Z0-9]{20,}$/.test(token)) return undefined;
  const row = await one<{ user_id: string; name: string | null }>("update relay_devices set last_seen_at = now(), current_url = coalesce($2, current_url) where token_hash = $1 returning user_id, name", [sha256(token), currentUrl?.slice(0, 500) ?? null]);
  return row;
}

export async function relayStatus(t: Tenant): Promise<{ online: boolean; devices: Array<{ name: string | null; last_seen_at: Date | null; current_url: string | null }> }> {
  const devices = await q<{ name: string | null; last_seen_at: Date | null; current_url: string | null }>("select name, last_seen_at, current_url from relay_devices where user_id = $1 order by last_seen_at desc nulls last", [t.id]);
  const online = devices.some((d) => d.last_seen_at && Date.now() - new Date(d.last_seen_at).getTime() < RELAY_ONLINE_MS);
  return { online, devices };
}

/** Queue a command for the customer's extension and wait for its result. */
export async function sendCommand(t: Tenant, cmd: RelayCommand, timeoutMs = COMMAND_TIMEOUT_MS): Promise<Record<string, unknown>> {
  const { online } = await relayStatus(t);
  if (!online) throw new Error("The local browser relay is offline: the user's computer with the extension is not connected right now. Use the hosted browser, or ask the user to open their browser with the extension enabled.");
  const row = await one<{ id: string }>("insert into relay_commands (user_id, command) values ($1, $2::jsonb) returning id", [t.id, JSON.stringify(cmd)]);
  const id = row!.id;
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    await new Promise((r) => setTimeout(r, 500));
    const done = await one<{ result: Record<string, unknown> | null }>("select result from relay_commands where id = $1 and done_at is not null", [id]);
    if (done) return done.result ?? {};
  }
  await q("delete from relay_commands where id = $1 and done_at is null", [id]);
  throw new Error(`The local browser did not answer within ${Math.round(timeoutMs / 1000)}s (${cmd.kind}). It may be busy or the page may be stuck; try again or use the hosted browser.`);
}

/** The extension asks for work: the oldest untaken command, marked taken. */
export async function takeNext(userId: string): Promise<{ id: string; command: RelayCommand } | undefined> {
  return one<{ id: string; command: RelayCommand }>(
    "update relay_commands set taken_at = now() where id = (select id from relay_commands where user_id = $1 and taken_at is null order by created_at limit 1) returning id, command",
    [userId],
  );
}

export async function postResult(userId: string, id: string, result: Record<string, unknown>): Promise<boolean> {
  const r = await q("update relay_commands set result = $3::jsonb, done_at = now() where id = $2 and user_id = $1 and done_at is null returning id", [userId, id, JSON.stringify(result).slice(0, 200_000)]);
  return r.length > 0;
}

/** Old commands and results are not kept. */
export async function pruneRelay(): Promise<void> {
  await q("delete from relay_commands where created_at < now() - interval '1 hour'").catch(() => {});
}

/** The local_browser tool: the same verbs as the hosted browser, on the user's machine. */
export async function runLocalBrowserTool(t: Tenant, _row: SessionRow, args: Record<string, unknown>): Promise<string> {
  const s = (k: string) => String(args[k] ?? "").trim();
  const action = s("action") as RelayCommand["kind"];
  if (!["goto", "snapshot", "click", "type", "text", "find", "back"].includes(action)) return "Pass action: goto, snapshot, click, type, text, find or back.";
  const cmd: RelayCommand = { kind: action };
  if (action === "goto") {
    if (!s("url")) return "Pass url.";
    cmd.url = s("url");
  }
  if (action === "click" || action === "type") {
    if (!s("ref") && !s("text")) return "Pass ref (from the last local snapshot) or text (the visible label).";
    cmd.ref = s("ref") || undefined;
  }
  if (action === "type" || action === "find" || (action === "click" && !s("ref"))) cmd.text = s("text");
  if (action === "type") cmd.enter = !!args.enter;
  const r = await sendCommand(t, cmd);
  if (typeof r.error === "string" && r.error) return `local_browser ${action}: ${r.error}`;
  const head = [r.title ? String(r.title) : "", r.url ? String(r.url) : ""].filter(Boolean).join("\n");
  const body = typeof r.text === "string" ? r.text : typeof r.snapshot === "string" ? r.snapshot : "";
  return `${head}${head && body ? "\n\n" : ""}${body}`.trim() || `${action}: ok`;
}
