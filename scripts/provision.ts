/**
 * One-time setup. Creates (or reuses by name) the environment, agent, memory store and hosted
 * browser profile, uploads the sandbox browser CLI, and prints the env vars to add to Vercel.
 *
 *   ANTHROPIC_API_KEY=... BROWSERBASE_API_KEY=... BROWSERBASE_PROJECT_ID=... npm run provision
 */
import fs from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import Browserbase from "@browserbasehq/sdk";
import { AGENT_NAME, ENVIRONMENT_NAME, MEMORY_STORE_NAME, buildAgentParams, buildEnvironmentParams } from "../lib/agent-config.js";

const client = new Anthropic();
const out: Record<string, string> = {};

async function environment(): Promise<string> {
  for await (const e of client.beta.environments.list({ limit: 100 })) {
    if (e.name === ENVIRONMENT_NAME) return e.id;
  }
  const created = await client.beta.environments.create(buildEnvironmentParams());
  return created.id;
}

async function agent(): Promise<string> {
  for await (const a of client.beta.agents.list({ limit: 100 })) {
    if (a.name === AGENT_NAME) {
      const updated = await client.beta.agents.update(a.id, { version: a.version, ...buildAgentParams() });
      console.log(`updated agent ${a.id} to version ${updated.version}`);
      return a.id;
    }
  }
  const created = await client.beta.agents.create(buildAgentParams());
  return created.id;
}

async function memoryStore(): Promise<string> {
  let id: string | undefined;
  for await (const s of client.beta.memoryStores.list({ limit: 100 })) {
    if (s.name === MEMORY_STORE_NAME) id = s.id;
  }
  if (!id) {
    const created = await client.beta.memoryStores.create({
      name: MEMORY_STORE_NAME,
      description:
        "The user's standing instructions, inferred preferences, per-site notes and task history. " +
        "Read standing_instructions.md before every task; write sites/<domain>.md and history/ after.",
    });
    id = created.id;
  }
  const seedDir = path.join(process.cwd(), "agent", "memory-seed");
  for (const file of fs.readdirSync(seedDir, { recursive: true, encoding: "utf8" })) {
    const abs = path.join(seedDir, file);
    if (fs.statSync(abs).isDirectory()) continue;
    const content = fs.readFileSync(abs, "utf8");
    const memPath = "/" + file.split(path.sep).join("/");
    try {
      await client.beta.memoryStores.memories.create(id, { path: memPath, content });
      console.log(`seeded ${memPath}`);
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status !== 409) throw err; // 409 = already exists; keep the user's edits
    }
  }
  return id;
}

async function sandboxTools(): Promise<string> {
  const file = await client.beta.files.upload({
    file: fs.createReadStream(path.join(process.cwd(), "sandbox", "browser.mjs")),
    purpose: "agent",
  } as Parameters<typeof client.beta.files.upload>[0]);
  return file.id;
}

async function browserContext(): Promise<string> {
  if (process.env.BROWSERBASE_CONTEXT_ID) return process.env.BROWSERBASE_CONTEXT_ID;
  const bb = new Browserbase({ apiKey: process.env.BROWSERBASE_API_KEY });
  const ctx = await bb.contexts.create({ projectId: process.env.BROWSERBASE_PROJECT_ID!, name: "personal-web-agent" });
  return ctx.id;
}

out.ENVIRONMENT_ID = await environment();
console.log(`environment ${out.ENVIRONMENT_ID}`);
out.AGENT_ID = await agent();
console.log(`agent ${out.AGENT_ID}`);
out.MEMORY_STORE_ID = await memoryStore();
console.log(`memory store ${out.MEMORY_STORE_ID}`);
out.SANDBOX_TOOLS_FILE_ID = await sandboxTools();
console.log(`sandbox tools file ${out.SANDBOX_TOOLS_FILE_ID}`);
if (process.env.BROWSERBASE_API_KEY && process.env.BROWSERBASE_PROJECT_ID) {
  out.BROWSERBASE_CONTEXT_ID = await browserContext();
  console.log(`browserbase context ${out.BROWSERBASE_CONTEXT_ID}`);
} else {
  console.log("BROWSERBASE_API_KEY / BROWSERBASE_PROJECT_ID not set; skipping browser profile");
}

fs.writeFileSync("provision-output.json", JSON.stringify(out, null, 2));
console.log("\nAdd these to Vercel (also saved to provision-output.json):\n");
for (const [k, v] of Object.entries(out)) console.log(`${k}=${v}`);
