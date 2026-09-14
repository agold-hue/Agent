import { one, q } from "./db.js";

/** Our record of a Managed Agents session and the routing state the routes need. */
export interface SessionRow {
  id: string;
  user_id: string;
  channel: "chat" | "email";
  kind: string;
  title: string | null;
  status: string;
  requester: string | null;
  reply_tag: string | null;
  email_subject: string | null;
  last_message_id: string | null;
  correspondent: string | null;
  browserbase_session_id: string | null;
  pending_kind: "checkpoint" | "ask_user" | "send_email" | null;
  pending_event_id: string | null;
  pending_deadline: Date | null;
  last_replied_idle_id: string | null;
  review_day: Date | null;
  digest_key: string | null;
  followup_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function getSession(id: string): Promise<SessionRow | undefined> {
  return one<SessionRow>("select * from agent_sessions where id = $1", [id]);
}

export async function insertSession(row: Partial<SessionRow> & { id: string; user_id: string; channel: "chat" | "email"; kind: string }): Promise<SessionRow> {
  const cols = Object.keys(row);
  const vals = Object.values(row);
  const r = await one<SessionRow>(
    `insert into agent_sessions (${cols.join(",")}) values (${cols.map((_, i) => `$${i + 1}`).join(",")}) returning *`,
    vals,
  );
  return r!;
}

export async function updateSession(id: string, patch: Partial<SessionRow>): Promise<void> {
  const cols = Object.keys(patch);
  if (!cols.length) return;
  await q(`update agent_sessions set ${cols.map((c, i) => `${c} = $${i + 2}`).join(", ")}, updated_at = now() where id = $1`, [id, ...Object.values(patch)]);
}

export async function sessionByReplyTag(userId: string, tag: string): Promise<SessionRow | undefined> {
  return one<SessionRow>("select * from agent_sessions where user_id = $1 and reply_tag = $2 and status <> 'terminated' order by created_at desc limit 1", [userId, tag]);
}

export async function latestChatSession(userId: string, maxAgeHours: number): Promise<SessionRow | undefined> {
  return one<SessionRow>(
    "select * from agent_sessions where user_id = $1 and channel = 'chat' and status <> 'terminated' and created_at > now() - ($2 || ' hours')::interval order by created_at desc limit 1",
    [userId, String(maxAgeHours)],
  );
}

export async function recentSessions(userId: string, limit = 50): Promise<SessionRow[]> {
  return q<SessionRow>("select * from agent_sessions where user_id = $1 order by created_at desc limit $2", [userId, limit]);
}

export async function recentProactiveSessions(userId: string, limit = 10): Promise<SessionRow[]> {
  return q<SessionRow>(
    "select * from agent_sessions where user_id = $1 and kind in ('review','weekly','followup','triage','digest','correspondence') and status <> 'running' order by created_at desc limit $2",
    [userId, limit],
  );
}

export async function expiredAskUserSessions(): Promise<SessionRow[]> {
  return q<SessionRow>("select * from agent_sessions where pending_kind = 'ask_user' and pending_deadline is not null and pending_deadline < now() and status <> 'terminated'");
}

export async function clearPending(id: string): Promise<void> {
  await updateSession(id, { pending_kind: null, pending_event_id: null, pending_deadline: null });
}

export async function hasSessionOfKindToday(userId: string, kind: string, day: string): Promise<boolean> {
  const r = await one<{ n: string }>("select count(*)::text as n from agent_sessions where user_id = $1 and kind = $2 and review_day = $3::date", [userId, kind, day]);
  return Number(r?.n ?? 0) > 0;
}

export async function hasDigestKey(userId: string, key: string): Promise<boolean> {
  const r = await one<{ n: string }>("select count(*)::text as n from agent_sessions where user_id = $1 and digest_key = $2", [userId, key]);
  return Number(r?.n ?? 0) > 0;
}
