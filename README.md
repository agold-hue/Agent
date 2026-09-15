# Secretary (multi-tenant service, any model provider)

A subscription service where each customer gets their own AI secretary: chat and email front doors, a memory that never forgets, a persistent hosted browser with their own logins, outbound email under their name, projects that run for weeks, proactive follow-ups, and approval gates before anything big. The agent loop runs on our servers against any OpenAI-compatible model provider, so each task can use the cheapest model that can do it: DeepSeek, Gemini, Claude, GPT, through one OpenRouter key or direct provider endpoints.

```
customer ──chat──▶ app.html ──▶ api/chat/*  ─┐
customer ──email─▶ <slug>@MAIL_DOMAIN ─▶ api/mail-inbound ─┴─▶ agent_sessions row (messages, model, lease)
                                                                    │  api/run: the loop (lib/runtime.ts), resumable across invocations
                                                                    │   model: lib/llm.ts → OpenRouter / DeepSeek / Gemini (tiers in lib/router.ts)
                                                                    │   tools: browser over CDP (Browserbase), memory (Postgres), vault login,
                                                                    │          send_email, checkpoint, ask_user, schedule_follow_up, calendar/inbox/drive
customer ◀── chat (polling) / email ◀───────────────────────────────┘
api/cron (every minute): resume stalled sessions, timers and watches, digests, daily and weekly reviews, mail triage
api/stripe-webhook: subscription status → access
```

## Models and cost

Three tiers, each any model id the provider accepts (`MODEL_CHAT`, `MODEL_TASK`, `MODEL_HARD`, optional per-plan overrides). The router picks a tier from the request; the agent can `escalate_model` when a site or a support agent defeats it. Defaults favour attention over price: Gemini Flash for chat, Claude Sonnet for browser work and documents, Claude Opus for refunds, negotiations, bills and accounts (the cheaper older defaults are listed in `.env.example`). On OpenRouter every request asks for the cheapest healthy provider of the chosen model with fallbacks (`LLM_SORT=throughput` or `latency` to favour speed over price). A tier may list several models (`MODEL_TASK=google/gemini-3.8-flash,deepseek/deepseek-chat`): OpenRouter answers from the next one when the first is down or rate-limited. `openrouter/auto` lets OpenRouter pick the model per request; it optimises for quality, not price, so the tiers stay the way to control cost. Every model OpenRouter serves is usable: `GET /api/models` lists them with live prices and whether they can call tools (required) and read images, and pricing for any id comes from that catalog, so no table needs editing. On OpenRouter each tier also gets an automatic fallback chain: the catalog models closest to the configured one in price and capability (tool-capable, one per vendor, image-capable when the primary is) and finally `openrouter/auto`, so an outage, a rate limit or a mistyped id never leaves a task without a model (`LLM_AUTO_FALLBACK=off` to disable). A chat conversation is re-routed on every message: "update?" runs on the chat tier, the next "how much is an Uber to JFK" moves the same conversation up to the task tier.

Cost is taken from the provider's own usage report when it sends one (OpenRouter does), otherwise computed from a price table (`lib/llm.ts`, extend with `MODEL_PRICES`) with cached input discounted per model family. It is recorded per session and per customer per month, with the month's cache hit rate on `/api/me`.

**Prompt caching.** On Claude models the client places two cache breakpoints (after the system prompt, which also covers the tool definitions, and on the newest message), so each step of a long task re-reads the conversation from cache at a tenth of the price. Gemini, DeepSeek and OpenAI cache stable prefixes without markers. Context compaction drops to 60% of the budget in one pass so the prefix then stays stable for many steps. `PROMPT_CACHE=off` disables the markers. `SESSION_BUDGET_USD` caps a task; `PLAN_CAP_USD_<PLAN>` caps a customer's month. Context is kept under `CONTEXT_TOKEN_BUDGET` by trimming old tool output, so long browser tasks do not balloon.

Screenshots go to the model only if it can see images (`VISION_MODELS`); otherwise the agent works from text snapshots, which is the cheap default anyway.

## What's in the box

| Area | Where | Notes |
| --- | --- | --- |
| Agent loop | `lib/runtime.ts`, `api/run.ts` | Runs ~4 minutes per invocation, persists after every turn, re-kicks itself; lease prevents double runs; cron resumes stalls. Budgets are per task (`MAX_TURNS_PER_TASK`, `TASK_TIME_LIMIT_MINUTES`); a stopped task ends with a model-written summary of where it got to; a loop guard catches a model repeating the same step or cycle (`LOOP_LIMIT`), escalates once, then stops |
| Provider client | `lib/llm.ts` | Plain fetch to `/chat/completions` with tools; retries; usage → cost |
| Router | `lib/router.ts` | Tier heuristics, per-plan model overrides, escalation |
| Tools | `lib/agent-config.ts`, `lib/tools.ts`, `lib/browser-tools.ts` | All server-side; the model never sees a password |
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
| Parallel tasks | `server/routes/chat/send.ts`, `lib/chat.ts` | A request sent while the chat is busy (or prefixed "also:") runs as its own `task` session with its own budget and browser, up to `PARALLEL_TASKS` at once; its request and result show in the chat tagged with the task, questions it asks show as cards, and the page shows a strip of what each task is doing |
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

`npm run typecheck` and `npm test` (unit tests for the loop's pure parts: budgets, loop detection, nudges, code detection, chat rendering). Edit `agent/system-prompt.md`, tools in `lib/agent-config.ts`, playbooks in `agent/memory-seed/playbooks/`.

### Shipping changes to existing customers

Everything is shared and takes effect for every customer on the next deploy: code, tools, the system prompt, the web app, and the playbooks (served live from `agent/memory-seed/playbooks/`; a customer's own notes are stored separately and appended on read). Schema changes go in `db/schema.sql` as idempotent statements and are applied with `npm run db:migrate` before the deploy. The only files that do not update in place are the per-customer data templates (`profile.md`, `contacts.md`, `renewals.md`, ...), copied once at signup and owned by the customer from then on; a new template file is only picked up by new customers, so if an existing customer needs it, add it with a one-off script against the `memories` table.

## Known limits

- Cheap models are less reliable at long browser tasks and tool discipline; the escalation path and the hard tier exist for that reason. Measure cost per completed task, not per request, before lowering tiers further.
- No file generation (PDF forms, spreadsheets) without a sandbox; text and CSV via Drive only.
- No SMS/WhatsApp in, no phone calls out, no native push. Voice is voice notes (server transcription) and browser dictation; no spoken replies yet.
