# Workmate

A 24/7 AI worker that a business subscribes to instead of hiring for the online legwork: it watches a mailbox and answers or acts on what arrives, fills out forms and applications, orders and returns goods, chases refunds and support tickets through web chat and email, books and cancels, keeps records, generates PDFs, waits for replies and follows up, and comes back to a person only for decisions and approvals.

It is one long-running service. Nothing here is serverless, because a worker that drives a browser for forty minutes, waits three days for a vendor, and polls a mailbox every minute needs a process that stays up.

```
 console (web)  ──HTTP──▶  ┌──────────────────────────── one Node process ───────────────────────────┐
 mailbox (IMAP) ──poll──▶  │ scheduler: wake sleeping tasks, fire cron schedules, poll mail, requeue  │
                           │ worker pool: claims queued tasks, runs the agent loop (Claude + tools)   │
                           │ browsers: one Chromium per business, persistent profile, a tab per task  │
                           └────────────────▲───────────────────────────────▲─────────────────────────┘
                                            │ Postgres (tasks, mail, memory, vault)   │ disk volume (profiles, files)
```

## What changed from the previous version, and why

The old design ran the agent inside Vercel serverless functions in four-minute slices that re-kicked themselves over HTTP, with a per-minute cron as a backstop, re-attaching to a hosted browser over CDP on every slice, and routed cheap models through OpenRouter with a layer of regex "nudges" to correct their behaviour. Each of those was a source of unreliability on its own; together they meant a task could stall between slices, lose its browser connection, or loop. This rewrite removes all of it:

| Concern | Before | Now |
| --- | --- | --- |
| Runtime | Vercel functions, slices, self-kicks, leases, cron sweeps | One process with an in-process worker pool and scheduler; a task runs until it finishes or pauses |
| Model | Cheap models via OpenRouter, escalation, regex nudges | Claude Opus 5 through the Anthropic API with native tools, adaptive thinking, prompt caching; Haiku 4.5 for mail triage |
| Browser | Browserbase over CDP, custom DOM-walk snapshots | Playwright Chromium in-process, one persistent profile per business, accessibility-tree snapshots with stable refs, one-call form filling, diffs after actions |
| Waiting | The customer had to come back | `wait_until` sleeps a task and the scheduler wakes it; `schedule_task` for follow-ups and standing routines |
| Approvals | Chat checkpoints | A policy per business (pre-approved kinds and a money ceiling); everything else pauses the task with a card in the console and an email/push notification |
| Mail | Postmark inbound webhooks | Any mailbox over IMAP and SMTP (Gmail app passwords, Microsoft 365, anything); replies to the worker's mails route back to the task that sent them |
| Sign-in | Heuristic login flow | The model finds the sign-in form; the host types the vault secret into a password field only; a live browser view lets a person sign in once by hand and the profile keeps it |

## Running it

**Locally with Docker Compose** (Postgres included):

```bash
cp .env.example .env    # fill in ANTHROPIC_API_KEY, MASTER_KEY, SESSION_SECRET; set DEV_LOGIN_CODE for a quick start
docker compose up -d --build
open http://localhost:3000
```

**On Fly.io** (recommended for production: one machine that never sleeps, a volume for browser profiles and files):

```bash
fly launch --no-deploy            # uses fly.toml; pick your app name and region
fly volumes create workmate_data --size 10
fly secrets set DATABASE_URL=... ANTHROPIC_API_KEY=... MASTER_KEY=... SESSION_SECRET=... SMTP_HOST=... SMTP_USER=... SMTP_PASS=... MAIL_FROM=...
fly deploy
```

Railway, Render, or a plain VPS with Docker work the same way: run the image, give it a persistent volume at `/data`, a Postgres `DATABASE_URL`, and the secrets. Do not deploy it to Vercel, Netlify or Lambda: they end the process between requests.

**Without Docker**, on a machine with Node 22: `npm ci`, `npx playwright install --with-deps chromium`, fill `.env`, `npm run dev`. For a throwaway trial set `DATABASE_URL=pglite://./data/db` and it runs an embedded Postgres.

`.env.example` documents every setting. The four required ones are `DATABASE_URL`, `ANTHROPIC_API_KEY`, `MASTER_KEY`, `SESSION_SECRET`. Sign-in codes and notifications need the platform `SMTP_*` mailbox; `DEV_LOGIN_CODE` skips that for a test deployment.

## How a business uses it

1. **Sign in** with an email; the first sign-in creates the business. Add colleagues under Settings.
2. **Settings**: write the company profile (what you do, addresses, who is who, standing rules), the standing instructions for incoming mail, and the approval policy (which kinds of action are pre-approved and up to what amount; whether emails to outsiders go without asking).
3. **Inbox**: connect the mailbox to watch (IMAP) and send from (SMTP). New mail is read every minute; mail that needs action becomes a task, replies to the worker's own emails go back to the task that sent them.
4. **Logins**: save site logins (encrypted; the worker never sees a password), or open a site in the live browser view and sign in once by hand.
5. **Tasks**: type what needs doing. The worker reports progress, asks when it must, pauses for approvals, and finishes with the evidence. Send it a message at any time; reply to a finished task to continue it.
6. **Schedules**: recurring work ("weekdays at 8, sweep the inbox", "the 1st, download every vendor invoice and file it").

Everything the worker learns (how a site works, contacts, decisions) is in **Memory** and editable. Every file it produces or receives is under **Files**.

## The agent

`src/agent/prompt.md` is the worker's standing instructions; `src/agent/tools.ts` the tool schemas (strict, so arguments always validate); `src/agent/execute.ts` what each tool does; `src/agent/loop.ts` the loop. The loop persists the conversation after every step, so a restart resumes exactly where a task was; it checks the database for a cancel and for messages from the user between steps; it prunes old tool results in one pass when the conversation grows large (so the cached prefix stays stable between prunes); and it stops a task at its step, time or money budget with an honest wrap-up rather than mid-action.

Tools: browser (`navigate`, `snapshot`, `find`, `click`, `type`, `fill` for whole forms, `select`, `press`, `hover`, `scroll`, `wait`, `read`, `screenshot`, `tabs`, `upload`, `pdf`, `fill_login`), web (`search`, `fetch`), email (`send`, `search`, `read`), memory (`search`, `save`), files (`create`, `pdf_create`, `read`, `list`), and task control (`report_progress`, `ask_user`, `request_approval`, `wait_until`, `schedule_task`, `create_task`, `finish_task`).

**Browser snapshots** come from Playwright's accessibility tree: every actionable element has a ref (`button "Place order" [ref=e41]`) that stays valid while the element exists, so after a click the worker gets only what changed. A page too long for one snapshot is searched with `browser_find` or read with `browser_read`. Screenshots are for layout questions; coordinates from them are clickable.

**Secrets** never reach the model. `browser_fill_login` looks the site up in the vault and types the password only into a field of type `password` (a plain text box is refused), then redacts the secret from anything it returns. Memory notes that look like a password or a card number are refused.

**Cost**: every model call is priced from the usage the API reports and booked to the business and the month; `TASK_MAX_USD` caps one task, `PLAN_CAP_USD_*` caps a business per month. The system prompt has two cache breakpoints (the standing instructions for an hour, the company's block for five minutes) and the conversation tail is auto-cached, so a long task re-reads its history at a tenth of the price.

## Developing

```bash
npm run typecheck
npm test              # unit tests, agent-loop tests with a scripted model, browser tests against real Chromium, an end-to-end API test
```

The browser tests need Chromium: `npx playwright install chromium` once (or set `PLAYWRIGHT_BROWSERS_PATH`). Tests use an embedded Postgres, no services required.

Schema changes go in `db/schema.sql` as idempotent statements; they are applied on boot whenever the file's hash changes.

## Limits worth knowing

- Sites with aggressive bot walls (some airlines, some banks) may still block a data-center IP. The live browser view lets a person clear a check or sign in once; for heavy use, `BROWSER_WS_ENDPOINT` accepts a hosted stealth browser instead of local Chromium.
- No phone calls or SMS. Codes texted to a phone are asked of the user in the task.
- Mail is watched by polling IMAP every minute, not by push; that is fine for business mail and needs no provider-specific setup.
- One process. For more businesses than one machine can hold, run several instances against the same Postgres: task claiming is atomic (`for update skip locked`), and each business's browser profile lives on the instance that runs it, so pin businesses to instances or use a shared hosted browser.
