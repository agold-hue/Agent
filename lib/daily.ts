import { one, q } from "./db.js";
import type { Tenant } from "./tenant.js";

/** Structured items for the "what's today" screen, wins for the scoreboard, receipts for proof. */

export type ItemKind = "bill" | "package" | "appointment" | "reservation" | "school" | "reminder" | "other";

export interface TrackedItem {
  id: string;
  kind: ItemKind;
  title: string;
  due_at: Date | null;
  status: "open" | "done" | "cancelled";
  amount_cents: string | null;
  details: Record<string, unknown>;
  source: string | null;
  updated_at: Date;
}

export async function upsertItem(
  t: Tenant,
  it: { id?: string; kind: ItemKind; title: string; due_at?: Date | null; status?: "open" | "done" | "cancelled"; amount_cents?: number | null; details?: Record<string, unknown>; source?: string },
): Promise<TrackedItem> {
  if (it.id) {
    const r = await one<TrackedItem>(
      `update tracked_items set kind = $3, title = $4, due_at = coalesce($5, due_at), status = coalesce($6, status), amount_cents = coalesce($7, amount_cents),
         details = details || $8::jsonb, source = coalesce($9, source), updated_at = now() where id = $1 and user_id = $2 returning *`,
      [it.id, t.id, it.kind, it.title, it.due_at ?? null, it.status ?? null, it.amount_cents ?? null, JSON.stringify(it.details ?? {}), it.source ?? null],
    );
    if (r) return r;
  }
  // Same kind + same title while open counts as the same item (idempotent triage).
  const existing = await one<TrackedItem>("select * from tracked_items where user_id = $1 and kind = $2 and lower(title) = lower($3) and status = 'open'", [t.id, it.kind, it.title]);
  if (existing) return (await upsertItem(t, { ...it, id: existing.id }))!;
  const r = await one<TrackedItem>(
    "insert into tracked_items (user_id, kind, title, due_at, status, amount_cents, details, source) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *",
    [t.id, it.kind, it.title, it.due_at ?? null, it.status ?? "open", it.amount_cents ?? null, JSON.stringify(it.details ?? {}), it.source ?? null],
  );
  return r!;
}

export async function listItems(t: Tenant, opts: { kind?: string; status?: string; dueBefore?: Date; limit?: number } = {}): Promise<TrackedItem[]> {
  const where = ["user_id = $1"];
  const params: unknown[] = [t.id];
  if (opts.kind) {
    params.push(opts.kind);
    where.push(`kind = $${params.length}`);
  }
  if (opts.status) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  if (opts.dueBefore) {
    params.push(opts.dueBefore);
    where.push(`(due_at is null or due_at <= $${params.length})`);
  }
  params.push(opts.limit ?? 100);
  return q<TrackedItem>(`select * from tracked_items where ${where.join(" and ")} order by due_at nulls last, updated_at desc limit $${params.length}`, params);
}

export async function recordWin(t: Tenant, w: { kind: string; amountCents?: number; minutes?: number; label: string; sessionId?: string }): Promise<void> {
  await q("insert into wins (user_id, kind, amount_cents, minutes, label, session_id) values ($1,$2,$3,$4,$5,$6)", [t.id, w.kind, w.amountCents ?? 0, w.minutes ?? 0, w.label.slice(0, 300), w.sessionId ?? null]);
}

export interface Stats {
  month: { tasks_done: number; wins: number; saved_cents: number; minutes_saved: number };
  all_time: { tasks_done: number; saved_cents: number; minutes_saved: number };
  recent_wins: Array<{ kind: string; amount_cents: string; minutes: number; label: string; created_at: Date }>;
}

export async function stats(t: Tenant): Promise<Stats> {
  const m = await one<{ wins: string; saved: string; minutes: string }>(
    "select count(*)::text as wins, coalesce(sum(amount_cents),0)::text as saved, coalesce(sum(minutes),0)::text as minutes from wins where user_id = $1 and created_at >= date_trunc('month', now())",
    [t.id],
  );
  const a = await one<{ saved: string; minutes: string }>("select coalesce(sum(amount_cents),0)::text as saved, coalesce(sum(minutes),0)::text as minutes from wins where user_id = $1", [t.id]);
  const tm = await one<{ n: string }>("select count(*)::text as n from agent_sessions where user_id = $1 and kind in ('task','chat','correspondence') and status in ('idle','terminated') and last_report is not null and created_at >= date_trunc('month', now())", [t.id]);
  const ta = await one<{ n: string }>("select count(*)::text as n from agent_sessions where user_id = $1 and kind in ('task','chat','correspondence') and status in ('idle','terminated') and last_report is not null", [t.id]);
  const recent = await q<{ kind: string; amount_cents: string; minutes: number; label: string; created_at: Date }>("select kind, amount_cents::text, minutes, label, created_at from wins where user_id = $1 order by created_at desc limit 10", [t.id]);
  return {
    month: { tasks_done: Number(tm?.n ?? 0), wins: Number(m?.wins ?? 0), saved_cents: Number(m?.saved ?? 0), minutes_saved: Number(m?.minutes ?? 0) },
    all_time: { tasks_done: Number(ta?.n ?? 0), saved_cents: Number(a?.saved ?? 0), minutes_saved: Number(a?.minutes ?? 0) },
    recent_wins: recent,
  };
}

export async function addReceipt(t: Tenant, r: { sessionId?: string; title: string; confirmation?: string; details?: string; image?: Buffer }): Promise<string> {
  const row = await one<{ id: string }>("insert into receipts (user_id, session_id, title, confirmation, details, image) values ($1,$2,$3,$4,$5,$6) returning id", [
    t.id,
    r.sessionId ?? null,
    r.title.slice(0, 300),
    r.confirmation ?? null,
    r.details ?? null,
    r.image ?? null,
  ]);
  return row!.id;
}

export async function listReceipts(t: Tenant, limit = 30): Promise<Array<{ id: string; title: string; confirmation: string | null; details: string | null; has_image: boolean; created_at: Date }>> {
  return q("select id, title, confirmation, details, (image is not null) as has_image, created_at from receipts where user_id = $1 order by created_at desc limit $2", [t.id, limit]);
}

export async function receiptImage(t: Tenant, id: string): Promise<Buffer | null> {
  const r = await one<{ image: Buffer | null }>("select image from receipts where user_id = $1 and id = $2", [t.id, id]);
  return r?.image ?? null;
}
