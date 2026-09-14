/** Apply db/schema.sql (idempotent). DATABASE_URL=... npm run db:migrate */
import fs from "node:fs";
import path from "node:path";
import { db } from "../lib/db.js";

const sql = fs.readFileSync(path.join(process.cwd(), "db", "schema.sql"), "utf8");
await db().query(sql);
console.log("schema applied");
await db().end();
