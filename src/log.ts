/** One-line structured logs: `[scope] message key=value`. Stdout for info, stderr for errors. */
const fmt = (extra?: Record<string, unknown>) =>
  extra
    ? " " +
      Object.entries(extra)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v)}`)
        .join(" ")
    : "";

export const log = {
  info: (scope: string, msg: string, extra?: Record<string, unknown>) => console.log(`[${scope}] ${msg}${fmt(extra)}`),
  warn: (scope: string, msg: string, extra?: Record<string, unknown>) => console.warn(`[${scope}] ${msg}${fmt(extra)}`),
  error: (scope: string, msg: string, err?: unknown, extra?: Record<string, unknown>) =>
    console.error(`[${scope}] ${msg}${fmt(extra)}${err ? ` error=${JSON.stringify(err instanceof Error ? err.message : String(err))}` : ""}`),
};

export const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));
