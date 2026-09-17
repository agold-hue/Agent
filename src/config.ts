/**
 * All configuration comes from the environment. Nothing here talks to the network, so it is safe
 * to import anywhere. Values are read lazily so tests can set process.env first.
 */
import path from "node:path";

const str = (k: string, d = "") => (process.env[k] ?? d).trim();
const num = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) && process.env[k] !== undefined && process.env[k] !== "" ? v : d;
};
const bool = (k: string, d: boolean) => {
  const v = str(k).toLowerCase();
  if (!v) return d;
  return v === "1" || v === "true" || v === "on" || v === "yes";
};

export const config = {
  appUrl: () => str("APP_URL", `http://localhost:${num("PORT", 3000)}`).replace(/\/+$/, ""),
  port: () => num("PORT", 3000),
  dataDir: () => path.resolve(str("DATA_DIR", "./data")),
  databaseUrl: () => str("DATABASE_URL"),
  masterKey: () => str("MASTER_KEY"),
  sessionSecret: () => str("SESSION_SECRET"),
  devLoginCode: () => str("DEV_LOGIN_CODE"),

  llm: {
    apiKey: () => str("ANTHROPIC_API_KEY"),
    /** The model that runs tasks. Opus 5 is the default; Sonnet 5 is the cheaper option. */
    taskModel: () => str("MODEL_TASK", "claude-opus-5"),
    /** The model for bulk classification (mail triage) and short summaries. */
    fastModel: () => str("MODEL_FAST", "claude-haiku-4-5"),
    effort: () => str("MODEL_EFFORT", "high") as "low" | "medium" | "high" | "xhigh" | "max",
    maxTokens: () => num("MODEL_MAX_TOKENS", 32000),
    fallbacks: () => bool("LLM_FALLBACKS", true),
    /** Client-side pruning: when the conversation passes this many estimated tokens, old tool results are stubbed. */
    pruneAtTokens: () => num("CONTEXT_PRUNE_TOKENS", 120_000),
    keepRecentToolResults: () => num("CONTEXT_KEEP_RECENT", 12),
  },

  tasks: {
    maxSteps: () => num("TASK_MAX_STEPS", 150),
    maxMinutes: () => num("TASK_MAX_MINUTES", 45),
    maxUsd: () => num("TASK_MAX_USD", 10),
    concurrency: () => num("WORKER_CONCURRENCY", 4),
    perOrg: () => num("WORKER_PER_ORG", 3),
    staleAfterSeconds: () => num("TASK_STALE_SECONDS", 180),
  },

  browser: {
    /** Optional CDP websocket (a hosted stealth browser). Empty means a local Chromium with a persistent profile per business. */
    wsEndpoint: () => str("BROWSER_WS_ENDPOINT"),
    headless: () => bool("BROWSER_HEADLESS", true),
    idleMinutes: () => num("BROWSER_IDLE_MINUTES", 10),
    width: () => num("BROWSER_WIDTH", 1280),
    height: () => num("BROWSER_HEIGHT", 900),
    snapshotMaxChars: () => num("SNAPSHOT_MAX_CHARS", 24_000),
    settleMs: () => num("PAGE_SETTLE_MS", 6000),
  },

  search: {
    serperKey: () => str("SERPER_API_KEY"),
  },

  mail: {
    // Platform mailbox: login codes, notifications, and the default sender when a business has no mailbox of its own.
    smtpHost: () => str("SMTP_HOST"),
    smtpPort: () => num("SMTP_PORT", 587),
    smtpUser: () => str("SMTP_USER"),
    smtpPass: () => str("SMTP_PASS"),
    from: () => str("MAIL_FROM", str("SMTP_USER")),
    configured: () => !!str("SMTP_HOST"),
    pollSeconds: () => num("MAIL_POLL_SECONDS", 60),
  },

  stripe: {
    secretKey: () => str("STRIPE_SECRET_KEY"),
    webhookSecret: () => str("STRIPE_WEBHOOK_SECRET"),
    priceId: () => str("STRIPE_PRICE_ID"),
    trialDays: () => num("STRIPE_TRIAL_DAYS", 7),
    configured: () => !!str("STRIPE_SECRET_KEY") && !!str("STRIPE_PRICE_ID"),
  },

  push: {
    publicKey: () => str("VAPID_PUBLIC_KEY"),
    privateKey: () => str("VAPID_PRIVATE_KEY"),
    subject: () => str("VAPID_SUBJECT", "mailto:admin@example.com"),
    configured: () => !!str("VAPID_PUBLIC_KEY") && !!str("VAPID_PRIVATE_KEY"),
  },

  plans: {
    monthlyCapUsd: (plan: string) => num(`PLAN_CAP_USD_${plan.toUpperCase()}`, num("PLAN_CAP_USD_DEFAULT", 100)),
  },
};
