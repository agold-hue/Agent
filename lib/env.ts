/** Service-level configuration. Everything per customer lives in the users table (see tenant.ts). */
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}
function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

/**
 * Minimal setup for a test deploy: DATABASE_URL, LLM_API_KEY, MASTER_KEY, SESSION_SECRET, CRON_SECRET and
 * DEV_LOGIN_CODE. Without Postmark, login uses the shared DEV_LOGIN_CODE and the email channel is off;
 * without Stripe everyone has access; without Browserbase the agent works from memory, search and mail.
 */
export const env = {
  appUrl: () => (opt("APP_URL") || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : req("APP_URL"))).replace(/\/$/, ""),
  /** The assistant's display name, shown in the chat header, the typing line and email subjects. Override with ASSISTANT_NAME. */
  assistantName: () => opt("ASSISTANT_NAME", "Pete"),
  devLoginCode: () => opt("DEV_LOGIN_CODE"),
  cronSecret: () => req("CRON_SECRET"),
  llm: {
    baseUrl: () => opt("LLM_BASE_URL", "https://openrouter.ai/api/v1"),
    apiKey: () => (process.env.LLM_PROVIDER === "gemini" ? req("GEMINI_API_KEY") : process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || req("LLM_API_KEY")),
  },
  browserbase: {
    configured: () => !!(process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID),
    apiKey: () => req("BROWSERBASE_API_KEY"),
    projectId: () => req("BROWSERBASE_PROJECT_ID"),
  },
  mail: {
    configured: () => !!(process.env.POSTMARK_SERVER_TOKEN && process.env.MAIL_DOMAIN && process.env.MAIL_FROM),
    domain: () => req("MAIL_DOMAIN"), // agents.example.com; each customer is <slug>@MAIL_DOMAIN
    from: () => req("MAIL_FROM"), // noreply@example.com for login codes
    postmarkToken: () => req("POSTMARK_SERVER_TOKEN"),
    inboundToken: () => req("INBOUND_WEBHOOK_TOKEN"),
  },
  stripe: {
    configured: () => !!(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID),
    secretKey: () => req("STRIPE_SECRET_KEY"),
    webhookSecret: () => req("STRIPE_WEBHOOK_SECRET"),
    priceId: () => req("STRIPE_PRICE_ID"),
    trialDays: () => Number(opt("STRIPE_TRIAL_DAYS", "7")),
  },
  google: {
    // Pasted values often carry a stray scheme, quotes or whitespace ("http://1234-abc.apps.googleusercontent.com").
    clientId: () => opt("GOOGLE_CLIENT_ID").trim().replace(/^["']|["']$/g, "").replace(/^https?:\/\//i, ""),
    clientSecret: () => opt("GOOGLE_CLIENT_SECRET").trim().replace(/^["']|["']$/g, ""),
  },
  plans: {
    /** Monthly model-spend cap per plan, USD (priced from the model price table). */
    monthlyCapUsd: (plan: string) => Number(opt(`PLAN_CAP_USD_${plan.toUpperCase()}`, opt("PLAN_CAP_USD_DEFAULT", "60"))),
    sessionBudgetUsd: () => Number(opt("SESSION_BUDGET_USD", "3")),
  },
};
