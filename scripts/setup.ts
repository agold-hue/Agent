/**
 * One-time service setup (run again after editing the prompt, tools, or sandbox CLI):
 * creates or updates the shared environment and agent, uploads the sandbox browser CLI, and
 * prints the env vars. Per-customer resources (memory store, browser profile) are created on
 * first use by lib/tenant.ts.
 *
 *   ANTHROPIC_API_KEY=... npm run setup
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { AGENT_NAME, ENVIRONMENT_NAME, buildAgentParams, buildEnvironmentParams } from "../lib/agent-config.js";

const client = new Anthropic();

let envId: string | undefined;
for await (const e of client.beta.environments.list({ limit: 100 })) if (e.name === ENVIRONMENT_NAME) envId = e.id;
if (!envId) envId = (await client.beta.environments.create(buildEnvironmentParams())).id;
console.log(`ENVIRONMENT_ID=${envId}`);

let agentId: string | undefined;
for await (const a of client.beta.agents.list({ limit: 100 })) {
  if (a.name === AGENT_NAME) {
    const updated = await client.beta.agents.update(a.id, { version: a.version, ...buildAgentParams() });
    console.error(`updated agent ${a.id} to version ${updated.version}`);
    agentId = a.id;
  }
}
if (!agentId) agentId = (await client.beta.agents.create(buildAgentParams())).id;
console.log(`AGENT_ID=${agentId}`);

const file = await client.beta.files.upload({
  file: fs.createReadStream(path.join(process.cwd(), "sandbox", "browser.mjs")),
  purpose: "agent",
} as Parameters<typeof client.beta.files.upload>[0]);
console.log(`SANDBOX_TOOLS_FILE_ID=${file.id}`);
