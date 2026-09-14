# Secretary (multi-tenant service)

A subscription service where each customer gets their own AI secretary: chat and email front doors, a memory that never forgets, a persistent hosted browser with their own logins, outbound email under their name, projects that run for weeks, proactive follow-ups, and approval gates before anything big. Built on Anthropic Managed Agents. One deployment serves every customer; nothing is tied to the operator's personal accounts.

```
customer ──chat──▶ app.html ──▶ api/chat/*  ──┐
customer ──email─▶ <slug>@MAIL_DOMAIN ─▶ api/mail-inbound ─┴─▶ Managed Agents session (per-customer memory store and browser profile)
                                                               │  custom tools run here, server-side:
                                                               │   login (vault) · send_email · checkpoint · ask_user · schedule_follow_up
                                                               │   calendar / owner_inbox / drive (customer's own Google, optional)
customer ◀── chat stream / email ◀── api/anthropic-webhook ◀───┘
api/cron (every minute): due timers and watches, digests at check-in times, daily and weekly reviews, mail triage
api/stripe-webhook: subscription status → access
```

## What's in the box

| Area | Where | Notes |
| --- | --- | --- |
| Accounts | `lib/auth.ts`, `api/auth/*`, `api/me.ts` | Email-code login, signed HttpOnly cookie, settings per customer |
| Billing | `lib/billing.ts`, `api/billing/*`, `api/stripe-webhook.ts` | Stripe Checkout, trial, customer portal; access gated on active/trialing; monthly usage cap per plan |
| Tenancy | `lib/tenant.ts`, `db/schema.sql` | One row per customer: slug, timezone, settings, memory store id, browser profile id, encrypted Google token |
| Memory | Anthropic memory store per customer | Seeded from `agent/memory-seed/` (standing instructions, profile, playbooks) on first use |
| Logins vault | `lib/credentials.ts`, `api/vault.ts` | AES-256-GCM per record with `MASTER_KEY`; TOTP seeds supported; only the login step decrypts |
| Browser | Browserbase context per customer | Cookies persist between tasks; live-view link for takeover |
| Mail | Postmark, `lib/mail.ts` | `<slug>@MAIL_DOMAIN` inbound; replies route via `<slug>+<tag>@` back to the right session |
| Agent runtime | `lib/anthropic.ts`, `lib/tools.ts`, `agent/system-prompt.md` | Shared agent definition; `$MEMORY` resolved per session |
| Proactive | `api/cron.ts`, `lib/followups.ts`, `lib/notify.ts` | Database-driven: one query per concern, not one API scan per customer |
| Web app | `public/index.html`, `public/app.html` | Landing and login; chat, settings, logins, billing tabs |

## Deploy

1. **Postgres** (Neon, Vercel Postgres, any). Set `DATABASE_URL`, run `npm run db:migrate`.
2. **Anthropic**: API key with Managed Agents. `npm run setup` creates the shared environment and agent and uploads the sandbox CLI; paste the printed ids. Register a webhook in the Console pointing at `https://APP_URL/api/anthropic-webhook` for `session.status_idled`, `session.status_run_started`, `session.status_terminated`.
3. **Browserbase**: API key and project id (contexts and keepAlive on the plan).
4. **Postmark**: one server; add `MAIL_DOMAIN` as a sending domain and enable inbound on it (MX record per Postmark's instructions); set the inbound webhook to `https://APP_URL/api/mail-inbound?token=INBOUND_WEBHOOK_TOKEN`.
5. **Stripe**: a recurring price; webhook endpoint `https://APP_URL/api/stripe-webhook` subscribed to `customer.subscription.*` and `checkout.session.completed`. Optionally set `plan` in the price's metadata and `PLAN_CAP_USD_<PLAN>` env vars for per-plan usage caps.
6. **Google (optional)**: an OAuth client with redirect `https://APP_URL/api/google/callback` and the calendar, gmail.modify, drive.file scopes; publish the consent screen so customers can connect.
7. Fill `.env.example` into Vercel and deploy. The cron in `vercel.json` runs every minute (Pro plan).

## How a customer uses it

Sign up with an email code, start the trial or subscription, then chat at `/app.html` or email their agent address. Settings: name, time zone, approval ceiling and auto-approve types, family senders, quiet hours, check-in times, morning and weekly review, Google connect. Logins: the sites the agent may use, with optional authenticator seeds. Every purchase, payment, message to an outsider, agreement, dispute, or cancellation waits for their yes unless they loosen the rules.

## Costs and caps

Each session carries a hard budget (`SESSION_BUDGET_USD`). Each customer has a monthly cap by plan (`PLAN_CAP_USD_DEFAULT`, `PLAN_CAP_USD_<PLAN>`); usage is recorded from session cost snapshots and new sessions are refused past the cap with a clear message. Browserbase minutes and Postmark volume are the other variable costs.

## Security notes

- Passwords, TOTP seeds and Google refresh tokens are encrypted with `MASTER_KEY` and the customer id as associated data. Move `MASTER_KEY` to a KMS before scale.
- The model and the sandbox never see a password. Prompt injection on a web page cannot reach the vault.
- Third-party mail and forwarded mail are marked as information, never instructions, and every consequential action goes through the approval gate.
- Memory stores are per customer; sessions are looked up in our database, so one customer can never reach another's session, memory, or browser.
- The cron and inbound routes require secrets; the Stripe and Anthropic webhooks verify signatures.

## Developing

`npm run typecheck`. Edit `agent/system-prompt.md`, tools in `lib/agent-config.ts`, playbooks in `agent/memory-seed/playbooks/`, then `npm run setup` to publish a new agent version. Existing customers' memory files are not overwritten; new seed files reach existing customers only through a migration script you write against their stores.

## Not yet

SMS and WhatsApp in, phone calls out, native push notifications, an admin dashboard, per-customer analytics. The chat page has browser dictation as a start on voice.
