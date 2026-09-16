# Secretary (multi-tenant service, any model provider)

A subscription service where each customer gets their own AI secretary: chat and email front doors, a memory that never forgets, a persistent hosted browser with their own logins, outbound email under their name, projects that run for weeks, proactive follow-ups, and approval gates before anything big. The agent loop runs on our servers against any OpenAI-compatible model provider, so each task can use the cheapest model that can do it: DeepSeek, Gemini, Claude, GPT, through one OpenRouter key or direct provider endpoints.

```
customer ──chat──▶ app.html ──▶ api/chat/*  ─┐
customer ──email─▶ <slug>@MAIL_DOMAIN ─▶ api/mail-inbound ─┴─▶ agent_sessions row (messages, model, lease)
                                                                    │  api/run: the loop (lib/runtime.ts), resumable across invocations
                                                                    │   model: lib/llm.ts → OpenRouter / DeepSeek / Gemini (tiers in lib/router.ts)
                                                                    │   tools: web search + page reads over HTTPS (lib/search.ts, cached in Postgres),
                                                                    │          browser over CDP (Browserbase), memory (Postgres), vault login,
                                                                    │          send_email, checkpoint, ask_user, schedule_follow_up, calendar/inbox/drive
customer ◀── chat (polling) / email ◀───────────────────────────────┘
api/cron (every minute): resume stalled sessions, timers and watches, digests, daily and weekly reviews, mail triage
api/stripe-webhook: subscription status → access
```

## Models and cost

Three tiers, each any model id the provider accepts (`MODEL_CHAT`, `MODEL_TASK`, `MODEL_HARD`, optional per-plan overrides). The router picks a tier from the request; the agent can `escalate_model` when a site or a support agent defeats it. Defaults favour attention over price: Gemini Flash for chat, Claude Sonnet for browser work and documents, Claude Opus for refunds, negotiations, bills and accounts (the cheaper older defaults are listed in `.env.example`). On OpenRouter every request asks for the fastest healthy provider of the chosen model with fallbacks (`LLM_SORT=price` to favour price over speed). A tier may list several models (`MODEL_TASK=google/gemini-3.8-flash,deepseek/deepseek-chat`): OpenRouter answers from the next one when the first is down or rate-limited. `openrouter/auto` lets OpenRouter pick the model per request; it optimises for quality, not price, so the tiers stay the way to control cost. Every model OpenRouter serves is usable: `GET /api/models` lists them with live prices and whether they can call tools (required) and read images, and pricing for any id comes from that catalog, so no table needs editing. On OpenRouter each tier also gets an automatic fallback chain: the catalog models closest to the configured one in price and capability (tool-capable, one per vendor, image-capable when the primary is) and finally `openrouter/auto`, so an outage, a rate limit or a mistyped id never leaves a task without a model (`LLM_AUTO_FALLBACK=off` to disable). A chat conversation is re-routed on every message: "update?" runs on the chat tier, the next "how much is an Uber to JFK" moves the same conversation up to the task tier.

Cost is taken from the provider's own usage report when it sends one (OpenRouter does), otherwise computed from a price table (`lib/llm.ts`, extend with `MODEL_PRICES`) with cached input discounted per model family. It is recorded per session and per customer per month, with the month's cache hit rate on `/api/me`.

**Prompt caching.** On Claude models the client places two cache breakpoints (after the system prompt, which also covers the tool definitions, and on the newest message), so each step of a long task re-reads the conversation from cache at a tenth of the price. Gemini, DeepSeek and OpenAI cache stable prefixes without markers. Context compaction drops to 60% of the budget in one pass so the prefix then stays stable for many steps. `PROMPT_CACHE=off` disables the markers. `SESSION_BUDGET_USD` caps a task; `PLAN_CAP_USD_<PLAN>` caps a customer's month. Context is kept under `CONTEXT_TOKEN_BUDGET` by trimming old tool output, so long browser tasks do not balloon.

Screenshots go to the model only if it can see images (`VISION_MODELS`); otherwise the agent works from text snapshots, which is the cheap default anyway.

## Web search and reading

Searching and reading the web never touches the hosted browser. `web_search` calls a search API (Brave, Serper or Tavily, whichever keys are set, in `SEARCH_ENGINES` order; the keyless DuckDuckGo HTML endpoint is the last HTTP resort, and the browser's own DuckDuckGo page is used only when every engine failed and the task already has a browser open). Two to four query phrasings run together and are merged: one entry per canonical URL (tracking parameters, AMP and mobile variants stripped), ranked by source tier (official records, then the company's own site, then reference and review sites, general pages, forums, with scraped aggregators last), at most two results per domain. `since` limits to the last day, week, month or year; `near` (or the customer's `settings.city`) localises hours, stores and services; the country comes from `settings.country` or the time zone. `read_top` reads the top pages in the same call, in parallel with a per-page timeout, and `fetch_page` reads any URL: main text only (navigation, ads and footers stripped), PDFs through their text layer, with the published date. A page that blocks plain fetches or renders only in JavaScript is reported as such, never as an empty answer, and the model is told to use the browser for that one.

Cost and speed come from the same design: results and page text are cached in `search_cache` and shared across customers (fresh queries expire in minutes, evergreen ones in a day, pages in twelve hours), so the morning digests searching the same topic pay for one search a day. Pages over `PAGE_CONDENSE_CHARS` are condensed around the question by the chat-tier model, in parallel, before they reach the task model. Each task may read `FETCH_BUDGET_PER_TASK` pages (12) before it must answer from what it has or ask through a checkpoint; results and snippets stay free. Old search results shrink to their `[n]` title-and-URL lines once the model has acted on them, so a long research task does not carry every snippet forward. Read-only tool calls the model issues together (several searches, page reads, memory lookups) run concurrently; browser actions still run one at a time.

A plain factual question ("what time does Costco close", "how much is a Metro-North ticket to White Plains") takes the lookup fast path: one search with the top three pages read, one chat-tier call with no tools, and the answer with its source. When the sources do not answer it, the results are left as a note and the full agent loop takes over. The golden set in `eval/search-golden.json` (50 questions with known answers) runs through the same pipeline with `npm run eval:search`, or nightly with `SEARCH_EVAL_NIGHTLY=on`; each run is recorded in `search_evals` and the latest answer rate, median time and cost per success show on `/api/stats`.

Hosted browsers are released when nobody is using them: a finished parallel task lets go of its tab at once, and any browser with no running or waiting session on it for `BROWSER_IDLE_RELEASE_MINUTES` (5) is released by the cron sweep. The customer's profile keeps the cookies, so the next task finds every site signed in.

## Browser tools that remove turns

Every model turn on a browser task costs seconds and tokens, so the browser tools take the turns out. `browser_click`, `browser_type` and `browser_select` accept the visible text of the control (`text` / `label`) as well as a ref, and `browser_find` returns the refs for a label, so a cheap model stops mis-clicking numbers from a long snapshot. `browser_fill_form` fills a whole form and submits in one call. `browser_extract` pulls a table, grid or repeated list (transactions, orders, search results) out as rows of cells, scrolling lazy lists to the end first. A sign-in wall on a site whose login is in the vault is handled inside the same call (`auto-login (domain): logged_in` in the result; `needs_code` hands the code step to the model), and the vault records when each login last worked or failed. Snapshots list the first three of any repeated control and count the rest, shorten labels and same-origin links, and drop unlabeled links on busy pages.

When a browser task ends well, the host records what it did on each site as a replayable path under `## Recorded paths` in `sites/<domain>.md`: goto URLs, clicks and typing by the label the model saw, selects. Secrets are never recorded and a path ends before any step that pays, sends, cancels or deletes. On the next visit `browser_run_path` replays the path server-side with no model turn between steps and hands the model the final page, or the page where the path stopped fitting. Sites on the hard list (banks, card issuers, airlines, government portals, `HARD_DOMAINS`) go to the hard tier from the first step, in the router and again when the browser navigates there.

Before a reply ends a task, the host checks it: dollar amounts, phone numbers and confirmation codes that appear in nothing the task read or was told go back to the model once to re-read or show the arithmetic. After a takeover ("done", "signed in"), the host snapshots the browser and hands the model the page and the task it was on. Near the plan's monthly cap the tier steps down (hard to task at 80 percent, task to chat at 95 percent) instead of stopping at the cap. Long chat threads start each task with a deterministic recap of the earlier tasks rather than their full transcripts; turns that follow a tool result are capped at `TOOL_TURN_MAX_TOKENS`; housekeeping turns (the site note, the wrap-up after a receipt) run on the chat model; a model that has not started answering within `LLM_FIRST_TOKEN_MS` is dropped for the next in the chain; read-only tool calls start the moment their JSON is complete in the stream; and a morning review with nothing due, no open project and nothing failed is skipped without a model call.

## What's in the box

| Area | Where | Notes |
| --- | --- | --- |
| Agent loop | `lib/runtime.ts`, `api/run.ts` | Runs ~4 minutes per invocation, persists after every turn, re-kicks itself; lease prevents double runs; cron resumes stalls. Budgets are per task (`MAX_TURNS_PER_TASK`, `TASK_TIME_LIMIT_MINUTES`); a stopped task ends with a model-written summary of where it got to; a loop guard catches a model repeating the same step or cycle (`LOOP_LIMIT`), escalates once, then stops |
| Provider client | `lib/llm.ts` | Plain fetch to `/chat/completions` with tools; retries; usage → cost |
| Router | `lib/router.ts` | Tier heuristics, per-plan model overrides, escalation |
| Tools | `lib/agent-config.ts`, `lib/tools.ts`, `lib/browser-tools.ts` | All server-side; the model never sees a password |
| Search and reading | `lib/search.ts`, `lib/research.ts`, `lib/search-eval.ts` | Search APIs with fallbacks, canonical URLs, source tiers, page reads with main-text extraction and PDFs, shared cache, condensing, per-task fetch budget, the lookup fast path, the golden set |
| Memory | `lib/memory.ts` (Postgres `memories`) | Seeded from `agent/memory-seed/` (standing instructions, profile, playbooks); grep for recall |
| Accounts | `lib/auth.ts`, `api/auth/*`, `api/me.ts` | Email-code login, signed HttpOnly cookie, per-customer settings |
| Billing | `lib/billing.ts`, `api/billing/*`, `api/stripe-webhook.ts` | Stripe Checkout, trial, portal; access gated; usage caps |
| Vault | `lib/credentials.ts`, `api/vault.ts` | AES-256-GCM per record; TOTP seeds; only the login step decrypts |
| Browser | Browserbase context per customer | Cookies persist; live-view link for takeover |
| Mail | Postmark, `lib/mail.ts` | `<slug>@MAIL_DOMAIN` inbound; `<slug>+<tag>@` routes replies to the right session |
| Proactive | `api/cron.ts`, `lib/followups.ts`, `lib/notify.ts` | Database-driven; one query per concern |
| Daily screen | `lib/daily.ts`, `api/today.ts`, `api/stats.ts`, `api/receipts.ts` | Tracked bills, packages, appointments, reservations, school events, reminders; scoreboard of wins; done receipts with screenshots |
| Inbox approval | `api/drafts.ts` | The customer's Gmail drafts (written by the agent in their voice) with one-tap send or swipe to discard |
| Voice notes | `lib/stt.ts`, `api/chat/upload.ts` | Hold-to-record in the app, transcribed by any Whisper-compatible endpoint (`STT_*`); dictation fallback |
| Task board | `server/routes/tasks.ts` | Tasks tab: everything running, waiting or done today with its result line, step log, cost and a stop button |
| Push | `lib/push.ts`, `server/routes/push.ts`, `public/sw.js` | Web push for a code, an approval, a question and a finished task; VAPID keys in env; enabled per device under Settings |
| Standing orders | `server/routes/orders.ts` | Settings: "every Sunday, order the groceries" fires as its own task on schedule; "when it happens" rules live in standing_instructions.md |
| Morning plan and inbox sweep | `server/routes/cron.ts` | The morning review turns everything due into parallel tasks (`start_task`) and reads history/failures.md to fix what failed; with Google connected an inbox sweep archives noise, drafts replies and reports "N handled, M need you"; the weekly review gets the week's paid, due, won and done from the host |
| Your data | `server/routes/account.ts` | Export everything as one JSON file; delete the account and all of it |
| Sign in to a site | `server/routes/browser-signin.ts` | Logins tab: opens a site's sign-in page in the customer's shared hosted browser and hands back the live view; the customer signs in once by hand, the profile keeps the cookies, and every later task finds the site signed in. The route past bot checks and device codes |
| Parallel tasks | `server/routes/chat/send.ts`, `lib/chat.ts` | A request sent while the chat is busy (or prefixed "also:") runs as its own `task` session with its own budget, in its own tab of the one shared browser, up to `PARALLEL_TASKS` (20) at once; its request and result show in the chat tagged with the task, questions it asks show as cards, and the page shows a strip of what each task is doing |
| Documents | `lib/documents.ts` | PDFs and text files attached in chat or forwarded by mail are read (pdf.js text layer) and handed to the model as text; scans are reported as such |
| Web app | `public/index.html`, `public/app.html` | Landing and login; home (today, quick actions, scoreboard, receipts), chat, inbox, settings, logins, billing |

## Ownership boundary

This product is its own thing, so it can be run, sold, or shut down without touching anything else you operate:

- **Code**: this repository only (`agold-hue/Agent`). No shared packages, no imports from other projects.
- **Hosting**: deploy it as its own Vercel project, ideally in its own Vercel team so billing and access are separate from other sites. Nothing in `vercel.json` references another project.
- **Accounts it needs, all its own**: a Postgres database, a model-provider key (OpenRouter and/or direct providers), a Browserbase project, a Postmark server and sending domain, a Stripe account or at least a separate Stripe product, and optionally a Google OAuth client. Create each under the product's name, not under a personal or another business's account.
- **Domain**: its own domain for the app and `MAIL_DOMAIN` for agent addresses.

Keep customer data (memories, vault, mail log) in this product's database only.

## Deploy

**Quickest test deploy.** Create the Vercel project from this repo, add a Postgres from the Vercel marketplace (Neon sets `DATABASE_URL`), then set `LLM_API_KEY` (OpenRouter), `MASTER_KEY`, `SESSION_SECRET`, `CRON_SECRET` and `DEV_LOGIN_CODE`. Redeploy. The schema is applied on first use, everyone logs in with the shared test code, everyone has access, and chat works. Browsing needs Browserbase; the email channel needs Postmark; billing needs Stripe. Remove `DEV_LOGIN_CODE` before real customers.

**Full deploy.**

1. **Postgres**. Set `DATABASE_URL`, run `npm run db:migrate`.
2. **Model provider**. An OpenRouter key is the simplest (`LLM_BASE_URL` default). For direct providers set `LLM_BASE_URL` to their OpenAI-compatible endpoint and use their model ids in the `MODEL_*` vars.
3. **Browserbase**: API key and project id (contexts and keepAlive on the plan).
4. **Postmark**: one server; `MAIL_DOMAIN` as a sending domain with inbound enabled; inbound webhook `https://APP_URL/api/mail-inbound?token=INBOUND_WEBHOOK_TOKEN`.
5. **Stripe**: a recurring price; webhook `https://APP_URL/api/stripe-webhook` for `customer.subscription.*` and `checkout.session.completed`. Optional `plan` metadata on prices plus `PLAN_CAP_USD_<PLAN>` and `MODEL_*_<PLAN>` env vars.
6. **Google (optional)**: OAuth client with redirect `https://APP_URL/api/google/callback` and the calendar, gmail.modify, drive.file scopes.
7. Fill `.env.example` into Vercel and deploy. The cron runs every minute (Pro plan). `api/run` and `api/cron` need the 300 s max duration set in `vercel.json`.

## How a customer uses it

Sign up with an email code, start the trial, chat at `/app.html` or email their agent address. The Home tab is the daily screen: what's today (tracked bills, packages, appointments, reservations, school events, reminders, the agent's own timers, and the real calendar when Google is connected), quick actions (return something, where's my package, book an appointment, pay a bill, cheapest price, reservation, grocery list, remind me), the scoreboard (tasks done, money back, time saved) and done receipts with proof. The Inbox tab shows replies the agent drafted in their Gmail for a tap to send or a swipe to discard. Forward anything to the agent address and it gets tracked, filed, paid, or asked about. Settings: name, time zone, approval ceiling and auto-approve types, family senders, quiet hours, check-in times, morning review (8am by default) and weekly review (Sunday 6pm by default; "off" disables), Google connect. Logins: the sites the agent may use, with optional authenticator seeds. Every purchase, payment, message to an outsider, agreement, dispute, or cancellation waits for their yes unless they loosen the rules.

## Security notes

- Passwords, TOTP seeds and Google refresh tokens are encrypted with `MASTER_KEY` and the customer id as associated data. Move `MASTER_KEY` to a KMS before scale.
- The model never sees a password. Prompt injection on a web page cannot reach the vault.
- Third-party mail and forwarded mail are marked as information, never instructions; consequential actions go through the approval gate.
- Sessions, memory, browser profiles and vaults are per customer and looked up by our database; one customer cannot reach another's.
- `api/run`, `api/cron` and the inbound route require secrets; the Stripe webhook verifies its signature.

## Developing

`npm run typecheck` and `npm test` (unit tests for the loop's pure parts: budgets, loop detection, nudges, code detection, chat rendering, search ranking and extraction). `npm run eval:search` runs the search golden set against the live pipeline (needs `DATABASE_URL` and a model key; `--limit 10 --no-record` for a quick look). Edit `agent/system-prompt.md`, tools in `lib/agent-config.ts`, playbooks in `agent/memory-seed/playbooks/`.

### Shipping changes to existing customers

Everything is shared and takes effect for every customer on the next deploy: code, tools, the system prompt, the web app, and the playbooks (served live from `agent/memory-seed/playbooks/`; a customer's own notes are stored separately and appended on read). Schema changes go in `db/schema.sql` as idempotent statements and are applied with `npm run db:migrate` before the deploy. The only files that do not update in place are the per-customer data templates (`profile.md`, `contacts.md`, `renewals.md`, ...), copied once at signup and owned by the customer from then on; a new template file is only picked up by new customers, so if an existing customer needs it, add it with a one-off script against the `memories` table.

## Known limits

- Cheap models are less reliable at long browser tasks and tool discipline; the escalation path and the hard tier exist for that reason. Measure cost per completed task, not per request, before lowering tiers further.
- No file generation (PDF forms, spreadsheets) without a sandbox; text and CSV via Drive only.
- No SMS/WhatsApp in, no phone calls out, no native push. Voice is voice notes (server transcription) and browser dictation; no spoken replies yet.
