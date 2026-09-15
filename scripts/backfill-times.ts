/** Recover message times from the conversation log for bubbles written before times were recorded. DATABASE_URL=... tsx scripts/backfill-times.ts */
import { backfillMessageTimes } from "../lib/backfill.js";
import { closeDb, ensureSchema } from "../lib/db.js";

await ensureSchema();
console.log(`stamped ${await backfillMessageTimes()} messages`);
await closeDb();
