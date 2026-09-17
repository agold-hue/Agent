import assert from "node:assert/strict";
import { test } from "node:test";
import { fetchBudget } from "../lib/research.js";
import { isLookupQuestion } from "../lib/router.js";
import { compacted, READ_ONLY_TOOLS, stubToolResult } from "../lib/runtime.js";
import { passes, summarize } from "../lib/search-eval.js";
import { canonicalUrl, condensePage, decodeEntities, extractMain, fetchPage, formatPage, formatSearch, isoDate, localeFor, parseDuckDuckGo, rerank, searchTtlMs, stubPageResult, stubSearchResult, tierOf, type SearchHit, type SearchOutcome } from "../lib/search.js";
import type { ChatMessage } from "../lib/llm.js";

const hit = (url: string, title = url, snippet = "", rank = 0): SearchHit => ({ title, url, domain: "", snippet, tier: 3, rank, engine: "test" });

test("canonicalUrl: tracking parameters, AMP and mobile variants, fragments and trailing slashes collapse to one URL", () => {
  assert.equal(canonicalUrl("http://www.example.com/a/b/?utm_source=x&gclid=1&id=7#top"), "https://example.com/a/b?id=7");
  assert.equal(canonicalUrl("https://m.example.com/story/amp/"), canonicalUrl("https://www.example.com/story/"));
  assert.equal(canonicalUrl("https://example.com/story?output=amp"), "https://example.com/story");
  assert.equal(canonicalUrl("https://example.com/"), "https://example.com/");
  assert.equal(canonicalUrl("not a url"), "not a url");
});

test("tierOf: official records first, the company's own site next, forums for experiences, aggregators last", () => {
  assert.equal(tierOf("https://www.irs.gov/help", "irs phone number"), 0);
  assert.equal(tierOf("https://help.uber.com/riders", "uber fare estimate jfk"), 1);
  assert.equal(tierOf("https://en.wikipedia.org/wiki/X", "brooklyn bridge length"), 2);
  assert.equal(tierOf("https://www.reddit.com/r/nyc/x", "metro north schedule"), 3.5);
  assert.equal(tierOf("https://www.reddit.com/r/nyc/x", "is the r/nyc plumber any good reviews"), 2.5);
  assert.equal(tierOf("https://www.pinterest.com/pin/1", "kitchen ideas"), 5);
  assert.equal(tierOf("https://someblog.net/post", "anything"), 3);
});

test("rerank: one entry per canonical URL, tiers before positions, two per domain unless the query used site:", () => {
  const a = [hit("https://www.pinterest.com/p/1", "pin", "", 0), hit("https://example.com/x?utm_source=a", "ex", "short", 1), hit("https://irs.gov/help", "irs", "", 2)];
  const b = [hit("https://example.com/x", "ex", "a longer snippet from the second query", 0), hit("https://example.com/y", "", "", 1), hit("https://example.com/z", "", "", 2)];
  const out = rerank([{ query: "irs help", hits: a }, { query: "irs help phone", hits: b }]);
  // Official first, then the two best from example.com (the third is capped), the demoted aggregator last.
  assert.deepEqual(out.map((h) => h.url), ["https://irs.gov/help", "https://example.com/x", "https://example.com/y", "https://pinterest.com/p/1"]);
  assert.equal(out[1].snippet, "a longer snippet from the second query");
  assert.equal(out.filter((h) => h.domain === "example.com").length, 2);
  const site = rerank([{ query: "fees site:example.com", hits: b }]);
  assert.equal(site.length, 3);
});

test("parseDuckDuckGo: HTML and Lite result markup, redirect links unwrapped, snippets attached", () => {
  const html = `<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.usps.com%2Fship%2F&amp;rut=abc">USPS <b>Priority</b> Mail</a>
    <a class="result__snippet" href="x">Up to <b>70 lbs</b> per package.</a></div>
    <div class="result"><a class="result__a" href="https://example.org/page">Example</a><a class="result__snippet">Second</a></div>`;
  const hits = parseDuckDuckGo(html);
  assert.equal(hits.length, 2);
  assert.equal(hits[0].url, "https://www.usps.com/ship/");
  assert.equal(hits[0].title, "USPS Priority Mail");
  assert.equal(hits[0].snippet, "Up to 70 lbs per package.");
  const lite = `<tr><td><a rel="nofollow" href="https://a.com/1" class="result-link">One</a></td></tr><tr><td class="result-snippet">Snippet one</td></tr>`;
  assert.deepEqual(parseDuckDuckGo(lite).map((h) => [h.url, h.snippet]), [["https://a.com/1", "Snippet one"]]);
  assert.equal(parseDuckDuckGo("<html><body>Please verify you are not a bot</body></html>").length, 0);
});

test("extractMain: scripts, navigation, footers and hidden chrome are dropped; the article is preferred; title and date are read", () => {
  const html = `<html><head><title>Fees &amp; Hours | City DMV</title>
    <meta property="article:published_time" content="2025-03-02T10:00:00Z"><link rel="canonical" href="https://dmv.example.gov/fees"></head>
    <body><nav><a href="/">Home</a><a href="/x">Menu item one</a></nav><header class="site-header">Header stuff</header>
    <div class="cookie-banner">We use cookies. Accept all.</div>
    <article><h1>Fees and hours</h1><p>The office is open 8:30&nbsp;am to 4:00 pm, Monday to Friday.</p>
    <p>${"A renewal costs $64.50 and takes about ten minutes at the counter. ".repeat(12)}</p>
    <script>trackEverything();</script><style>.x{}</style><div style="display:none">hidden text</div></article>
    <aside class="related">Related stories</aside><footer>Copyright</footer></body></html>`;
  const m = extractMain(html);
  assert.equal(m.title, "Fees & Hours | City DMV");
  assert.equal(m.published, "2025-03-02");
  assert.equal(m.canonical, "https://dmv.example.gov/fees");
  assert.match(m.text, /open 8:30 am to 4:00 pm/);
  assert.match(m.text, /\$64\.50/);
  for (const gone of ["Menu item one", "Header stuff", "cookies", "trackEverything", "hidden text", "Related stories", "Copyright"]) assert.ok(!m.text.includes(gone), `${gone} should be dropped`);
  // A page without an article container falls back to the whole body.
  assert.match(extractMain("<html><body><div><p>Just a short page.</p></div></body></html>").text, /Just a short page/);
});

test("decodeEntities and isoDate", () => {
  assert.equal(decodeEntities("Tom &amp; Jerry &#39;s &#x263A; caf&eacute;"), "Tom & Jerry 's ☺ caf&eacute;");
  assert.equal(isoDate("2024-05-06T12:00:00Z"), "2024-05-06");
  assert.equal(isoDate("May 6, 2024"), "2024-05-06");
  assert.equal(isoDate("nonsense"), undefined);
  const twoDaysAgo = isoDate("2 days ago")!;
  assert.ok(Date.now() - new Date(twoDaysAgo).getTime() < 3.1 * 86_400_000);
});

test("cache TTL: fresh queries expire in minutes, evergreen ones in a day", () => {
  assert.equal(searchTtlMs("day"), 20 * 60_000);
  assert.equal(searchTtlMs("week"), 3 * 3_600_000);
  assert.equal(searchTtlMs(undefined), 24 * 3_600_000);
});

test("localeFor: country from settings or the time zone, city as the local hint", () => {
  assert.deepEqual(localeFor({ timezone: "America/New_York", settings: {} }), { country: "US", lang: "en", near: undefined });
  assert.equal(localeFor({ timezone: "Europe/London", settings: {} }).country, "GB");
  assert.equal(localeFor({ timezone: "America/Toronto", settings: {} }).country, "CA");
  assert.deepEqual(localeFor({ timezone: "America/Chicago", settings: { country: "us", city: "Brooklyn, NY" } }), { country: "US", lang: "en", near: "Brooklyn, NY" });
});

test("fetchPage refuses private and non-http targets without touching the network", async () => {
  assert.equal((await fetchPage("http://localhost:3000/admin")).error, "only public http(s) pages can be read");
  assert.equal((await fetchPage("http://192.168.1.1/")).error, "only public http(s) pages can be read");
  assert.equal((await fetchPage("http://172.20.0.5/x")).error, "only public http(s) pages can be read");
  assert.equal((await fetchPage("ftp://example.com/x")).error, "only public http(s) pages can be read");
  assert.equal((await fetchPage("nope")).error, "not a valid URL");
});

test("condensePage without a model cuts a long page and says how much is left", async () => {
  const long = { url: "https://a.com", finalUrl: "https://a.com", title: "A", text: "x".repeat(20_000), chars: 20_000, how: "html" as const };
  const out = await condensePage(long, {});
  assert.ok(out.text.length < 7200);
  assert.match(out.text, /13,000 more characters/);
  const short = { ...long, text: "short", chars: 5 };
  assert.equal((await condensePage(short, {})).text, "short");
});

const RECENT = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const outcome: SearchOutcome = {
  queries: ["usps priority mail max weight", "priority mail weight limit"],
  engine: "brave",
  ms: 812,
  cached: false,
  errors: [],
  hits: [
    { title: "Priority Mail", url: "https://usps.com/ship/priority-mail.htm", domain: "usps.com", snippet: "Up to 70 lbs.", published: RECENT, tier: 0, rank: 0, engine: "brave" },
    { title: "Shipping weights", url: "https://blog.example.com/weights", domain: "blog.example.com", snippet: "A very long snippet " + "x".repeat(300), published: "2019-01-01", tier: 3, rank: 1, engine: "brave" },
  ],
  pages: [
    { url: "https://usps.com/ship/priority-mail.htm", finalUrl: "https://usps.com/ship/priority-mail.htm", title: "Priority Mail", published: RECENT, text: "Priority Mail packages may weigh up to 70 lbs.", chars: 46, how: "html" },
    { url: "https://blog.example.com/weights", finalUrl: "https://blog.example.com/weights", title: "", text: "", chars: 0, how: "blocked", error: "HTTP 403" },
  ],
};

test("formatSearch: one [n] line per result with URL, domain, date and tier; old time-sensitive results flagged; blocked pages say so", () => {
  const text = formatSearch(outcome, { used: 1, limit: 12 });
  assert.match(text, /^web_search: 2 queries, 2 results \(brave, 0\.8s\); pages read this task: 1\/12/);
  assert.match(text, new RegExp(`\\[1\\] Priority Mail — https://usps\\.com/ship/priority-mail\\.htm \\(usps\\.com, ${RECENT}, official\\)`));
  assert.match(text, /\[2\] .*old: verify before repeating/);
  assert.match(text, /--- page \[1\] Priority Mail .*46 chars\) ---\nPriority Mail packages may weigh up to 70 lbs\./);
  assert.match(text, /--- page \[2\] .*blocked the plain fetch \(HTTP 403\): use browser_goto/);
  assert.match(text, /1 of the top 2 pages read \(1 distinct domain\)/);
  const none = formatSearch({ ...outcome, hits: [], pages: [], errors: ["brave 429: rate limited", "duckduckgo blocked the request (bot check)"] }, { used: 0, limit: 12 });
  assert.match(none, /No results\. Engines: brave 429/);
  assert.ok(!/Please verify/.test(none));
});

test("stubs: a search keeps its header and [n] lines; a page keeps its header line; other tools keep 240 chars", () => {
  const text = formatSearch(outcome, { used: 1, limit: 12 });
  const stub = stubSearchResult(text);
  assert.match(stub, /^web_search: 2 queries/);
  assert.match(stub, /\[1\] Priority Mail — https:\/\/usps\.com/);
  assert.ok(!stub.includes("Up to 70 lbs."), "snippets are dropped");
  assert.ok(!stub.includes("--- page"), "page text is dropped");
  assert.equal(stubToolResult("web_search", text), stub);
  const page = formatPage(outcome.pages[0], { used: 2, limit: 12 });
  assert.equal(stubPageResult(page).split("\n")[0], page.split("\n")[0]);
  assert.equal(stubToolResult("fetch_page", page), stubPageResult(page));
  assert.ok(stubToolResult("browser_snapshot", "y".repeat(1000)).startsWith("y".repeat(240)));
});

test("compacted: an old web_search result shrinks to its [n] lines, not to a blind 240-character cut", () => {
  const text = formatSearch(outcome, { used: 1, limit: 12 });
  const messages: ChatMessage[] = [{ role: "system", content: "s" }, { role: "user", content: "[2026-09-15 Tue 03:10 America/New_York via chat]\nfind the weight limit" }];
  messages.push({ role: "assistant", content: null, tool_calls: [{ id: "s1", type: "function", function: { name: "web_search", arguments: "{}" } }] }, { role: "tool", tool_call_id: "s1", content: text });
  for (let i = 0; i < 11; i++) messages.push({ role: "assistant", content: null, tool_calls: [{ id: `b${i}`, type: "function", function: { name: "browser_snapshot", arguments: "{}" } }] }, { role: "tool", tool_call_id: `b${i}`, content: "z".repeat(600) });
  const out = compacted(messages);
  const search = out.find((m) => m.tool_call_id === "s1")!;
  assert.match(search.content as string, /\[2\] Shipping weights — https:\/\/blog\.example\.com\/weights/);
  assert.ok(!(search.content as string).includes("Up to 70 lbs."));
});

test("fetchBudget: counts from the latest result header in this task and grows with approved research checkpoints", () => {
  const user = (text: string): ChatMessage => ({ role: "user", content: `[2026-09-15 Tue 03:10 America/New_York via chat]\n${text}` });
  const call = (id: string, name: string, args = "{}"): ChatMessage => ({ role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] });
  const result = (id: string, content: string): ChatMessage => ({ role: "tool", tool_call_id: id, content });
  const messages: ChatMessage[] = [
    { role: "system", content: "" },
    user("earlier task"),
    call("a", "web_search"),
    result("a", "web_search: 1 query, 5 results (brave, 0.5s); pages read this task: 9/12\n[1] x"),
    user("new task"),
    call("b", "web_search"),
    result("b", "web_search: 1 query, 5 results (brave, 0.5s); pages read this task: 2/12\n[1] x"),
    call("c", "fetch_page"),
    result("c", "fetch_page: Title — https://a.com (200 chars); pages read this task: 3/12\ntext"),
  ];
  assert.deepEqual(fetchBudget({ messages }), { used: 3, limit: 12 });
  messages.push(call("d", "checkpoint", JSON.stringify({ action_type: "other", summary: "Read up to 12 more pages: comparing three more insurers" })), result("d", "APPROVED by the user. Proceed exactly as described in the checkpoint."));
  assert.deepEqual(fetchBudget({ messages }), { used: 3, limit: 24 });
  messages.push(call("e", "checkpoint", JSON.stringify({ action_type: "purchase", summary: "Buy the filter for $24" })), result("e", "APPROVED (auto). Proceed."));
  assert.equal(fetchBudget({ messages }).limit, 24, "a purchase approval is not a research approval");
});

test("isLookupQuestion: plain factual questions yes; the user's own things, actions, small talk and questions about the agent no", () => {
  const stamp = (s: string) => `[2026-09-15 Tue 03:10 America/New_York via chat]\n${s}`;
  for (const yes of ["what time does Costco in Brooklyn close today", "how much is a Metro-North ticket from Grand Central to White Plains", "is the DMV open on Saturday", "who won the Mets game last night", "what's the phone number for Con Edison", "can you tell me what the sales tax is in Pennsylvania", "when does daylight saving time end this year", "who's mayor in nyc", "who is the mayor of New York", "what's the capital of Australia"]) {
    assert.ok(isLookupQuestion(stamp(yes)), yes);
  }
  for (const no of ["check my Con Ed bill", "order more paper towels", "how much did I spend on Amazon last month", "what's on my calendar tomorrow", "what's up", "how are you", "is it done yet", "what did you find", "yes", "what time does Costco close\nand order milk", "hmm really", "book a table for two at 7", "what time is it", "what day is it today", "what's today's date"]) {
    assert.ok(!isLookupQuestion(stamp(no)), no);
  }
});

test("READ_ONLY_TOOLS holds only tools without side effects", () => {
  for (const name of ["web_search", "fetch_page", "memory_read", "memory_grep", "memory_list", "list_items"]) assert.ok(READ_ONLY_TOOLS.has(name), name);
  for (const name of ["browser_click", "browser_goto", "checkpoint", "send_email", "memory_write", "track_item", "login", "ask_user"]) assert.ok(!READ_ONLY_TOOLS.has(name), name);
});

test("golden set scoring: any expectation may match; the summary carries the rate and cost per success", () => {
  assert.ok(passes("Up to 70 lbs per package (source: usps.com)", ["70\\s*(lb|pound)"]));
  assert.ok(!passes(undefined, ["x"]));
  assert.ok(!passes("Call 1-800-555-0100", ["800[-. ]829[-. ]1040"]));
  const s = summarize("r", [
    { question: "a", expected: "", answer: "x", ok: true, ms: 1000, costCents: 0.2, pages: 3, engine: "brave" },
    { question: "b", expected: "", answer: undefined, ok: false, ms: 3000, costCents: 0.1, pages: 3, engine: "brave" },
    { question: "c", expected: "", answer: "y", ok: true, ms: 2000, costCents: 0.3, pages: 2, engine: "brave" },
  ]);
  assert.equal(s.total, 3);
  assert.equal(s.ok, 2);
  assert.equal(Math.round(s.rate * 100), 67);
  assert.equal(s.median_ms, 2000);
  assert.equal(s.cost_cents, 0.6);
  assert.equal(s.cost_per_success_cents, 0.3);
  assert.equal(s.pages_per_question, 2.7);
});

import { loadGolden } from "../lib/search-eval.js";
test("the golden set has 50 questions and every expectation compiles", () => {
  const items = loadGolden();
  assert.equal(items.length, 50);
  for (const i of items) for (const re of i.expect) assert.doesNotThrow(() => new RegExp(re, "i"), `${i.q}: ${re}`);
  assert.equal(new Set(items.map((i) => i.q)).size, 50, "no duplicate questions");
});

import { arrivedMidTask } from "../lib/runtime.js";
test("arrivedMidTask: a question that lands during browser work stays inside that task", () => {
  const user = (text: string): ChatMessage => ({ role: "user", content: `[2026-09-15 Tue 03:10 America/New_York via chat]\n${text}` });
  const call: ChatMessage = { role: "assistant", content: null, tool_calls: [{ id: "c", type: "function", function: { name: "browser_click", arguments: "{}" } }] };
  assert.equal(arrivedMidTask([{ role: "system", content: "" }, user("pay the con ed bill"), call, { role: "tool", tool_call_id: "c", content: "ok" }, user("what time does costco close")]), true);
  assert.equal(arrivedMidTask([{ role: "system", content: "" }, user("pay the con ed bill"), { role: "assistant", content: "Paid, $84.20." }, user("what time does costco close")]), false);
  assert.equal(arrivedMidTask([{ role: "system", content: "" }, user("what time does costco close"), { role: "user", content: "(That message arrived while you are mid-task. ...)" }]), true);
});
