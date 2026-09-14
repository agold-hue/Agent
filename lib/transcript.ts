import type { Tenant } from "./tenant.js";

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

export { appendTranscript } from "./memory.js";
