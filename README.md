# Personal Web Agent

A secretary you chat with or email. It remembers everything you have told it, keeps your calendar straight, opens a hosted browser that holds your own logins, does the job on whatever website it takes, and reports back. Nothing runs on your machine.

```
you ──chat──▶ public/index.html ──▶ api/chat/send ──┐
you ──email──▶ Gmail ──cron/push──▶ api/inbox ──────┴─▶ Anthropic Managed Agents session
                                                        │  (agent loop + sandbox, Anthropic-hosted)
                                                        │  memory store: standing instructions, calendar, facts,
                                                        │                per-site notes, full conversation log
                                                        │  drives ▶ Browserbase (hosted browser, your persistent profile)
                                                        ▼
chat ◀── api/chat/stream (live) ── / ── email ◀── api/anthropic-webhook ◀── session idle / needs a tool
                    │
                    ├─ login ........ 1Password ▶ fills the form in the hosted browser (password never reaches the agent)
                    ├─ checkpoint ... auto-approve under your rules, else email you and wait for "yes"
                    ├─ ask_user ..... one batched question email with defaults + deadline
                    └─ get_email_code / save_login / browser_session
```

## Pieces

| Piece | Where it runs | What it does |
| --- | --- | --- |
| Agent (`lib/agent-config.ts`, `agent/system-prompt.md`) | Anthropic Managed Agents | Claude Opus 5, versioned config, memory store mounted at `/mnt/memory/personal-web-agent-memory` |
| Sandbox browser CLI (`sandbox/browser.mjs`) | Inside the session sandbox | `goto`, `snapshot`, `click`, `type`, `screenshot`... over CDP to the hosted browser |
| Hosted browser | Browserbase | Persistent context (cookies survive), residential proxy, captcha solving, live-view URL for you |
| Chat page (`public/index.html`) + `api/chat/*` | Vercel | Password-protected chat with live streaming replies, approval buttons, basic dictation |
| Inbox route (`api/inbox.ts`) | Vercel, every minute | Unread mail from you → new session or follow-up; resolves approvals and answers; expires unanswered questions |
| Webhook route (`api/anthropic-webhook.ts`) | Vercel | Runs the custom tools, emails the final report |
| Passwords | 1Password service account | Looked up by website URL; TOTP handled; new accounts saved back |
| Memory | Anthropic memory store | `standing_instructions.md`, `calendar.md`, `facts.md`, `preferences.md`, `sites/<domain>.md`, `history/…`, `conversations/YYYY-MM-DD.md` |

State lives in session metadata (Gmail thread id, pending approval, browser session id). No database.

## Setup

1. **Anthropic**: API key with Managed Agents access. In the Console, register a webhook (Manage → Webhooks) pointing at `https://<your-vercel-app>/api/anthropic-webhook`, subscribed to `session.status_idled` and `session.status_terminated`. Copy the signing key.
2. **Browserbase**: API key and project id. Plan with `keepAlive` and contexts.
3. **1Password**: create a vault for the agent's logins, a service account with read (and write, if it may save new accounts) access to it. Note the vault id.
4. **Gmail**: a dedicated Google account for the agent. Create OAuth client credentials, obtain a refresh token with the `https://www.googleapis.com/auth/gmail.modify` scope (the OAuth Playground works). You email this address from `OWNER_EMAIL`.
5. Copy `.env.example` to `.env`, fill in the keys above, then:

```bash
npm install
npm run provision      # creates environment, agent, memory store, browser profile; uploads the sandbox CLI
```

Paste the printed `AGENT_ID`, `ENVIRONMENT_ID`, `MEMORY_STORE_ID`, `SANDBOX_TOOLS_FILE_ID`, `BROWSERBASE_CONTEXT_ID` into `.env` and into the Vercel project's environment variables along with everything else in `.env.example`.

6. Deploy to Vercel (`vercel --prod`). The cron in `vercel.json` runs every minute, which needs a Pro plan. On Hobby, point a Gmail Pub/Sub watch (or any external pinger) at `POST /api/inbox?token=<CRON_SECRET>` instead.
7. **Fill in your defaults**: open the memory store in the Anthropic Console (or edit via API) and complete `standing_instructions.md`. This is what stops the back-and-forth.
8. **First logins**: send a task that touches a site. If the password manager has no entry, the agent offers to sign up; if a site demands SMS, open the live-view link from the email and enter the code once. The persistent profile keeps you signed in after that.

## Using it

**Chat**: open your Vercel URL, enter `CHAT_PASSWORD`. Replies stream in. A chat session stays warm for `CHAT_SESSION_MAX_AGE_HOURS`; after that a fresh session starts, but memory carries over, so nothing is forgotten. Approval requests and questions appear as cards; "yes" or the Approve button approves, anything else is taken as new instructions.

**Memory of everything**: every chat and email, both directions, is appended by the host to `conversations/YYYY-MM-DD.md` in the memory store. The agent greps it when you refer to something from the past. Dated commitments you mention ("appointment in FL next Wednesday") go into `calendar.md` and are checked before it schedules any delivery, pickup or appointment. Every message is stamped with the current time in `OWNER_TIMEZONE` so relative dates resolve correctly.

**Email**: email the agent from your address. Subject is the task title, body is the task. Optional `TASK_PASSPHRASE` gates new tasks. Replies in the same thread continue the same session, so "yes" approves a checkpoint and a numbered list answers its questions.

Policy knobs: `AUTO_APPROVE_MAX_USD`, `AUTO_APPROVE_TYPES`, `ASK_USER_DEADLINE_HOURS`, `SESSION_BUDGET_USD`. The agent's standing instructions can be stricter than these, never looser.

## Editing the agent

Change `agent/system-prompt.md` or the tools in `lib/agent-config.ts`, then `npm run update-agent`. If `sandbox/browser.mjs` changed, update `SANDBOX_TOOLS_FILE_ID` with the printed id.

## Security notes

- Site passwords are read by the Vercel function and typed into the hosted browser. The sandbox and the model only ever see "logged_in". Prompt injection on a web page cannot reach them.
- The Browserbase connect URL handed to the sandbox is scoped to the current browser session. Rotate the Browserbase key if a session is ever compromised.
- Anything that moves money or speaks as you goes through `checkpoint`; the host policy is the floor.
- The agent's memory must never hold secrets (system prompt forbids it, and memory versions are auditable and redactable in the Console).

## Roadmap

- Voice front door: the chat page already has browser dictation; a phone number (Twilio) or an always-on voice app would post transcripts to `api/chat/send` and read replies from `api/chat/stream`.
- SMS 2FA via a Twilio number wired into `lib/login.ts` next to the email-code fallback.
- Per-site notes seeded from the first few runs.
