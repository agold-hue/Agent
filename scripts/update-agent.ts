/**
 * Push a new agent version after editing agent/system-prompt.md or the tool list.
 * Re-uploads sandbox/browser.mjs too and prints the new file id if it changed.
 *
 *   ANTHROPIC_API_KEY=... AGENT_ID=... npm run update-agent
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { buildAgentParams } from "../lib/agent-config.js";

const client = new Anthropic();
const agentId = process.env.AGENT_ID;
if (!agentId) throw new Error("AGENT_ID is required");

const current = await client.beta.agents.retrieve(agentId);
const updated = await client.beta.agents.update(agentId, { version: current.version, ...buildAgentParams() });
console.log(`agent ${agentId}: version ${current.version} -> ${updated.version}`);

const file = await client.beta.files.upload({
  file: fs.createReadStream(path.join(process.cwd(), "sandbox", "browser.mjs")),
  purpose: "agent",
} as Parameters<typeof client.beta.files.upload>[0]);
console.log(`SANDBOX_TOOLS_FILE_ID=${file.id}  (update this in Vercel if the CLI changed)`);
