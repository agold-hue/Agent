/** Service-level configuration. Everything per customer lives in the users table (see tenant.ts). */
function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}
function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  appUrl: () => req("APP_URL").replace(/\/$/, ""),
  cronSecret: () => req("CRON_SECRET"),
  anthropic: {
    apiKey: () => req("ANTHROPIC_API_KEY"),
    webhookSigningKey: () => req("ANTHROPIC_WEBHOOK_SIGNING_KEY"),
    agentId: () => req("AGENT_ID"),
    environmentId: () => req("ENVIRONMENT_ID"),
    sandboxToolsFileId: () => opt("SANDBOX_TOOLS_FILE_ID"),
  },
  browserbase: {
    apiKey: () => req("BROWSERBASE_API_KEY"),
    projectId: () => req("BROWSERBASE_PROJECT_ID"),
  },
  mail: {
    domain: () => req("MAIL_DOMAIN"), // agents.example.com; each customer is <slug>@MAIL_DOMAIN
    from: () => req("MAIL_FROM"), // noreply@example.com for login codes
    postmarkToken: () => req("POSTMARK_SERVER_TOKEN"),
    inboundToken: () => req("INBOUND_WEBHOOK_TOKEN"),
  },
  stripe: {
    secretKey: () => req("STRIPE_SECRET_KEY"),
    webhookSecret: () => req("STRIPE_WEBHOOK_SECRET"),
    priceId: () => req("STRIPE_PRICE_ID"),
    trialDays: () => Number(opt("STRIPE_TRIAL_DAYS", "7")),
  },
  google: {
    clientId: () => opt("GOOGLE_CLIENT_ID"),
    clientSecret: () => opt("GOOGLE_CLIENT_SECRET"),
  },
  plans: {
    /** Monthly Anthropic spend cap per plan, USD. */
    monthlyCapUsd: (plan: string) => Number(opt(`PLAN_CAP_USD_${plan.toUpperCase()}`, opt("PLAN_CAP_USD_DEFAULT", "60"))),
    sessionBudgetUsd: () => Number(opt("SESSION_BUDGET_USD", "10")),
  },
};
