import { anthropic } from "./anthropic.js";
import { env } from "./env.js";

/**
 * Timers the agent sets for itself ("if the utility has not replied by 3pm, escalate to the city").
 * Stored as JSON in the memory store so they survive across sessions and are visible to the agent.
 * The inbox cron fires due ones as new sessions.
 */
export interface FollowUp {
  id: string;
  due: string; // ISO
  what: string; // instruction to the future session
  project?: string;
  created: string;
}

const PATH = "/followups.json";

async function locate() {
  const storeId = env.anthropic.memoryStoreId();
  for await (const item of anthropic().beta.memoryStores.memories.list(storeId, { path_prefix: "/", depth: 1, limit: 1000 })) {
    if (item.type === "memory" && item.path === PATH) return { storeId, id: item.id };
  }
  return { storeId, id: undefined as string | undefined };
}

export async function readFollowUps(): Promise<FollowUp[]> {
  const { storeId, id } = await locate();
  if (!id) return [];
  const mem = await anthropic().beta.memoryStores.memories.retrieve(id, { memory_store_id: storeId });
  try {
    const parsed = JSON.parse(mem.content ?? "[]");
    return Array.isArray(parsed) ? (parsed as FollowUp[]) : [];
  } catch {
    return [];
  }
}

async function writeFollowUps(list: FollowUp[]): Promise<void> {
  const { storeId, id } = await locate();
  const content = JSON.stringify(list, null, 1);
  if (id) await anthropic().beta.memoryStores.memories.update(id, { memory_store_id: storeId, content });
  else await anthropic().beta.memoryStores.memories.create(storeId, { path: PATH, content });
}

export async function addFollowUp(f: Omit<FollowUp, "id" | "created">): Promise<FollowUp> {
  const list = await readFollowUps();
  const item: FollowUp = { ...f, id: `fu_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, created: new Date().toISOString() };
  list.push(item);
  await writeFollowUps(list);
  return item;
}

export async function cancelFollowUps(pred: (f: FollowUp) => boolean): Promise<number> {
  const list = await readFollowUps();
  const keep = list.filter((f) => !pred(f));
  if (keep.length !== list.length) await writeFollowUps(keep);
  return list.length - keep.length;
}

/** Remove and return every follow-up whose time has come. */
export async function takeDueFollowUps(now = new Date()): Promise<FollowUp[]> {
  const list = await readFollowUps();
  const due = list.filter((f) => new Date(f.due).getTime() <= now.getTime());
  if (due.length) await writeFollowUps(list.filter((f) => !due.includes(f)));
  return due;
}
