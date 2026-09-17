import { config } from "./config.js";
import { htmlToText } from "./mail/imap.js";

/** Search without a browser: Serper (Google) when a key is set, otherwise DuckDuckGo's HTML endpoint. */
export async function webSearch(query: string, count = 8): Promise<string> {
  const key = config.search.serperKey();
  if (key) {
    const r = await fetch("https://google.serper.dev/search", { method: "POST", headers: { "X-API-KEY": key, "Content-Type": "application/json" }, body: JSON.stringify({ q: query, num: count }), signal: AbortSignal.timeout(15_000) });
    if (!r.ok) throw new Error(`search failed: HTTP ${r.status}`);
    const j = (await r.json()) as { organic?: Array<{ title: string; link: string; snippet?: string }>; answerBox?: { answer?: string; snippet?: string } };
    const lines = (j.organic ?? []).slice(0, count).map((o, i) => `${i + 1}. ${o.title}\n   ${o.link}\n   ${o.snippet ?? ""}`);
    const box = j.answerBox?.answer || j.answerBox?.snippet;
    return (box ? `Answer box: ${box}\n\n` : "") + (lines.join("\n") || "No results.");
  }
  const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36" }, signal: AbortSignal.timeout(15_000) });
  const html = await r.text();
  const out: string[] = [];
  const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < count) {
    let href = m[1];
    const u = href.match(/uddg=([^&]+)/);
    if (u) href = decodeURIComponent(u[1]);
    out.push(`${out.length + 1}. ${htmlToText(m[2])}\n   ${href}\n   ${htmlToText(m[3] ?? "")}`);
  }
  return out.join("\n") || "No results.";
}

/** Fetch a page as text (no JavaScript). */
export async function webFetch(url: string, maxChars = 15_000): Promise<string> {
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36", Accept: "text/html,application/json,text/plain,*/*" }, redirect: "follow", signal: AbortSignal.timeout(20_000) });
  const type = r.headers.get("content-type") ?? "";
  const raw = await r.text();
  const text = /html/.test(type) ? htmlToText(raw.replace(/<head[\s\S]*?<\/head>/i, "")) : raw;
  const head = `HTTP ${r.status} ${type.split(";")[0]} (${text.length} chars)\n\n`;
  return head + (text.length > maxChars ? text.slice(0, maxChars) + `\n... (${text.length - maxChars} more characters)` : text);
}
