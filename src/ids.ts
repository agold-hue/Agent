import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";
/** Short, sortable-ish ids: a time prefix plus random tail. Safe in URLs and logs. */
export function id(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Array.from(randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join("");
  return `${prefix}_${t}${r}`;
}
