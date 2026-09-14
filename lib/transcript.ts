import { anthropic } from "./anthropic.js";
import type { Tenant } from "./tenant.js";

const MAX_BYTES = 95_000;

export type Channel = "chat" | "email";

/** "2026-09-14 Mon 10:32 America/New_York" in the tenant's time zone. */
export function stamp(tz: string, date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("weekday")} ${g("hour")}:${g("minute")} ${tz}`;
}

export function dayKey(tz: string, date = new Date()): string {
  return stamp(tz, date).slice(0, 10);
}

export function localClock(tz: string, date = new Date()): { day: string; weekday: string; h: number; m: number } {
  const s = stamp(tz, date);
  return { day: s.slice(0, 10), weekday: s.slice(11, 14), h: Number(s.slice(15, 17)), m: Number(s.slice(18, 20)) };
}

export function stampMessage(t: Tenant, text: string, channel: Channel): string {
  return `[${stamp(t.timezone)} via ${channel}]\n${text}`;
}

async function findByPath(storeId: string, path: string) {
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  for await (const item of anthropic().beta.memoryStores.memories.list(storeId, { path_prefix: dir, limit: 1000 })) {
    if (item.type === "memory" && item.path === path) return item;
  }
  return undefined;
}

/** Append one entry to the tenant's durable conversation log (conversations/YYYY-MM-DD.md). */
export async function appendTranscript(t: Tenant, entry: { channel: Channel; role: "user" | "agent"; text: string }): Promise<void> {
  const storeId = t.memoryStoreId;
  if (!storeId) return;
  const text = entry.text.trim();
  if (!text) return;
  const day = dayKey(t.timezone);
  const line = `\n### ${stamp(t.timezone)} · ${entry.role === "user" ? "Owner" : "Agent"} (${entry.channel})\n${text}\n`;
  for (let part = 1; part < 20; part++) {
    const path = `/conversations/${day}${part > 1 ? `-${part}` : ""}.md`;
    const existing = await findByPath(storeId, path);
    if (!existing) {
      await anthropic().beta.memoryStores.memories.create(storeId, { path, content: `# Conversation ${day}\n${line}` });
      return;
    }
    if (existing.content_size_bytes + Buffer.byteLength(line) > MAX_BYTES) continue;
    const full = await anthropic().beta.memoryStores.memories.retrieve(existing.id, { memory_store_id: storeId });
    try {
      await anthropic().beta.memoryStores.memories.update(existing.id, {
        memory_store_id: storeId,
        content: (full.content ?? "") + line,
        precondition: { type: "content_sha256", content_sha256: full.content_sha256 },
      });
      return;
    } catch (err) {
      if ((err as { status?: number }).status !== 409) throw err;
      const again = await anthropic().beta.memoryStores.memories.retrieve(existing.id, { memory_store_id: storeId });
      await anthropic().beta.memoryStores.memories.update(existing.id, { memory_store_id: storeId, content: (again.content ?? "") + line });
      return;
    }
  }
}
