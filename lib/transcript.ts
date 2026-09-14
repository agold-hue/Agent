import { anthropic } from "./anthropic.js";
import { env } from "./env.js";

const MAX_BYTES = 95_000; // memory content cap is 100 kB; roll to a new file before that

export type Channel = "chat" | "email";

export function ownerTimezone(): string {
  return process.env.OWNER_TIMEZONE || "America/New_York";
}

/** "2026-09-14 Mon 10:32 America/New_York" in the owner's time zone. */
export function stamp(date = new Date()): string {
  const tz = ownerTimezone();
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

export function dayKey(date = new Date()): string {
  return stamp(date).slice(0, 10);
}

/** Prefix a user message with the current time so the agent can resolve "next Wednesday". */
export function stampMessage(text: string, channel: Channel): string {
  return `[${stamp()} via ${channel}]\n${text}`;
}

async function findByPath(storeId: string, path: string) {
  const dir = path.slice(0, path.lastIndexOf("/") + 1);
  for await (const item of anthropic().beta.memoryStores.memories.list(storeId, { path_prefix: dir, limit: 1000 })) {
    if (item.type === "memory" && item.path === path) return item;
  }
  return undefined;
}

/**
 * Append one line to the durable conversation log in the memory store. This is what lets the
 * agent grep for anything the owner ever said, across chat and email, across sessions.
 */
export async function appendTranscript(entry: { channel: Channel; role: "user" | "agent"; text: string }): Promise<void> {
  const storeId = env.anthropic.memoryStoreId();
  const text = entry.text.trim();
  if (!text) return;
  const line = `\n### ${stamp()} · ${entry.role === "user" ? "Owner" : "Agent"} (${entry.channel})\n${text}\n`;

  for (let part = 1; part < 20; part++) {
    const path = `/conversations/${dayKey()}${part > 1 ? `-${part}` : ""}.md`;
    const existing = await findByPath(storeId, path);
    if (!existing) {
      await anthropic().beta.memoryStores.memories.create(storeId, { path, content: `# Conversation ${dayKey()}\n${line}` });
      return;
    }
    if (existing.content_size_bytes + Buffer.byteLength(line) > MAX_BYTES) continue; // roll over
    const full = await anthropic().beta.memoryStores.memories.retrieve(existing.id, { memory_store_id: storeId });
    try {
      await anthropic().beta.memoryStores.memories.update(existing.id, {
        memory_store_id: storeId,
        content: (full.content ?? "") + line,
        precondition: { type: "content_sha256", content_sha256: full.content_sha256 },
      });
      return;
    } catch (err) {
      // Concurrent writer (the agent, or another route): re-read once and retry.
      const status = (err as { status?: number }).status;
      if (status !== 409) throw err;
      const again = await anthropic().beta.memoryStores.memories.retrieve(existing.id, { memory_store_id: storeId });
      await anthropic().beta.memoryStores.memories.update(existing.id, {
        memory_store_id: storeId,
        content: (again.content ?? "") + line,
      });
      return;
    }
  }
}
