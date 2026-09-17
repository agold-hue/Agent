import fs from "node:fs";
import { shutdownBrowsers } from "./browser/pool.js";
import { config } from "./config.js";
import { closeDb, migrate } from "./db.js";
import { startHttp } from "./http/server.js";
import { log } from "./log.js";
import { startScheduler, stopScheduler } from "./scheduler.js";
import { startWorkers, stopWorkers } from "./agent/worker.js";

/**
 * One process does everything: the web console and API, the worker pool that runs tasks, the
 * scheduler (timers, schedules, mailbox polling), and the browsers. Run it as a long-lived service
 * (Docker on Fly.io, Railway, Render, a VPS): it must not be a serverless function.
 */
async function main(): Promise<void> {
  for (const k of ["DATABASE_URL", "ANTHROPIC_API_KEY", "MASTER_KEY", "SESSION_SECRET"]) if (!process.env[k]) log.warn("boot", `${k} is not set`);
  fs.mkdirSync(config.dataDir(), { recursive: true });
  await migrate();
  const server = startHttp();
  await startWorkers();
  startScheduler();
  const shutdown = async (sig: string) => {
    log.info("boot", `shutting down (${sig})`);
    stopScheduler();
    server.close();
    await stopWorkers();
    await shutdownBrowsers();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => log.error("boot", "unhandled rejection", e));
}

main().catch((e) => {
  log.error("boot", "fatal", e);
  process.exit(1);
});
