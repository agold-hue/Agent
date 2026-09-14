import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

export const AGENT_NAME = "Personal Web Agent";
export const ENVIRONMENT_NAME = "personal-web-agent-env";
export const MEMORY_STORE_NAME = "personal-web-agent-memory";

/** Paths inside the sandbox. Keep in sync with the system prompt. */
export const SANDBOX_TOOLS_MOUNT = "/workspace/tools/browser.mjs";
export const MEMORY_MOUNT = `/mnt/memory/${MEMORY_STORE_NAME}`;

export function loadSystemPrompt(): string {
  const p = path.join(process.cwd(), "agent", "system-prompt.md");
  return fs
    .readFileSync(p, "utf8")
    .replaceAll("{{MEMORY_MOUNT}}", MEMORY_MOUNT)
    .replaceAll("{{SANDBOX_TOOLS_MOUNT}}", SANDBOX_TOOLS_MOUNT);
}

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: "object" as const,
  properties,
  required,
  additionalProperties: false,
});

/**
 * Custom tools run on our side (the Vercel webhook route), never in the sandbox.
 * The sandbox never sees the user's passwords, the Browserbase key, or the approval
 * decision, so a hostile web page cannot extract or bypass them.
 */
export const customTools: Anthropic.Beta.Agents.AgentCreateParams["tools"] = [
  {
    type: "custom",
    name: "browser_session",
    description:
      "Start (or reuse) the user's hosted browser for this task. Returns a CDP URL to pass to " +
      "`node " + SANDBOX_TOOLS_MOUNT + " open <cdp_url>` plus a live-view URL the user can open " +
      "to watch or take over. The browser keeps the user's own cookies and logins between tasks. Call once per task.",
    input_schema: obj({
      reason: { type: "string", description: "One line on what you will do in the browser." },
    }),
  },
  {
    type: "custom",
    name: "login",
    description:
      "Sign the current browser page in to a website with the user's own saved credentials from their " +
      "password manager. Use when a site shows a sign-in page. Credentials never pass through you: the host " +
      "fills the form and handles authenticator or email codes. Returns logged_in, no_credentials (offer " +
      "sign-up) or needs_user (tell the user and include the live-view URL).",
    input_schema: obj(
      {
        domain: { type: "string", description: "Registrable domain of the site, e.g. example.com" },
        account_hint: {
          type: "string",
          description: "Optional username/email hint if the user has several accounts on this site.",
        },
      },
      ["domain"],
    ),
  },
  {
    type: "custom",
    name: "save_login",
    description:
      "Store the credentials of a NEW account you just created for the user in their password manager. " +
      "Only for accounts created in this task after an approved signup checkpoint. Use a strong random password.",
    input_schema: obj(
      {
        domain: { type: "string" },
        username: { type: "string" },
        password: { type: "string" },
        notes: { type: "string", description: "What the account is for, in one line." },
      },
      ["domain", "username", "password"],
    ),
  },
  {
    type: "custom",
    name: "get_email_code",
    description:
      "Fetch a verification code or confirmation link that a website just emailed to the user (sign-up " +
      "confirmations, one-time codes). Returns the most recent matching codes/links from the last few minutes.",
    input_schema: obj({
      sender_hint: { type: "string", description: "Domain or name of the site sending the code." },
      since_minutes: { type: "number", description: "How far back to look. Default 10." },
    }),
  },
  {
    type: "custom",
    name: "send_email",
    description:
      "Send an email from the user's assistant mailbox to anyone (a broker, a realtor, a vendor), signed as the " +
      "user's assistant. Replies come back to you automatically as new tasks. Attach files you wrote to " +
      "/mnt/session/outputs/ by filename. The host applies the user's approval rules and holds the email for the " +
      "user's yes when required, so write the final version, not a draft. Use mode 'send_to_owner' to email the " +
      "user something for review instead of an outsider.",
    input_schema: obj(
      {
        to: { type: "string", description: "Recipient address(es), comma separated. Use a contact from contacts.md." },
        cc: { type: "string" },
        subject: { type: "string" },
        body: { type: "string", description: "Plain text. Courteous, specific, signed with the user's name and 'via assistant'." },
        attachments: { type: "array", items: { type: "string" }, description: "Filenames under /mnt/session/outputs/ to attach." },
        mode: { type: "string", enum: ["send", "send_to_owner"], description: "Default 'send'." },
        purpose: { type: "string", description: "One line on why this email is being sent, shown to the user for approval." },
      },
      ["to", "subject", "body"],
    ),
  },
  {
    type: "custom",
    name: "checkpoint",
    description:
      "REQUIRED before any big move: paying, ordering, sending a message or post as the user, deleting, changing " +
      "account settings, creating an account, accepting an offer or settlement (a partial refund, a credit, a " +
      "replacement instead of a refund), agreeing to return an item, filing a claim or dispute, cancelling " +
      "anything. Describe exactly what is about to happen, the options you considered, and why you recommend this " +
      "one. The host either auto-approves under the user's standing rules or asks the user. Returns APPROVED or " +
      "DENIED with a reason. Never perform the action without APPROVED.",
    input_schema: obj(
      {
        action_type: {
          type: "string",
          enum: ["purchase", "payment", "message", "account_change", "delete", "signup", "agreement", "dispute", "cancellation", "other"],
        },
        summary: { type: "string", description: "One sentence, e.g. 'Accept $42 partial refund on the dish set'." },
        amount_usd: { type: "number", description: "Total money that will move, if any." },
        merchant: { type: "string", description: "Site, payee or counterparty." },
        details: {
          type: "string",
          description: "Items, totals, payment method, shipping address, recipient, the offer on the table: whatever the user needs to judge it.",
        },
        options_considered: {
          type: "array",
          items: { type: "string" },
          description: "The other routes available right now and why you are not recommending them.",
        },
        recommendation: { type: "string", description: "What you would do and why, in one or two sentences." },
      },
      ["action_type", "summary", "details"],
    ),
  },
  {
    type: "custom",
    name: "ask_user",
    description:
      "Ask the user clarifying questions by email. Use AT MOST ONCE per task and only when the standing " +
      "instructions and memory cannot resolve the ambiguity. Batch every question into this one call and give the " +
      "default you will assume for each. If the user does not answer before the deadline you get NO_REPLY and must " +
      "proceed with your defaults.",
    input_schema: obj(
      {
        questions: {
          type: "array",
          items: obj(
            {
              question: { type: "string" },
              default: { type: "string", description: "What you will do if the user does not answer." },
            },
            ["question", "default"],
          ),
        },
      },
      ["questions"],
    ),
  },
];

export function buildAgentParams(): Anthropic.Beta.Agents.AgentCreateParams {
  return {
    name: AGENT_NAME,
    description: "Email-triggered personal assistant that completes tasks on websites for its owner.",
    model: { id: "claude-opus-5", effort: "high" },
    system: loadSystemPrompt(),
    tools: [
      {
        type: "agent_toolset_20260401",
        default_config: { enabled: true, permission_policy: { type: "always_allow" } },
      },
      ...(customTools ?? []),
    ],
  };
}

export function buildEnvironmentParams(): Anthropic.Beta.Environments.EnvironmentCreateParams {
  return {
    name: ENVIRONMENT_NAME,
    config: {
      type: "cloud",
      networking: { type: "unrestricted" },
    },
  };
}
