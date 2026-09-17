import { one, q } from "./db.js";
import type { Tenant } from "./tenant.js";

/**
 * Whether a morning review has anything to look at. Most days, for most customers, nothing is due,
 * no project is open and nothing failed; then the review is skipped without a model call. With Google
 * connected the calendar may hold something the database cannot see, so the review always runs.
 */
export async function hasReviewWork(t: Tenant): Promise<boolean> {
  if (t.googleRefreshToken) return true;
  if (await one("select 1 from tracked_items where user_id = $1 and status = 'open' and (due_at is null or due_at < now() + interval '8 days') limit 1", [t.id])) return true;
  if (await one("select 1 from followups where user_id = $1 and due < now() + interval '1 day' limit 1", [t.id])) return true;
  const files = await q<{ path: string; content: string; updated_at: Date }>(
    "select path, content, updated_at from memories where user_id = $1 and (path like 'projects/%' or path in ('watchlist.md', 'renewals.md', 'actions.md', 'topics.md', 'calendar.md', 'history/failures.md'))",
    [t.id],
  );
  for (const f of files) {
    if (f.path === "projects/README.md" || f.path === "projects/README-data-files.md") continue;
    if (f.path === "history/failures.md" && Date.now() - new Date(f.updated_at).getTime() > 7 * 86_400_000) continue;
    if (hasSubstance(f.content)) return true;
  }
  return false;
}

/** Whether a memory file holds anything beyond its template: a line that is not a heading, a hint or an unfilled blank. */
export function hasSubstance(content: string): boolean {
  return content.split("\n").some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("(") || line.startsWith("`") || line.includes("___")) return false;
    if (/^-\s*[^:]*:\s*$/.test(line)) return false;
    if (/^(Fill (this|in)|Facts the playbooks|Durable things|People and companies|Examples? of|One line per|Add |Keep )/i.test(line)) return false;
    return true;
  });
}

/** Once-a-day marks, so a skipped review is not re-evaluated every minute of its hour. */
export async function markedToday(userId: string, kind: string, day: string): Promise<boolean> {
  return !!(await one("select 1 from daily_marks where user_id = $1 and kind = $2 and day = $3::date", [userId, kind, day]));
}
export async function markToday(userId: string, kind: string, day: string): Promise<void> {
  await q("insert into daily_marks (user_id, kind, day) values ($1, $2, $3::date) on conflict do nothing", [userId, kind, day]);
}
