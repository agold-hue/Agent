/** Time in the business's zone, as people write it: "Thu 2026-09-17 14:05 America/New_York". */
export function localStamp(tz: string, d = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(d);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${g("weekday")} ${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")} ${tz}`;
  } catch {
    return d.toISOString();
  }
}

/** Hour (0-23) in the zone, for quiet hours. */
export function localHour(tz: string, d = new Date()): number {
  try {
    return Number(new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "2-digit", hour12: false }).format(d).replace(/\D/g, "")) % 24;
  } catch {
    return d.getUTCHours();
  }
}

export function inQuietHours(spec: string | undefined, tz: string, d = new Date()): boolean {
  const m = (spec ?? "").match(/^(\d{1,2})-(\d{1,2})$/);
  if (!m) return false;
  const [from, to] = [Number(m[1]), Number(m[2])];
  const h = localHour(tz, d);
  return from < to ? h >= from && h < to : h >= from || h < to;
}

/** Parse "in 20 minutes", "2h", "tomorrow 9am", or an ISO/RFC date into a Date. Undefined when unreadable. */
export function parseWhen(input: string, now = new Date()): Date | undefined {
  const s = input.trim().toLowerCase();
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^(?:in\s+)?(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/))) {
    const n = Number(m[1]);
    const unit = m[2][0];
    const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    return new Date(now.getTime() + ms);
  }
  const d = new Date(input);
  if (!Number.isNaN(d.getTime())) return d;
  return undefined;
}
