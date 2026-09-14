/** Apply db/schema.sql (idempotent). DATABASE_URL=... npm run db:migrate */
import fs from "node:fs";
import path from "node:path";
import { closeDb, exec } from "../lib/db.js";

await exec(fs.readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8"));
console.log("schema applied");
await closeDb();
