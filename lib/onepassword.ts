import { createClient, ItemCategory, ItemFieldType, AutofillBehavior, type Client, type ItemField } from "@1password/sdk";
import { env } from "./env.js";

let client: Client | undefined;
async function op(): Promise<Client> {
  if (!client) {
    client = await createClient({
      auth: env.onePassword.token(),
      integrationName: "Personal Web Agent",
      integrationVersion: "v0.1.0",
    });
  }
  return client;
}

export interface SiteCredential {
  itemId: string;
  title: string;
  username: string;
  password: string;
  /** Current TOTP code if the item has an authenticator field. */
  totp?: string;
}

export function registrableDomain(input: string): string {
  let host = input.trim().toLowerCase();
  try {
    if (/^https?:\/\//.test(host)) host = new URL(host).hostname;
  } catch {
    /* keep as-is */
  }
  host = host.replace(/^www\./, "").split("/")[0];
  const parts = host.split(".");
  // Good enough for the common cases; multi-part public suffixes (co.uk) keep three labels.
  if (parts.length > 2 && /^(co|com|org|net|gov|ac)$/.test(parts[parts.length - 2])) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

function hostMatches(itemUrl: string, domain: string): boolean {
  try {
    const host = new URL(itemUrl.startsWith("http") ? itemUrl : `https://${itemUrl}`).hostname
      .toLowerCase()
      .replace(/^www\./, "");
    return host === domain || host.endsWith(`.${domain}`) || domain.endsWith(`.${host}`);
  } catch {
    return itemUrl.toLowerCase().includes(domain);
  }
}

function fieldValue(fields: ItemField[], pred: (f: ItemField) => boolean): string | undefined {
  return fields.find(pred)?.value;
}

/**
 * Look up the user's saved login for a domain. Returns undefined when none exists.
 * The secret values are only ever used inside the host-side login flow.
 */
export async function findCredential(domain: string, accountHint?: string): Promise<SiteCredential | undefined> {
  const c = await op();
  const vaultId = env.onePassword.vaultId();
  const overviews = await c.items.list(vaultId, { type: "ByState", content: { active: true, archived: false } });
  const candidates = overviews.filter(
    (o) => o.category === ItemCategory.Login && o.websites.some((w) => hostMatches(w.url, domain)),
  );
  if (candidates.length === 0) return undefined;

  const items = await Promise.all(candidates.map((o) => c.items.get(vaultId, o.id)));
  const scored = items
    .map((item) => {
      const username =
        fieldValue(item.fields, (f) => f.id === "username") ??
        fieldValue(item.fields, (f) => f.fieldType === ItemFieldType.Email) ??
        fieldValue(item.fields, (f) => /user|email|login/i.test(f.title)) ??
        "";
      const password =
        fieldValue(item.fields, (f) => f.id === "password") ??
        fieldValue(item.fields, (f) => f.fieldType === ItemFieldType.Concealed) ??
        "";
      const totpField = item.fields.find((f) => f.fieldType === ItemFieldType.Totp);
      const totp = totpField?.details?.type === "Otp" ? totpField.details.content.code : undefined;
      let score = 0;
      if (accountHint && username.toLowerCase().includes(accountHint.toLowerCase())) score += 10;
      if (item.websites.some((w) => hostMatches(w.url, domain) && w.autofillBehavior !== AutofillBehavior.Never)) score += 1;
      return { item, username, password, totp, score };
    })
    .filter((x) => x.password)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return undefined;
  return { itemId: best.item.id, title: best.item.title, username: best.username, password: best.password, totp: best.totp };
}

/** Save credentials for an account the agent created. */
export async function saveCredential(opts: { domain: string; username: string; password: string; notes?: string }) {
  const c = await op();
  const item = await c.items.create({
    category: ItemCategory.Login,
    vaultId: env.onePassword.vaultId(),
    title: opts.domain,
    fields: [
      { id: "username", title: "username", fieldType: ItemFieldType.Text, value: opts.username },
      { id: "password", title: "password", fieldType: ItemFieldType.Concealed, value: opts.password },
    ],
    websites: [{ url: `https://${opts.domain}`, label: "website", autofillBehavior: AutofillBehavior.AnywhereOnWebsite }],
    notes: opts.notes ? `${opts.notes}\n\nCreated by Personal Web Agent.` : "Created by Personal Web Agent.",
    tags: ["agent-created"],
  });
  return item.id;
}
