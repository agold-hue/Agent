/**
 * Package tracking through the carriers' own APIs (USPS, UPS, FedEx) instead of a browser session on
 * the carrier's site. Each carrier needs its own client id and secret (free developer accounts); a
 * carrier without keys is reported as such so the agent falls back to the inbox or the browser.
 */
export type Carrier = "usps" | "ups" | "fedex";

export interface TrackResult {
  carrier: Carrier;
  number: string;
  status: string;
  expected?: string;
  delivered?: boolean;
  events: Array<{ at: string; where?: string; what: string }>;
}

export function detectCarrier(raw: string): Carrier | undefined {
  const n = raw.replace(/\s+/g, "").toUpperCase();
  if (/^1Z[0-9A-Z]{16}$/.test(n) || /^T\d{10}$/.test(n)) return "ups";
  if (/^(9[2-5]\d{18,24}|\d{20,22}|[A-Z]{2}\d{9}US|420\d{5,9}9[2-5]\d{18,24})$/.test(n)) return "usps";
  if (/^(\d{12}|\d{15}|\d{20}|96\d{20}|\d{34})$/.test(n)) return "fedex";
  return undefined;
}

const configured = (c: Carrier) => ({ usps: !!(process.env.USPS_CLIENT_ID && process.env.USPS_CLIENT_SECRET), ups: !!(process.env.UPS_CLIENT_ID && process.env.UPS_CLIENT_SECRET), fedex: !!(process.env.FEDEX_CLIENT_ID && process.env.FEDEX_CLIENT_SECRET) })[c];
export function trackingConfigured(): Carrier[] {
  return (["usps", "ups", "fedex"] as Carrier[]).filter(configured);
}

const tokens = new Map<Carrier, { token: string; until: number }>();
async function token(c: Carrier): Promise<string> {
  const cached = tokens.get(c);
  if (cached && cached.until > Date.now() + 60_000) return cached.token;
  let res: Response;
  if (c === "usps") {
    res = await fetch("https://apis.usps.com/oauth2/v3/token", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_id: process.env.USPS_CLIENT_ID, client_secret: process.env.USPS_CLIENT_SECRET, grant_type: "client_credentials" }), signal: AbortSignal.timeout(15_000) });
  } else if (c === "ups") {
    res = await fetch("https://onlinetools.ups.com/security/v1/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Basic ${Buffer.from(`${process.env.UPS_CLIENT_ID}:${process.env.UPS_CLIENT_SECRET}`).toString("base64")}` }, body: "grant_type=client_credentials", signal: AbortSignal.timeout(15_000) });
  } else {
    res = await fetch("https://apis.fedex.com/oauth/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "client_credentials", client_id: process.env.FEDEX_CLIENT_ID!, client_secret: process.env.FEDEX_CLIENT_SECRET! }), signal: AbortSignal.timeout(15_000) });
  }
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number | string; error_description?: string; error?: string };
  if (!res.ok || !data.access_token) throw new Error(`${c.toUpperCase()} token: ${res.status} ${data.error_description ?? data.error ?? ""}`.trim());
  tokens.set(c, { token: data.access_token, until: Date.now() + Number(data.expires_in ?? 3600) * 1000 });
  return data.access_token;
}

const iso = (s: string | undefined) => {
  if (!s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString().slice(0, 16).replace("T", " ");
};

export async function track(numberRaw: string, carrierArg?: string): Promise<TrackResult> {
  const number = numberRaw.replace(/\s+/g, "");
  const carrier = (carrierArg?.toLowerCase() as Carrier | undefined) && ["usps", "ups", "fedex"].includes(carrierArg!.toLowerCase()) ? (carrierArg!.toLowerCase() as Carrier) : detectCarrier(number);
  if (!carrier) throw new Error(`Could not tell the carrier from "${number}"; pass carrier (usps, ups or fedex).`);
  if (!configured(carrier)) throw new Error(`${carrier.toUpperCase()} tracking is not set up on this server (${carrier.toUpperCase()}_CLIENT_ID / _CLIENT_SECRET). Check the inbox for the carrier's emails, or the carrier's site with the browser.`);
  const auth = { Authorization: `Bearer ${await token(carrier)}` };
  if (carrier === "usps") {
    const res = await fetch(`https://apis.usps.com/tracking/v3/tracking/${encodeURIComponent(number)}?expand=DETAIL`, { headers: { ...auth, Accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    const d = (await res.json().catch(() => ({}))) as { statusSummary?: string; status?: string; expectedDeliveryDate?: string; expectedDeliveryTimestamp?: string; trackingEvents?: Array<{ eventTimestamp?: string; eventCity?: string; eventState?: string; eventType?: string; eventCode?: string }>; error?: { message?: string } };
    if (!res.ok) throw new Error(`USPS ${res.status}: ${d.error?.message ?? ""}`.trim());
    const events = (d.trackingEvents ?? []).slice(0, 8).map((e) => ({ at: iso(e.eventTimestamp) ?? "", where: [e.eventCity, e.eventState].filter(Boolean).join(", ") || undefined, what: e.eventType ?? e.eventCode ?? "" }));
    return { carrier, number, status: d.statusSummary ?? d.status ?? events[0]?.what ?? "unknown", expected: iso(d.expectedDeliveryTimestamp ?? d.expectedDeliveryDate), delivered: /delivered/i.test(d.status ?? d.statusSummary ?? ""), events };
  }
  if (carrier === "ups") {
    const res = await fetch(`https://onlinetools.ups.com/api/track/v1/details/${encodeURIComponent(number)}?locale=en_US&returnSignature=false`, { headers: { ...auth, transId: `${Date.now()}`, transactionSrc: "secretary" }, signal: AbortSignal.timeout(15_000) });
    const d = (await res.json().catch(() => ({}))) as { trackResponse?: { shipment?: Array<{ package?: Array<{ activity?: Array<{ status?: { description?: string; type?: string }; date?: string; time?: string; location?: { address?: { city?: string; stateProvince?: string } } }>; deliveryDate?: Array<{ type?: string; date?: string }>; currentStatus?: { description?: string } }> }> }; response?: { errors?: Array<{ message?: string }> } };
    if (!res.ok) throw new Error(`UPS ${res.status}: ${d.response?.errors?.[0]?.message ?? ""}`.trim());
    const pkg = d.trackResponse?.shipment?.[0]?.package?.[0];
    const events = (pkg?.activity ?? []).slice(0, 8).map((a) => ({ at: iso(a.date && a.time ? `${a.date.slice(0, 4)}-${a.date.slice(4, 6)}-${a.date.slice(6, 8)}T${a.time.slice(0, 2)}:${a.time.slice(2, 4)}:${a.time.slice(4, 6) || "00"}` : a.date) ?? "", where: [a.location?.address?.city, a.location?.address?.stateProvince].filter(Boolean).join(", ") || undefined, what: a.status?.description ?? "" }));
    const delivery = pkg?.deliveryDate?.find((x) => x.type === "DEL")?.date ?? pkg?.deliveryDate?.[0]?.date;
    const status = pkg?.currentStatus?.description ?? events[0]?.what ?? "unknown";
    return { carrier, number, status, expected: delivery ? `${delivery.slice(0, 4)}-${delivery.slice(4, 6)}-${delivery.slice(6, 8)}` : undefined, delivered: /delivered/i.test(status), events };
  }
  const res = await fetch("https://apis.fedex.com/track/v1/trackingnumbers", { method: "POST", headers: { ...auth, "Content-Type": "application/json", "X-locale": "en_US" }, body: JSON.stringify({ includeDetailedScans: true, trackingInfo: [{ trackingNumberInfo: { trackingNumber: number } }] }), signal: AbortSignal.timeout(15_000) });
  const d = (await res.json().catch(() => ({}))) as { output?: { completeTrackResults?: Array<{ trackResults?: Array<{ latestStatusDetail?: { description?: string; statusByLocale?: string; code?: string }; dateAndTimes?: Array<{ type?: string; dateTime?: string }>; scanEvents?: Array<{ date?: string; eventDescription?: string; scanLocation?: { city?: string; stateOrProvinceCode?: string } }>; error?: { message?: string } }> }> }; errors?: Array<{ message?: string }> };
  if (!res.ok) throw new Error(`FedEx ${res.status}: ${d.errors?.[0]?.message ?? ""}`.trim());
  const r = d.output?.completeTrackResults?.[0]?.trackResults?.[0];
  if (r?.error?.message) throw new Error(`FedEx: ${r.error.message}`);
  const events = (r?.scanEvents ?? []).slice(0, 8).map((e) => ({ at: iso(e.date) ?? "", where: [e.scanLocation?.city, e.scanLocation?.stateOrProvinceCode].filter(Boolean).join(", ") || undefined, what: e.eventDescription ?? "" }));
  const expected = r?.dateAndTimes?.find((x) => x.type === "ESTIMATED_DELIVERY" || x.type === "ACTUAL_DELIVERY")?.dateTime;
  const status = r?.latestStatusDetail?.statusByLocale ?? r?.latestStatusDetail?.description ?? events[0]?.what ?? "unknown";
  return { carrier, number, status, expected: iso(expected), delivered: r?.latestStatusDetail?.code === "DL" || /delivered/i.test(status), events };
}

export function formatTrack(r: TrackResult): string {
  const head = `${r.carrier.toUpperCase()} ${r.number}: ${r.status}${r.expected ? ` (expected ${r.expected})` : ""}${r.delivered ? " — delivered" : ""}`;
  return r.events.length ? `${head}\n${r.events.map((e) => `- ${e.at}${e.where ? ` ${e.where}` : ""}: ${e.what}`).join("\n")}` : head;
}

export async function runTrackTool(args: Record<string, unknown>): Promise<string> {
  const number = String(args.number ?? "").trim();
  if (!number) return "Pass the tracking number.";
  try {
    return formatTrack(await track(number, args.carrier ? String(args.carrier) : undefined));
  } catch (err) {
    return `track_package: ${err instanceof Error ? err.message : String(err)}`;
  }
}
