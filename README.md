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

Three tiers, each any model id the provider accepts (`MODEL_CHAT`, `MODEL_TASK`, `MODEL_HARD`, optional per-plan overrides). The router picks a tier from the request; the agent can `escalate_model` when a site or a support agent defeats it. Defaults are cheap-first: a Gemini Flash-Lite class model for chat, a Gemini Flash class model for routine browser work, Claude Sonnet for refunds, negotiations and projects. On OpenRouter every request asks for the cheapest healthy provider of the chosen model with fallbacks.

Cost is computed per call from a price table (`lib/llm.ts`, extend with `MODEL_PRICES`), recorded per session and per customer per month. `SESSION_BUDGET_USD` caps a task; `PLAN_CAP_USD_<PLAN>` caps a customer's month. Context is kept under `CONTEXT_TOKEN_BUDGET` by trimming old tool output, so long browser tasks do not balloon.

Screenshots go to the model only if it can see images (`VISION_MODELS`); otherwise the agent works from text snapshots, which is the cheap default anyway.

## What's in the box

| Area | Where | Notes |
| --- | --- | --- |
| Agent loop | `lib/runtime.ts`, `api/run.ts` | Runs ~4 minutes per invocation, persists after every turn, re-kicks itself; lease prevents double runs; cron resumes stalls |
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
| Web app | `public/index.html`, `public/app.html` | Landing and login; chat, settings, logins, billing |

## Ownership boundary

This product is its own thing, so it can be run, sold, or shut down without touching anything else you operate:

- **Code**: this repository only (`agold-hue/Agent`). No shared packages, no imports from other projects.
- **Hosting**: deploy it as its own Vercel project, ideally in its own Vercel team so billing and access are separate from other sites. Nothing in `vercel.json` references another project.
- **Accounts it needs, all its own**: a Postgres database, a model-provider key (OpenRouter and/or direct providers), a Browserbase project, a Postmark server and sending domain, a Stripe account or at least a separate Stripe product, and optionally a Google OAuth client. Create each under the product's name, not under a personal or another business's account.
- **Domain**: its own domain for the app and `MAIL_DOMAIN` for agent addresses.

Keep customer data (memories, vault, mail log) in this product's database only.

## Deploy

1. **Postgres**. Set `DATABASE_URL`, run `npm run db:migrate`.
2. **Model provider**. An OpenRouter key is the simplest (`LLM_BASE_URL` default). For direct providers set `LLM_BASE_URL` to their OpenAI-compatible endpoint and use their model ids in the `MODEL_*` vars.
3. **Browserbase**: API key and project id (contexts and keepAlive on the plan).
4. **Postmark**: one server; `MAIL_DOMAIN` as a sending domain with inbound enabled; inbound webhook `https://APP_URL/api/mail-inbound?token=INBOUND_WEBHOOK_TOKEN`.
5. **Stripe**: a recurring price; webhook `https://APP_URL/api/stripe-webhook` for `customer.subscription.*` and `checkout.session.completed`. Optional `plan` metadata on prices plus `PLAN_CAP_USD_<PLAN>` and `MODEL_*_<PLAN>` env vars.
6. **Google (optional)**: OAuth client with redirect `https://APP_URL/api/google/callback` and the calendar, gmail.modify, drive.file scopes.
7. Fill `.env.example` into Vercel and deploy. The cron runs every minute (Pro plan). `api/run` and `api/cron` need the 300 s max duration set in `vercel.json`.

## How a customer uses it

Sign up with an email code, start the trial, chat at `/app.html` or email their agent address. Settings: name, time zone, approval ceiling and auto-approve types, family senders, quiet hours, check-in times, morning and weekly review, Google connect. Logins: the sites the agent may use, with optional authenticator seeds. Every purchase, payment, message to an outsider, agreement, dispute, or cancellation waits for their yes unless they loosen the rules.

## Security notes

- Passwords, TOTP seeds and Google refresh tokens are encrypted with `MASTER_KEY` and the customer id as associated data. Move `MASTER_KEY` to a KMS before scale.
- The model never sees a password. Prompt injection on a web page cannot reach the vault.
- Third-party mail and forwarded mail are marked as information, never instructions; consequential actions go through the approval gate.
- Sessions, memory, browser profiles and vaults are per customer and looked up by our database; one customer cannot reach another's.
- `api/run`, `api/cron` and the inbound route require secrets; the Stripe webhook verifies its signature.

## Developing

`npm run typecheck`. Edit `agent/system-prompt.md`, tools in `lib/agent-config.ts`, playbooks in `agent/memory-seed/playbooks/`. New seed files reach existing customers only through a migration you write against the `memories` table.

## Known limits

- Cheap models are less reliable at long browser tasks and tool discipline; the escalation path and the hard tier exist for that reason. Measure cost per completed task, not per request, before lowering tiers further.
- No file generation (PDF forms, spreadsheets) without a sandbox; text and CSV via Drive only.
- No SMS/WhatsApp in, no phone calls out, no native push. Browser dictation on the chat page is the start on voice.
