function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function opt(name: string, fallback = ""): string {
  return process.env[name] ?? fallback;
}

export const env = {
  anthropic: {
    apiKey: () => req("ANTHROPIC_API_KEY"),
    webhookSigningKey: () => req("ANTHROPIC_WEBHOOK_SIGNING_KEY"),
    agentId: () => req("AGENT_ID"),
    environmentId: () => req("ENVIRONMENT_ID"),
    memoryStoreId: () => req("MEMORY_STORE_ID"),
    sandboxToolsFileId: () => opt("SANDBOX_TOOLS_FILE_ID"),
  },
  browserbase: {
    apiKey: () => req("BROWSERBASE_API_KEY"),
    projectId: () => req("BROWSERBASE_PROJECT_ID"),
    contextId: () => req("BROWSERBASE_CONTEXT_ID"),
  },
  onePassword: {
    token: () => req("OP_SERVICE_ACCOUNT_TOKEN"),
    vaultId: () => req("OP_VAULT_ID"),
  },
  gmail: {
    clientId: () => req("GMAIL_CLIENT_ID"),
    clientSecret: () => req("GMAIL_CLIENT_SECRET"),
    refreshToken: () => req("GMAIL_REFRESH_TOKEN"),
    agentEmail: () => req("AGENT_EMAIL"),
    ownerEmail: () => req("OWNER_EMAIL"),
    passphrase: () => opt("TASK_PASSPHRASE"),
  },
  policy: {
    autoApproveMaxUsd: () => Number(opt("AUTO_APPROVE_MAX_USD", "0")),
    autoApproveTypes: () =>
      opt("AUTO_APPROVE_TYPES")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean),
    askUserDeadlineHours: () => Number(opt("ASK_USER_DEADLINE_HOURS", "4")),
    sessionBudgetUsd: () => Number(opt("SESSION_BUDGET_USD", "15")),
  },
  cronSecret: () => req("CRON_SECRET"),
};
