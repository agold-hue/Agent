import type { OrgSettings } from "../orgs.js";

export type ApprovalKind = "purchase" | "payment" | "email" | "cancel" | "agreement" | "account" | "other";

/**
 * Whether a consequential step may go ahead without a human. The business sets which kinds are
 * pre-approved and a money ceiling; anything with money above the ceiling, or of a kind not listed,
 * waits for a person.
 */
export function autoApproved(settings: OrgSettings, kind: string, amountUsd?: number): boolean {
  const k = normalizeKind(kind);
  if (k === "email" && settings.auto_send_email) return true;
  const kinds = new Set((settings.auto_approve_kinds ?? []).map(normalizeKind));
  if (!kinds.has(k)) return false;
  const ceiling = settings.auto_approve_under_usd ?? 0;
  if (amountUsd === undefined || amountUsd === null || Number.isNaN(amountUsd)) return true;
  return amountUsd <= ceiling;
}

export function normalizeKind(kind: string): ApprovalKind {
  const k = (kind || "").toLowerCase().trim();
  if (/purchase|buy|order/.test(k)) return "purchase";
  if (/pay|bill|invoice/.test(k)) return "payment";
  if (/mail|message|send/.test(k)) return "email";
  if (/cancel|terminate/.test(k)) return "cancel";
  if (/agree|accept|terms|contract|sign/.test(k)) return "agreement";
  if (/account|setting|password|profile/.test(k)) return "account";
  return "other";
}

/** An email is internal when every recipient is one of the company's own addresses. */
export function isInternalEmail(recipients: string, ownAddresses: string[]): boolean {
  const own = new Set(ownAddresses.map((a) => a.toLowerCase().trim()).filter(Boolean));
  const ownDomains = new Set([...own].map((a) => a.split("@")[1]).filter(Boolean));
  const list = recipients
    .split(/[,;]/)
    .map((r) => (r.match(/<([^>]+)>/)?.[1] ?? r).trim().toLowerCase())
    .filter(Boolean);
  if (!list.length) return false;
  return list.every((r) => own.has(r) || ownDomains.has(r.split("@")[1]));
}
