import { q } from "./db.js";
import { extractText } from "./documents.js";
import { complete, type Completion } from "./llm.js";
import type { Tenant } from "./tenant.js";

/**
 * Web search and page reading over plain HTTPS from this process: no hosted browser, no CDP round
 * trips, no page settle. A search asks a search API (Brave, Serper or Tavily, whichever keys are
 * set, in SEARCH_ENGINES order) and falls back to DuckDuckGo's HTML endpoint; results are merged
 * across the query variants, canonicalised, de-duplicated, ranked by source tier, and the top pages
 * are read in parallel. Everything is cached in Postgres, shared across customers: a result page is
 * the same for everyone, so the morning digests searching the same topic pay for one search a day.
 *
 * The browser stays the fallback for pages that render only in JavaScript or block plain fetches;
 * the caller (lib/research.ts) decides when to hand a URL to it.
 */
export type Freshness = "day" | "week" | "month" | "year";

export interface Locale {
  /** ISO 3166 two-letter country, upper case (US, GB, CA). */
  country: string;
  /** ISO 639 language (en). */
  lang: string;
  /** A place for local queries ("Brooklyn, NY", "11215"); appended to local-looking queries. */
  near?: string;
}

export interface SearchHit {
  title: string;
  url: string;
  domain: string;
  snippet: string;
  published?: string;
  /** Source quality tier: 0 official, 1 the company's own site, 2 reference, 3 general, 3.5 forums, 5 demoted. */
  tier: number;
  /** Position in its engine's result list, 0-based. */
  rank: number;
  engine: string;
}

export interface PageRead {
  url: string;
  finalUrl: string;
  title: string;
  published?: string;
  text: string;
  /** Characters before any trimming or condensing. */
  chars: number;
  how: "html" | "pdf" | "text" | "blocked" | "short" | "error";
  cached?: boolean;
  condensed?: boolean;
  error?: string;
}

export interface SearchOutcome {
  queries: string[];
  hits: SearchHit[];
  pages: PageRead[];
  engine: string;
  ms: number;
  cached: boolean;
  errors: string[];
}

const SEARCH_TIMEOUT_MS = Number(process.env.SEARCH_TIMEOUT_MS ?? 5000);
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? 6000);
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
/** A page longer than this is condensed by the fast model before it reaches the task model. */
export const PAGE_CONDENSE_CHARS = Number(process.env.PAGE_CONDENSE_CHARS ?? 6000);
/** What a page read returns to the model at most, condensed or cut. */
export const PAGE_MAX_CHARS = Number(process.env.PAGE_MAX_CHARS ?? 7000);
const RESULTS_PER_QUERY = Number(process.env.SEARCH_RESULTS_PER_QUERY ?? 10);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36";

// ------------------------------------------------------------------ locale

const TZ_COUNTRY: Array<[RegExp, string]> = [
  [/^America\/(Toronto|Vancouver|Montreal|Edmonton|Winnipeg|Halifax|Regina|St_Johns)$/, "CA"],
  [/^America\/(Mexico_City|Cancun|Monterrey|Tijuana)$/, "MX"],
  [/^America\/(Sao_Paulo|Bahia|Fortaleza|Manaus)$/, "BR"],
  [/^America\/(Argentina|Buenos_Aires)/, "AR"],
  [/^America\//, "US"],
  [/^Pacific\/Honolulu$/, "US"],
  [/^Europe\/(London|Belfast)$/, "GB"],
  [/^Europe\/Dublin$/, "IE"],
  [/^Europe\/Paris$/, "FR"],
  [/^Europe\/(Berlin|Busingen)$/, "DE"],
  [/^Europe\/Madrid$/, "ES"],
  [/^Europe\/Rome$/, "IT"],
  [/^Europe\/Amsterdam$/, "NL"],
  [/^Europe\/(Brussels)$/, "BE"],
  [/^Europe\/(Zurich)$/, "CH"],
  [/^Europe\/(Vienna)$/, "AT"],
  [/^Europe\/(Stockholm)$/, "SE"],
  [/^Europe\/(Oslo)$/, "NO"],
  [/^Europe\/(Copenhagen)$/, "DK"],
  [/^Europe\/(Lisbon)$/, "PT"],
  [/^Europe\/(Warsaw)$/, "PL"],
  [/^Australia\//, "AU"],
  [/^Pacific\/Auckland$/, "NZ"],
  [/^Asia\/Tokyo$/, "JP"],
  [/^Asia\/Singapore$/, "SG"],
  [/^Asia\/(Kolkata|Calcutta)$/, "IN"],
  [/^Asia\/Dubai$/, "AE"],
  [/^Asia\/Hong_Kong$/, "HK"],
  [/^Africa\/Johannesburg$/, "ZA"],
];

/** The customer's country and language for the search API, from their settings or, failing that, their time zone. */
export function localeFor(t: Pick<Tenant, "timezone" | "settings"> | undefined): Locale {
  const s = (t?.settings ?? {}) as { country?: string; city?: string; language?: string };
  const country = (s.country ?? TZ_COUNTRY.find(([re]) => re.test(t?.timezone ?? ""))?.[1] ?? "US").toUpperCase().slice(0, 2);
  return { country, lang: (s.language ?? "en").toLowerCase().slice(0, 2), near: s.city?.trim() || undefined };
}

// ------------------------------------------------------------------ URLs and source tiers

const TRACKING = /^(utm_\w*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|yclid|srsltid|spm|si|ref|ref_|ref_src|_ga|_gl|gad_source|wt_mc|oly_\w+|vero_\w+|s_kwcid|ncid|cmpid|campaign_id|sr_share)$/i;

/** One URL per page: no tracking parameters, no mobile/AMP host or path variant, no fragment. */
export function canonicalUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return raw.trim();
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return raw.trim();
  u.hash = "";
  u.protocol = "https:";
  u.hostname = u.hostname.toLowerCase().replace(/^(www|m|mobile|amp)\./, "");
  for (const k of [...u.searchParams.keys()]) if (TRACKING.test(k) || (k === "output" && u.searchParams.get(k) === "amp") || k === "amp") u.searchParams.delete(k);
  u.pathname = u.pathname.replace(/\/amp\/?$/, "/").replace(/^\/amp\//, "/").replace(/\/index\.(html?|php)$/, "/");
  if (u.pathname.length > 1) u.pathname = u.pathname.replace(/\/+$/, "");
  const s = u.toString();
  return s.endsWith("?") ? s.slice(0, -1) : s;
}

export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^(www|m|mobile|amp)\./, "");
  } catch {
    return "";
  }
}

const OFFICIAL = /\.(gov|mil|edu|gov\.uk|gc\.ca|gov\.au|govt\.nz)$|(^|\.)(usps|irs|ssa|medicare|cdc|nih|fda|uscis|state|un|who|europa|nyc|ny|ca|tx|fl|pa|nj|ma|il|wa)\.(gov|org|int)$|(^|\.)(usps|amtrak|mta)\.(com|info)$/i;
const REFERENCE = /(^|\.)(wikipedia\.org|britannica\.com|consumerreports\.org|nytimes\.com|wsj\.com|reuters\.com|apnews\.com|bbc\.(com|co\.uk)|npr\.org|bloomberg\.com|cnbc\.com|washingtonpost\.com|theguardian\.com|ft\.com|economist\.com|nerdwallet\.com|investopedia\.com|bankrate\.com|mayoclinic\.org|clevelandclinic\.org|healthline\.com|webmd\.com|medlineplus\.gov|yelp\.com|tripadvisor\.com|bbb\.org|edmunds\.com|kbb\.com|caranddriver\.com|rtings\.com|wirecutter\.com|cnet\.com|theverge\.com|arstechnica\.com|zillow\.com|redfin\.com|realtor\.com|opentable\.com|resy\.com|google\.com|apple\.com|microsoft\.com|amazon\.com|walmart\.com|target\.com|costco\.com|homedepot\.com|lowes\.com|bestbuy\.com|expedia\.com|kayak\.com|booking\.com|airbnb\.com|yellowpages\.com|mapquest\.com|weather\.gov|weather\.com|accuweather\.com)$/i;
const FORUMS = /(^|\.)(reddit\.com|quora\.com|stackexchange\.com|stackoverflow\.com|city-data\.com|flyertalk\.com|bogleheads\.org|nextdoor\.com)$/i;
const DEMOTED = /(^|\.)(pinterest\.\w+|scribd\.com|coursehero\.com|slideshare\.net|issuu\.com|answers\.com|ehow\.com|alibaba\.com|aliexpress\.\w+|dhgate\.com|blogspot\.com|tumblr\.com|weebly\.com|wixsite\.com|studocu\.com|numerade\.com|brainly\.com|chegg\.com|prezi\.com|academia\.edu|fandom\.com|pdfcoffee\.com|dokumen\.pub|yumpu\.com|zhihu\.com|baidu\.com|linktr\.ee)$/i;
const REVIEW_INTENT = /\b(review|reviews|worth it|recommend|best|vs\.?|versus|experience|reliable|is it good|any good|opinions?)\b/i;

/**
 * Where a result sits in the source ladder for this query: official records first, the company's own
 * site next, established reference and review sites, then everything else, forums (promoted when the
 * question asks for real experiences), and scraped or low-quality aggregators last.
 */
export function tierOf(url: string, query: string): number {
  const d = domainOf(url);
  if (!d) return 4;
  if (DEMOTED.test(d)) return 5;
  if (OFFICIAL.test(d)) return 0;
  // "uber fare estimate" -> uber.com is the company's own site.
  const label = d.split(".").slice(-2, -1)[0] ?? "";
  if (label.length >= 3 && new RegExp(`\\b${label.replace(/[^a-z0-9]/gi, "")}\\b`, "i").test(query.replace(/[^a-z0-9 ]/gi, ""))) return 1;
  if (REFERENCE.test(d)) return 2;
  if (FORUMS.test(d)) return REVIEW_INTENT.test(query) ? 2.5 : 3.5;
  return 3;
}

/**
 * Merge results from several queries and engines: one entry per canonical URL (the best snippet
 * kept), sorted by source tier then position, at most two per domain unless the query asked for one
 * site with `site:`. Ranking is stable, so the model sees the same list for the same question.
 */
export function rerank(lists: Array<{ query: string; hits: SearchHit[] }>, limit = 12): SearchHit[] {
  const byUrl = new Map<string, { hit: SearchHit; score: number }>();
  const siteQuery = lists.some((l) => /\bsite:\S+/i.test(l.query));
  lists.forEach(({ query, hits }, qi) => {
    hits.forEach((h, rank) => {
      const url = canonicalUrl(h.url);
      const tier = tierOf(url, query);
      const score = tier * 10 + rank + qi * 0.5;
      const cur = byUrl.get(url);
      if (!cur) byUrl.set(url, { hit: { ...h, url, domain: domainOf(url), tier, rank }, score });
      else {
        // The same page from a second query: it is relevant to more phrasings, so it moves up a little.
        cur.score = Math.min(cur.score, score) - 1;
        if ((h.snippet?.length ?? 0) > cur.hit.snippet.length) cur.hit.snippet = h.snippet;
        cur.hit.published ??= h.published;
      }
    });
  });
  const sorted = [...byUrl.values()].sort((a, b) => a.score - b.score || a.hit.url.localeCompare(b.hit.url));
  const perDomain = new Map<string, number>();
  const out: SearchHit[] = [];
  for (const { hit } of sorted) {
    const n = perDomain.get(hit.domain) ?? 0;
    if (!siteQuery && n >= 2) continue;
    perDomain.set(hit.domain, n + 1);
    out.push(hit);
    if (out.length >= limit) break;
  }
  return out;
}

// ------------------------------------------------------------------ cache (shared across customers)

const cacheOn = () => (process.env.SEARCH_CACHE ?? "on") !== "off";

/** How long a search result list stays valid: fresh queries expire in minutes, evergreen ones in a day. */
export function searchTtlMs(since?: Freshness): number {
  if (since === "day") return Number(process.env.SEARCH_CACHE_FRESH_MINUTES ?? 20) * 60_000;
  if (since === "week") return 3 * 3_600_000;
  return Number(process.env.SEARCH_CACHE_HOURS ?? 24) * 3_600_000;
}
const PAGE_TTL_MS = Number(process.env.PAGE_CACHE_HOURS ?? 12) * 3_600_000;

async function cacheGet<T>(key: string): Promise<T | undefined> {
  if (!cacheOn()) return undefined;
  try {
    const rows = await q<{ value: T }>("select value from search_cache where key = $1 and expires_at > now()", [key]);
    return rows[0]?.value;
  } catch {
    return undefined;
  }
}

async function cachePut(key: string, kind: "search" | "page", value: unknown, ttlMs: number): Promise<void> {
  if (!cacheOn() || ttlMs <= 0) return;
  try {
    await q("insert into search_cache (key, kind, value, fetched_at, expires_at) values ($1, $2, $3::jsonb, now(), now() + ($4 || ' milliseconds')::interval) on conflict (key) do update set value = $3::jsonb, fetched_at = now(), expires_at = now() + ($4 || ' milliseconds')::interval", [key, kind, JSON.stringify(value), String(Math.round(ttlMs))]);
  } catch {
    /* the cache is an optimisation */
  }
}

/** Expired rows, dropped by the cron sweep. */
export async function pruneSearchCache(): Promise<number> {
  try {
    const r = await q<{ n: string }>("with d as (delete from search_cache where expires_at < now() returning 1) select count(*)::text as n from d");
    return Number(r[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

export function normalizeQuery(query: string): string {
  return query.toLowerCase().replace(/\s+/g, " ").trim();
}

// ------------------------------------------------------------------ engines

interface EngineOpts {
  since?: Freshness;
  locale: Locale;
  count: number;
  signal: AbortSignal;
}
interface Engine {
  name: string;
  available(): boolean;
  search(query: string, o: EngineOpts): Promise<SearchHit[]>;
}

const withTimeout = (ms: number) => AbortSignal.timeout(ms);

function fail(engine: string, res: Response, text: string): never {
  throw new Error(`${engine} ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 120)}`);
}

const brave: Engine = {
  name: "brave",
  available: () => !!process.env.BRAVE_SEARCH_API_KEY,
  async search(query, o) {
    const p = new URLSearchParams({ q: query, count: String(Math.min(20, o.count)), country: o.locale.country, search_lang: o.locale.lang, text_decorations: "0", safesearch: "moderate" });
    if (o.since) p.set("freshness", { day: "pd", week: "pw", month: "pm", year: "py" }[o.since]);
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${p}`, { headers: { Accept: "application/json", "X-Subscription-Token": process.env.BRAVE_SEARCH_API_KEY! }, signal: o.signal });
    if (!res.ok) fail("brave", res, await res.text());
    const data = (await res.json()) as { web?: { results?: Array<{ title: string; url: string; description?: string; page_age?: string; age?: string }> } };
    return (data.web?.results ?? []).map((r, rank) => ({ title: r.title, url: r.url, domain: domainOf(r.url), snippet: r.description ?? "", published: isoDate(r.page_age ?? r.age), tier: 3, rank, engine: "brave" }));
  },
};

const serper: Engine = {
  name: "serper",
  available: () => !!process.env.SERPER_API_KEY,
  async search(query, o) {
    const body: Record<string, unknown> = { q: query, gl: o.locale.country.toLowerCase(), hl: o.locale.lang, num: Math.min(20, o.count) };
    if (o.since) body.tbs = `qdr:${o.since[0]}`;
    if (o.locale.near) body.location = o.locale.near;
    const res = await fetch("https://google.serper.dev/search", { method: "POST", headers: { "Content-Type": "application/json", "X-API-KEY": process.env.SERPER_API_KEY! }, body: JSON.stringify(body), signal: o.signal });
    if (!res.ok) fail("serper", res, await res.text());
    const data = (await res.json()) as { organic?: Array<{ title: string; link: string; snippet?: string; date?: string }> };
    return (data.organic ?? []).map((r, rank) => ({ title: r.title, url: r.link, domain: domainOf(r.link), snippet: r.snippet ?? "", published: isoDate(r.date), tier: 3, rank, engine: "serper" }));
  },
};

const tavily: Engine = {
  name: "tavily",
  available: () => !!process.env.TAVILY_API_KEY,
  async search(query, o) {
    const body: Record<string, unknown> = { api_key: process.env.TAVILY_API_KEY, query, max_results: Math.min(20, o.count), search_depth: "basic", include_answer: false, country: o.locale.country };
    if (o.since) body.days = { day: 1, week: 7, month: 30, year: 365 }[o.since];
    const res = await fetch("https://api.tavily.com/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: o.signal });
    if (!res.ok) fail("tavily", res, await res.text());
    const data = (await res.json()) as { results?: Array<{ title: string; url: string; content?: string; published_date?: string }> };
    return (data.results ?? []).map((r, rank) => ({ title: r.title, url: r.url, domain: domainOf(r.url), snippet: (r.content ?? "").slice(0, 300), published: isoDate(r.published_date), tier: 3, rank, engine: "tavily" }));
  },
};

/** DuckDuckGo's HTML endpoint: no key, no JavaScript, rate-limited and captcha-walled when abused. Last HTTP resort. */
const duckduckgo: Engine = {
  name: "duckduckgo",
  available: () => (process.env.SEARCH_DDG ?? "on") !== "off",
  async search(query, o) {
    const p = new URLSearchParams({ q: query, kl: `${o.locale.country.toLowerCase()}-${o.locale.lang}` });
    if (o.since) p.set("df", o.since[0]);
    let lastError = "duckduckgo returned no result list";
    for (const endpoint of ["https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"]) {
      const res = await fetch(`${endpoint}?${p}`, { headers: { "User-Agent": UA, Accept: "text/html", "Accept-Language": `${o.locale.lang},en;q=0.8` }, signal: o.signal });
      const html = await res.text();
      if (!res.ok) {
        lastError = `duckduckgo ${res.status}`;
        continue;
      }
      const hits = parseDuckDuckGo(html);
      if (hits.length) return hits.slice(0, o.count).map((h, rank) => ({ ...h, rank }));
      // A block page is never shown to the model as results; the next endpoint or engine gets a turn.
      lastError = /anomaly|bots|captcha|challenge|unusual traffic/i.test(html) ? "duckduckgo blocked the request (bot check)" : /result/i.test(html) ? "duckduckgo found nothing" : "duckduckgo returned no result list";
      if (lastError === "duckduckgo found nothing") return [];
    }
    throw new Error(lastError);
  },
};

/** Result links and snippets out of DuckDuckGo's HTML or Lite page. Redirect links are unwrapped. */
export function parseDuckDuckGo(html: string): SearchHit[] {
  const out: SearchHit[] = [];
  const seen = new Set<string>();
  const linkRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html))) {
    const attrs = m[1];
    if (!/\bclass="[^"]*\b(?:result__a|result-link)\b[^"]*"/i.test(attrs)) continue;
    const hrefAttr = attrs.match(/\bhref="([^"]+)"/i);
    if (!hrefAttr) continue;
    let href = decodeEntities(hrefAttr[1]);
    const redirect = href.match(/[?&]uddg=([^&]+)/);
    if (redirect) href = decodeURIComponent(redirect[1]);
    if (href.startsWith("//")) href = `https:${href}`;
    if (!/^https?:\/\//i.test(href) || /duckduckgo\.com/i.test(href) || seen.has(href)) continue;
    seen.add(href);
    const title = stripTags(m[2]).trim();
    // The snippet is the next result__snippet (HTML) or result-snippet (Lite) after this link.
    const rest = html.slice(m.index + m[0].length, m.index + m[0].length + 3000);
    const sn = rest.match(/class="(?:result__snippet|result-snippet)"[^>]*>([\s\S]*?)<\/(?:a|td|div|span)>/i);
    out.push({ title, url: href, domain: domainOf(href), snippet: sn ? stripTags(sn[1]).trim().slice(0, 300) : "", tier: 3, rank: out.length, engine: "duckduckgo" });
  }
  return out;
}

function engines(): Engine[] {
  const all = [brave, serper, tavily, duckduckgo];
  const order = (process.env.SEARCH_ENGINES ?? "brave,serper,tavily,duckduckgo").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return order.map((n) => all.find((e) => e.name === n)).filter((e): e is Engine => !!e && e.available());
}

/** Whether any search engine at all is configured (a keyless deploy still has DuckDuckGo). */
export function searchConfigured(): boolean {
  return engines().length > 0;
}

/** Run one query through the engines in order until one answers; the first engine's failure is logged, never shown as results. */
async function searchOne(query: string, o: Omit<EngineOpts, "signal">, errors: string[]): Promise<{ hits: SearchHit[]; engine: string; cached: boolean }> {
  const key = `search:${normalizeQuery(query)}|${o.locale.country}|${o.locale.lang}|${o.locale.near ?? ""}|${o.since ?? ""}`;
  const cached = await cacheGet<{ hits: SearchHit[]; engine: string }>(key);
  if (cached) return { ...cached, cached: true };
  for (const e of engines()) {
    try {
      const hits = await e.search(query, { ...o, signal: withTimeout(SEARCH_TIMEOUT_MS) });
      if (!hits.length) continue; // another engine may know the answer; an empty list is not a result
      await cachePut(key, "search", { hits, engine: e.name }, searchTtlMs(o.since));
      return { hits, engine: e.name, cached: false };
    } catch (err) {
      errors.push(`${e.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { hits: [], engine: "none", cached: false };
}

const LOCAL_INTENT = /\b(near me|nearby|open now|closest|nearest|hours|store|shop|pharmacy|restaurant|plumber|electrician|dentist|doctor|clinic|urgent care|dmv|library|gym|salon|barber|vet|repair|locksmith|towing|laundromat|car wash|gas station|post office|branch|atm)\b/i;

export interface SearchRequest {
  queries: string[];
  since?: Freshness;
  locale: Locale;
  /** Pages to read from the top of the merged list, in parallel. */
  readTop?: number;
  /** What the reader is looking for; long pages are condensed around it. */
  focus?: string;
  /** Results to return at most. */
  limit?: number;
  /** Cost of condensing calls is booked here. */
  charge?: (c: Completion) => Promise<unknown>;
  /** The fast model used for condensing. */
  condenseModel?: string;
}

/**
 * The whole search: every query variant in parallel, merged and reranked, then the top pages read
 * in parallel with a per-page timeout (a slow page never holds the answer hostage: whatever came back
 * in time is returned).
 */
export async function searchWeb(req: SearchRequest): Promise<SearchOutcome> {
  const started = Date.now();
  const errors: string[] = [];
  const queries = [...new Set(req.queries.map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean))].slice(0, 4);
  if (!queries.length) return { queries, hits: [], pages: [], engine: "none", ms: 0, cached: false, errors: ["no query"] };
  const near = req.locale.near;
  const lists = await Promise.all(
    queries.map(async (query) => {
      // A local question gets the place appended unless the query already names one.
      const localised = near && LOCAL_INTENT.test(query) && !new RegExp(near.split(/[\s,]+/)[0].replace(/[^\w]/g, ""), "i").test(query) ? `${query} ${near}` : query;
      const r = await searchOne(localised, { since: req.since, locale: req.locale, count: RESULTS_PER_QUERY }, errors);
      return { query, ...r };
    }),
  );
  const hits = rerank(lists.map((l) => ({ query: l.query, hits: l.hits })), req.limit ?? 12);
  const engine = lists.find((l) => l.engine !== "none")?.engine ?? "none";
  const cached = lists.length > 0 && lists.every((l) => l.cached);
  const readTop = Math.max(0, Math.min(5, req.readTop ?? 0));
  const pages = readTop ? await readPages(hits.slice(0, readTop).map((h) => h.url), { focus: req.focus ?? queries[0], charge: req.charge, condenseModel: req.condenseModel }) : [];
  return { queries, hits, pages, engine, ms: Date.now() - started, cached, errors };
}

// ------------------------------------------------------------------ reading pages

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[::1\]|::1$|fc00:|fe80:)|\.(local|internal|localhost)$/i;
function isPrivate(host: string): boolean {
  if (PRIVATE_HOST.test(host)) return true;
  const m = host.match(/^172\.(\d+)\./);
  return !!m && Number(m[1]) >= 16 && Number(m[1]) <= 31;
}

/**
 * Read one page over HTTPS: the main text of an HTML page, the text layer of a PDF, or a text file.
 * A block, a JavaScript-only shell (almost no text) or a timeout is reported as such, so the caller
 * can hand the URL to the browser instead of treating an empty page as the answer.
 */
export async function fetchPage(rawUrl: string, opts: { timeoutMs?: number; noCache?: boolean } = {}): Promise<PageRead> {
  const url = canonicalUrl(rawUrl);
  const base: PageRead = { url, finalUrl: url, title: "", text: "", chars: 0, how: "error" };
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ...base, error: "not a valid URL" };
  }
  if (!/^https?:$/.test(parsed.protocol) || isPrivate(parsed.hostname)) return { ...base, error: "only public http(s) pages can be read" };
  if (!opts.noCache) {
    const cached = await cacheGet<PageRead>(`page:${url}`);
    if (cached) return { ...cached, cached: true };
  }
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5", "Accept-Language": "en-US,en;q=0.8" },
      redirect: "follow",
      signal: withTimeout(opts.timeoutMs ?? FETCH_TIMEOUT_MS),
    });
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    const buf = await readBody(res, MAX_PAGE_BYTES);
    if (res.status === 403 || res.status === 429 || res.status === 503) return { ...base, finalUrl: res.url || url, how: "blocked", error: `HTTP ${res.status}` };
    if (!res.ok) return { ...base, finalUrl: res.url || url, error: `HTTP ${res.status}` };
    let page: PageRead;
    if (type.includes("pdf") || buf.subarray(0, 5).toString() === "%PDF-") {
      const ex = await extractText(buf, "application/pdf", url);
      page = { ...base, finalUrl: res.url || url, title: url.split("/").pop() ?? url, text: ex.text, chars: ex.text.length, how: "pdf" };
    } else if (type.startsWith("text/plain") || type.includes("json") || type.includes("csv")) {
      const text = buf.toString("utf8");
      page = { ...base, finalUrl: res.url || url, title: url, text, chars: text.length, how: "text" };
    } else {
      const ex = extractMain(buf.toString(charsetOf(type, buf)));
      page = { ...base, finalUrl: res.url || url, title: ex.title, published: ex.published, text: ex.text, chars: ex.text.length, how: "html" };
      if (/captcha|verify you are human|are you a robot|access denied|attention required|enable javascript and cookies/i.test(ex.text.slice(0, 600)) && ex.text.length < 1500) page.how = "blocked";
    }
    if (page.how !== "blocked" && page.text.trim().length < 300) page.how = "short";
    if (page.how === "html" || page.how === "pdf" || page.how === "text") await cachePut(`page:${url}`, "page", page, PAGE_TTL_MS);
    return page;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, error: /abort|timeout/i.test(msg) ? `timed out after ${Math.round((opts.timeoutMs ?? FETCH_TIMEOUT_MS) / 1000)}s` : msg.slice(0, 160) };
  }
}

async function readBody(res: Response, max: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { value, done } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}

function charsetOf(type: string, buf: Buffer): BufferEncoding {
  const m = type.match(/charset=([\w-]+)/) ?? buf.subarray(0, 2048).toString("latin1").match(/charset=["']?([\w-]+)/i);
  const cs = (m?.[1] ?? "utf-8").toLowerCase();
  return cs === "iso-8859-1" || cs === "latin1" || cs === "windows-1252" ? "latin1" : "utf8";
}

/**
 * Read several pages at once. Each has its own timeout; the slow ones come back as errors while the
 * rest are returned, and long pages are condensed around the focus by the fast model in parallel.
 */
export async function readPages(urls: string[], opts: { focus?: string; charge?: (c: Completion) => Promise<unknown>; condenseModel?: string } = {}): Promise<PageRead[]> {
  const pages = await Promise.all(urls.map((u) => fetchPage(u)));
  return Promise.all(pages.map((p) => condensePage(p, opts)));
}

/**
 * A long page is boiled down by the fast model to what bears on the question, figures and dates
 * kept exactly, before it reaches the task model: a tenth of the tokens at a tenth of the price.
 * Without a model (or when the call fails) the text is cut instead.
 */
export async function condensePage(page: PageRead, opts: { focus?: string; charge?: (c: Completion) => Promise<unknown>; condenseModel?: string }): Promise<PageRead> {
  if (page.text.length <= PAGE_CONDENSE_CHARS) return page;
  if (opts.condenseModel && opts.focus) {
    try {
      const c = await complete({
        model: opts.condenseModel,
        temperature: 0,
        maxTokens: 700,
        messages: [
          { role: "system", content: "You condense one web page for an assistant researching a question. Keep everything that bears on the question: figures, prices, dates, names, phone numbers, addresses, hours, policies, steps, exactly as written. Drop navigation, ads, unrelated sections and repetition. Plain text, under 300 words, in the page's own words where possible. If the page has nothing on the question, reply exactly: NOTHING_RELEVANT." },
          { role: "user", content: `Question: ${opts.focus}\nPage: ${page.title || page.finalUrl}\n\n${page.text.slice(0, 60_000)}` },
        ],
      });
      if (opts.charge) await opts.charge(c);
      const text = typeof c.message.content === "string" ? c.message.content.trim() : "";
      if (text) return { ...page, text: text === "NOTHING_RELEVANT" ? `(nothing on "${opts.focus}" in this ${page.chars.toLocaleString()}-character page)` : text, condensed: true };
    } catch (err) {
      console.error(`[search] condense ${page.finalUrl}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { ...page, text: page.text.slice(0, PAGE_MAX_CHARS) + `\n... (${(page.chars - PAGE_MAX_CHARS).toLocaleString()} more characters; fetch_page with a focus to read the rest condensed)` };
}

// ------------------------------------------------------------------ HTML to main text

const RAW_TEXT = new Set(["script", "style", "noscript", "template", "svg", "textarea", "iframe"]);
const VOID = new Set(["br", "img", "hr", "input", "meta", "link", "source", "track", "wbr", "area", "base", "col", "embed", "param"]);
const DROP = new Set(["script", "style", "noscript", "svg", "template", "head", "iframe", "canvas", "object", "video", "audio", "picture", "select", "option", "button", "form", "nav", "header", "footer", "aside", "dialog", "menu"]);
const BLOCK = new Set(["p", "div", "section", "article", "main", "li", "ul", "ol", "tr", "td", "th", "table", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "br", "hr", "dd", "dt", "dl", "figcaption", "summary", "details", "address"]);
// Class and id tokens are matched whole: "site-header" is chrome, "article-header" (the headline) is not;
// "main-content" is the content, "vector-feature-main-menu-pinned-disabled" (Wikipedia's <html>) is not.
const CHROME_TOKEN = /^(nav|navbar|navigation|menu|menubar|footer|header|masthead|sidebar|side-bar|top-bar|topbar|toolbar|breadcrumbs?|pagination|pager|widget|popup|modal|overlay|newsletter|subscribe|signup|login|legal|disclaimer|comments?|comment-\S*|related\S*|recommended\S*|sponsor\S*|advert\S*|ads?|ad-\S*|ad_\S*|promo\S*|cookie\S*|consent\S*|share\S*|social\S*|skip-link|site-header|site-footer|page-header|page-footer|global-nav|main-nav|sub-nav|nav-\S*|\S*-nav|\S*-menu|\S*-footer|\S*-sidebar|\S*-banner|banner|hidden|visually-hidden|sr-only|screen-reader-text)$/i;
const MAIN_TOKEN = /^(content|main|article|post|entry|story|body-copy|page-content|article-body|article-content|post-content|post-body|entry-content|story-body|main-content|main-column|mw-body|mw-parser-output|bodyContent|mainContent|articleBody)$/i;
const tokens = (attrs: string): string[] => `${attrs.match(/\bclass=["']([^"']*)["']/i)?.[1] ?? ""} ${attrs.match(/\bid=["']([^"']*)["']/i)?.[1] ?? ""}`.split(/\s+/).filter(Boolean);

export interface MainText {
  title: string;
  published?: string;
  canonical?: string;
  text: string;
}

/**
 * The readable text of an HTML page without a DOM library: a single pass over the tags with a stack,
 * skipping scripts, navigation, footers, forms and anything whose class or id says it is page
 * chrome. If the page marks its main content (<article>, <main>, role=main, a content/post/entry
 * container) and that part is long enough, only it is returned.
 */
export function extractMain(html: string): MainText {
  const title = decodeEntities(html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const canonical = html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1];
  const published = isoDate(
    html.match(/<meta[^>]+(?:property|name)=["'](?:article:published_time|datePublished|date|pubdate|publish[_-]?date|dc\.date(?:\.issued)?|parsely-pub-date|sailthru\.date)["'][^>]+content=["']([^"']+)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:article:published_time|datePublished|date|pubdate)["']/i)?.[1] ??
      html.match(/"datePublished"\s*:\s*"([^"]+)"/)?.[1] ??
      html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1],
  );

  const lower = html.toLowerCase();
  const all: string[] = [];
  const main: string[] = [];
  const stack: Array<{ tag: string; skip: boolean; main: boolean }> = [];
  let skipDepth = 0;
  let mainDepth = 0;
  const push = (s: string) => {
    if (skipDepth) return;
    all.push(s);
    if (mainDepth) main.push(s);
  };
  // Attribute values may contain ">" (JSON in data-* attributes, inline SVG paths), so a tag ends at the
  // first ">" outside quotes. Comments, CDATA and declarations (<!DOCTYPE>) are skipped whole.
  const tagRe = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<![^>]*>|<\/?([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  while ((m = tagRe.exec(html))) {
    if (m[3] !== undefined) {
      push(decodeEntities(m[3]));
      continue;
    }
    if (!m[1]) continue; // comment
    const tag = m[1].toLowerCase();
    const attrs = m[2] ?? "";
    const closing = m[0].startsWith("</");
    // Script, style and SVG bodies are not markup: a ">" inside inline JavaScript would otherwise end
    // the tag early and spill code into the text. Jump straight past the closing tag.
    if (!closing && RAW_TEXT.has(tag)) {
      const end = lower.indexOf(`</${tag}`, tagRe.lastIndex);
      tagRe.lastIndex = end < 0 ? html.length : html.indexOf(">", end) + 1 || html.length;
      continue;
    }
    if (closing) {
      // Pop to the matching open tag (tolerating unclosed tags in between).
      const at = stack.map((s) => s.tag).lastIndexOf(tag);
      if (at >= 0) {
        for (let i = stack.length - 1; i >= at; i--) {
          const f = stack.pop()!;
          if (f.skip) skipDepth--;
          if (f.main) mainDepth--;
        }
      }
      if (BLOCK.has(tag)) push("\n");
      continue;
    }
    if (VOID.has(tag) || attrs.endsWith("/")) {
      if (tag === "br" || tag === "hr") push("\n");
      continue;
    }
    const structural = tag === "body" || tag === "html";
    const toks = structural ? [] : tokens(attrs);
    const role = attrs.match(/\brole=["']([^"']*)["']/i)?.[1] ?? "";
    const hidden = !structural && (/(^|\s)hidden(\s|=|$)|aria-hidden=["']true["']|display:\s*none/i.test(attrs));
    const skip = DROP.has(tag) || hidden || /^(navigation|banner|contentinfo|complementary|dialog|menu|search)$/i.test(role) || toks.some((c) => CHROME_TOKEN.test(c));
    const isMain = !skip && !structural && (tag === "article" || tag === "main" || role === "main" || toks.some((c) => MAIN_TOKEN.test(c)));
    if (skip) skipDepth++;
    if (isMain) mainDepth++;
    if (BLOCK.has(tag)) push("\n");
    stack.push({ tag, skip, main: isMain });
  }
  const clean = (parts: string[]) =>
    parts
      .join("")
      .replace(/[ \t\r\f\v ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .split("\n")
      .filter((l) => l.trim().length > 2 || l === "")
      .join("\n")
      .trim();
  const mainText = clean(main);
  const text = mainText.length >= 500 ? mainText : clean(all);
  return { title, published, canonical: canonical ? decodeEntities(canonical) : undefined, text };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", copy: "©", reg: "®", trade: "™", deg: "°", times: "×", middot: "·", bull: "•", laquo: "«", raquo: "»", lsaquo: "‹", rsaquo: "›", euro: "€", pound: "£", yen: "¥", cent: "¢" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
}

/** A date string from an engine or a page as YYYY-MM-DD, or undefined when it does not parse. */
export function isoDate(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const d = new Date(s);
  if (!Number.isNaN(d.getTime()) && d.getFullYear() > 1990 && d.getFullYear() < 2100) return d.toISOString().slice(0, 10);
  // "3 days ago", "2 weeks ago" (Brave's age field).
  const rel = s.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i);
  if (rel) {
    const n = Number(rel[1]);
    const ms = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000, year: 31_536_000_000 }[rel[2].toLowerCase() as "minute" | "hour" | "day" | "week" | "month" | "year"];
    return new Date(Date.now() - n * ms).toISOString().slice(0, 10);
  }
  return undefined;
}

// ------------------------------------------------------------------ formatting for the model

/** The oldest a price, hours or policy page may be before the model is told to verify it. */
const STALE_DAYS = Number(process.env.SEARCH_STALE_DAYS ?? 365);
const TIME_SENSITIVE = /\b(price|prices|cost|fee|fees|rate|rates|hours|open|closes?|schedule|deadline|due|policy|policies|tax|tariff|fare|salary|wage|minimum|maximum|limit|requirements?|eligib|how (much|long|late)|when)\b/i;

/**
 * Search results as the model reads them. Each result is one `[n]` line (title, URL, domain, date)
 * with its snippet indented under it; the `[n]` lines are what survives when the result is stubbed
 * out of an old turn, so the model can still fetch_page any of them later.
 */
export function formatSearch(o: SearchOutcome, budget: { used: number; limit: number }, note?: string): string {
  const lines: string[] = [];
  const stale = TIME_SENSITIVE.test(o.queries.join(" "));
  lines.push(`web_search: ${o.queries.length} quer${o.queries.length === 1 ? "y" : "ies"}, ${o.hits.length} results (${o.engine}${o.cached ? ", cached" : ""}, ${(o.ms / 1000).toFixed(1)}s); pages read this task: ${budget.used}/${budget.limit}`);
  if (note) lines.push(note);
  if (o.queries.length > 1) lines.push(`queries: ${o.queries.map((s) => JSON.stringify(s)).join(", ")}`);
  if (!o.hits.length) {
    lines.push(o.errors.length ? `No results. Engines: ${o.errors.join("; ")}` : "No results for these queries. Rephrase, drop a word, or try a site: query.");
    return lines.join("\n");
  }
  o.hits.forEach((h, i) => {
    const age = h.published && stale && Date.now() - new Date(h.published).getTime() > STALE_DAYS * 86_400_000 ? ", old: verify before repeating" : "";
    lines.push(`[${i + 1}] ${h.title || h.domain} — ${h.url} (${h.domain}${h.published ? `, ${h.published}` : ""}${tierLabel(h.tier)}${age})`);
    if (h.snippet) lines.push(`    ${h.snippet.replace(/\s+/g, " ").slice(0, 220)}`);
  });
  const read = o.pages.filter((p) => p.text);
  const distinct = new Set(read.filter((p) => p.how !== "error" && p.how !== "blocked" && p.how !== "short").map((p) => domainOf(p.finalUrl))).size;
  if (o.pages.length) lines.push(`\n${read.length} of the top ${o.pages.length} pages read (${distinct} distinct domain${distinct === 1 ? "" : "s"}). Cite results as [n] with the URL.`);
  o.pages.forEach((p) => {
    const n = o.hits.findIndex((h) => h.url === p.url) + 1;
    lines.push(`\n--- page [${n}] ${p.title || p.finalUrl} (${p.finalUrl}${p.published ? `, ${p.published}` : ""}, ${pageState(p)}) ---`);
    lines.push(pageBody(p));
  });
  return lines.join("\n");
}

function tierLabel(tier: number): string {
  if (tier === 0) return ", official";
  if (tier === 1) return ", the company's own site";
  if (tier === 5) return ", low-quality source";
  if (tier >= 3.5) return ", forum";
  return "";
}

function pageState(p: PageRead): string {
  if (p.how === "error") return `could not read: ${p.error}`;
  if (p.how === "blocked") return `blocked the plain fetch${p.error ? ` (${p.error})` : ""}: use browser_goto for this one`;
  if (p.how === "short") return `almost no text (${p.chars} chars): probably rendered by JavaScript; use browser_goto if it matters`;
  return `${p.chars.toLocaleString()} chars${p.condensed ? ", condensed" : ""}${p.cached ? ", cached" : ""}${p.how === "pdf" ? ", PDF" : ""}`;
}

function pageBody(p: PageRead): string {
  if (p.how === "error" || p.how === "blocked") return "";
  return p.text;
}

/** One page as the model reads it; the first line is what survives stubbing. */
export function formatPage(p: PageRead, budget: { used: number; limit: number }): string {
  return [`fetch_page: ${p.title || p.finalUrl} — ${p.finalUrl} (${p.published ? `${p.published}, ` : ""}${pageState(p)}); pages read this task: ${budget.used}/${budget.limit}`, pageBody(p)].filter(Boolean).join("\n");
}

/** What is kept of an old search or page result once the model has acted on it: the header and the `[n]` lines with their URLs. */
export function stubSearchResult(content: string): string {
  const lines = content.split("\n");
  const kept = lines.filter((l, i) => i === 0 || /^\[\d+\] /.test(l)).slice(0, 14);
  return `${kept.join("\n")}\n... [snippets and page text trimmed; fetch_page a URL above if you need it again]`;
}
export function stubPageResult(content: string): string {
  return `${content.split("\n")[0]}\n... [page text trimmed; call fetch_page again if you need it]`;
}
