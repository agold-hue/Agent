-- Personal Web Agent, multi-tenant schema. Apply with: npm run db:migrate
create extension if not exists pgcrypto;

create table if not exists users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  name text,
  slug text not null unique,                 -- local part of the agent address: <slug>@MAIL_DOMAIN
  timezone text not null default 'America/New_York',
  settings jsonb not null default '{}'::jsonb,
  memory_store_id text,
  browserbase_context_id text,
  google_refresh_token_enc text,
  stripe_customer_id text unique,
  subscription_status text not null default 'none',   -- none | trialing | active | past_due | canceled
  plan text not null default 'starter',
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table if not exists login_codes (
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists login_codes_email on login_codes(email);

-- Site logins the agent may use for a customer. Secrets are envelope-encrypted with MASTER_KEY.
create table if not exists credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  domain text not null,
  username text not null,
  secret_enc text not null,
  totp_secret_enc text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists credentials_user_domain on credentials(user_id, domain);

-- Every Managed Agents session we start, with the routing state the routes need.
create table if not exists agent_sessions (
  id text primary key,                         -- sesn_...
  user_id uuid not null references users(id) on delete cascade,
  channel text not null,                       -- chat | email
  kind text not null default 'task',           -- task | chat | correspondence | review | weekly | followup | triage | digest
  title text,
  status text not null default 'running',
  requester text,                              -- email of a family member who asked, else null (the owner)
  reply_tag text,                              -- plus-tag routing replies back to this session
  email_subject text,
  last_message_id text,                        -- Message-ID header of the last inbound mail, for threading
  correspondent text,
  browserbase_session_id text,
  pending_kind text,                           -- checkpoint | ask_user | send_email
  pending_event_id text,
  pending_deadline timestamptz,
  last_replied_idle_id text,
  review_day date,
  digest_key text,
  followup_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists agent_sessions_user on agent_sessions(user_id, created_at desc);
create index if not exists agent_sessions_reply_tag on agent_sessions(reply_tag);
create index if not exists agent_sessions_pending on agent_sessions(pending_kind) where pending_kind is not null;

-- Timers and recurring watches the agent sets for itself.
create table if not exists followups (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  due timestamptz not null,
  what text not null,
  project text,
  repeat_ms bigint,
  until_at timestamptz,
  fired int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists followups_due on followups(due);

-- Heads-ups held for the customer's next check-in.
create table if not exists digest_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  label text not null,
  body text not null,
  created_at timestamptz not null default now(),
  flushed_at timestamptz
);
create index if not exists digest_entries_pending on digest_entries(user_id) where flushed_at is null;

-- Monthly usage per customer, from session usage snapshots.
create table if not exists usage (
  user_id uuid not null references users(id) on delete cascade,
  month date not null,
  cost_cents bigint not null default 0,
  sessions int not null default 0,
  primary key (user_id, month)
);
create table if not exists session_costs (
  session_id text primary key references agent_sessions(id) on delete cascade,
  cost_cents bigint not null default 0
);

-- Copy of mail that arrived at a customer's agent address without being a request or a reply
-- (auto-forwarded bills, receipts, codes). Triaged in batches; also searched for verification codes.
create table if not exists inbound_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  from_address text not null,
  subject text,
  body text,
  attachment_names text[] not null default '{}',
  received_at timestamptz not null default now(),
  triaged_at timestamptz
);
create index if not exists inbound_log_untriaged on inbound_log(user_id) where triaged_at is null;
create index if not exists inbound_log_recent on inbound_log(user_id, received_at desc);

create table if not exists inbound_attachments (
  id uuid primary key default gen_random_uuid(),
  inbound_id uuid not null references inbound_log(id) on delete cascade,
  filename text not null,
  mime_type text not null,
  content bytea not null
);

-- ---------------------------------------------------------------- Provider-agnostic runtime
-- Each customer's memory: small text files by path (standing instructions, playbooks, calendar,
-- conversations/...). Seeded from agent/memory-seed on first use.
create table if not exists memories (
  user_id uuid not null references users(id) on delete cascade,
  path text not null,
  content text not null default '',
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);

-- The agent loop's state lives with the session: the OpenAI-style message array, the model in
-- use, and a lease so only one worker runs a session at a time.
alter table agent_sessions add column if not exists model text;
alter table agent_sessions add column if not exists messages jsonb not null default '[]'::jsonb;
alter table agent_sessions add column if not exists turns int not null default 0;
alter table agent_sessions add column if not exists lease_until timestamptz;
alter table agent_sessions add column if not exists last_report text;
alter table agent_sessions add column if not exists error text;
alter table agent_sessions add column if not exists cost_cents bigint not null default 0;
alter table agent_sessions add column if not exists prompt_tokens bigint not null default 0;
alter table agent_sessions add column if not exists completion_tokens bigint not null default 0;
create index if not exists agent_sessions_runnable on agent_sessions(status) where status = 'running';

-- Fractional cents: a single cheap-model call can cost 0.1 cent.
alter table agent_sessions alter column cost_cents type numeric(14,3);
alter table usage alter column cost_cents type numeric(14,3);
alter table session_costs alter column cost_cents type numeric(14,3);

-- ---------------------------------------------------------------- Daily-use features
-- Structured things the agent keeps an eye on for the "what's today" screen: bills, packages,
-- appointments, reservations, school events, reminders. The agent upserts them with track_item.
create table if not exists tracked_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,                       -- bill | package | appointment | reservation | school | reminder | other
  title text not null,
  due_at timestamptz,
  status text not null default 'open',      -- open | done | cancelled
  amount_cents numeric(14,2),
  details jsonb not null default '{}'::jsonb,
  source text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tracked_items_user_due on tracked_items(user_id, status, due_at);

-- Wins for the scoreboard: refunds won, money saved, subscriptions cancelled, time saved.
create table if not exists wins (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,                       -- refund | saved | cancelled | price_drop | time | done
  amount_cents numeric(14,2) not null default 0,
  minutes int not null default 0,
  label text not null,
  session_id text,
  created_at timestamptz not null default now()
);
create index if not exists wins_user_month on wins(user_id, created_at desc);

-- Proof that a task was really done: confirmation numbers and an optional screenshot.
create table if not exists receipts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  session_id text,
  title text not null,
  confirmation text,
  details text,
  image bytea,
  created_at timestamptz not null default now()
);
create index if not exists receipts_user on receipts(user_id, created_at desc);

-- Cache accounting (idempotent adds for existing databases)
alter table agent_sessions add column if not exists cached_tokens bigint not null default 0;
alter table usage add column if not exists prompt_tokens bigint not null default 0;
alter table usage add column if not exists cached_tokens bigint not null default 0;

-- Timers remember the channel they were set from so their report lands where the user is
alter table followups add column if not exists channel text not null default 'chat';

-- A task spawned from the chat to run alongside it (parallel tasks) remembers its chat thread
alter table agent_sessions add column if not exists parent_session_id text;
-- One hosted browser per customer at a time; each session works in its own tab of it
alter table agent_sessions add column if not exists browser_target_id text;

-- The reply being written right now, streamed to the page while the model is still talking
alter table agent_sessions add column if not exists draft text;

-- Web-push subscriptions: "code needed", "needs your ok", "done" reach the phone when the chat is closed
create table if not exists push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  endpoint text not null unique,
  keys jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user on push_subscriptions(user_id);

-- Standing orders: a request the agent runs on a schedule ("every Sunday, order the groceries")
create table if not exists standing_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  what text not null,
  schedule text not null,                     -- "daily 09:00" | "weekly Sun 18:00" | "monthly 20 09:00"
  last_run date,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists standing_orders_user on standing_orders(user_id);
create index if not exists agent_sessions_parent on agent_sessions(parent_session_id) where parent_session_id is not null;

-- Web search and page reads over HTTPS, cached and shared across customers (a result page is the
-- same for everyone). Rows expire; the cron sweep prunes them.
create table if not exists search_cache (
  key text primary key,                       -- search:<query>|<country>|<lang>|<near>|<since>  or  page:<canonical url>
  kind text not null,                         -- search | page
  value jsonb not null,
  fetched_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists search_cache_expires on search_cache(expires_at);

-- The search golden set's runs: one row per question per run (npm run eval:search, or nightly with SEARCH_EVAL_NIGHTLY=on).
create table if not exists search_evals (
  id uuid primary key default gen_random_uuid(),
  run_id text not null,
  question text not null,
  expected text not null,
  answer text,
  ok boolean not null,
  ms int not null default 0,
  cost_cents numeric(14,3) not null default 0,
  pages int not null default 0,
  engine text,
  created_at timestamptz not null default now()
);
create index if not exists search_evals_run on search_evals(run_id, created_at desc);

-- Login health: when a saved login last worked or failed (the auto sign-in and the login tool record it).
alter table credentials add column if not exists last_ok_at timestamptz;
alter table credentials add column if not exists last_fail_at timestamptz;
alter table credentials add column if not exists last_fail_reason text;

-- Once-a-day marks (a morning review skipped for lack of work), so the cron does not re-check every minute.
create table if not exists daily_marks (
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,
  day date not null,
  primary key (user_id, kind, day)
);

-- ---------------------------------------------------------------- Cost attribution, outcomes, watches, integrations
-- Every model call, tagged with what it was for (turn, condense, lookup, wrapup, postmortem, learn...).
create table if not exists usage_events (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  session_id text,
  purpose text not null,
  model text,
  cost_cents numeric(14,4) not null default 0,
  prompt_tokens int not null default 0,
  cached_tokens int not null default 0,
  completion_tokens int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists usage_events_user_time on usage_events(user_id, created_at desc);
create index if not exists usage_events_purpose_time on usage_events(purpose, created_at desc);

-- How each kind of task ended per customer and tier, so the router can start the next one on the cheapest tier that has worked.
create table if not exists task_outcomes (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  class text not null,                        -- money | shopping | travel | ... | general
  tier text not null,                         -- chat | task | hard
  ok boolean not null,
  session_id text,
  created_at timestamptz not null default now()
);
create index if not exists task_outcomes_user_class on task_outcomes(user_id, class, created_at desc);
alter table task_outcomes add column if not exists model text;   -- the primary model id the task ran on
alter table task_outcomes add column if not exists site text;    -- the site the task worked, when it drove the browser

-- Change watches: a page or a search re-read on a schedule by the host, with no model call until something changes.
create table if not exists watches (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,                         -- page | search
  target text not null,                       -- the URL, or the search query
  focus text,                                 -- words the change must touch (a price, "available", a date); empty = any change in the main text
  what text not null,                         -- what to do when it changes, in the user's words
  every_minutes int not null default 60,
  last_hash text,
  last_excerpt text,
  last_checked_at timestamptz,
  next_check_at timestamptz not null default now(),
  fired int not null default 0,
  active boolean not null default true,
  channel text not null default 'chat',
  created_at timestamptz not null default now()
);
create index if not exists watches_due on watches(next_check_at) where active;

-- Plaid items (bank connections): the access token is envelope-encrypted like every other secret.
create table if not exists plaid_items (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  item_id text not null unique,
  access_token_enc text not null,
  institution text,
  cursor text,                                -- transactions/sync cursor
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists plaid_items_user on plaid_items(user_id);

-- The local browser relay: the customer's own browser (an extension) polls for commands and posts results.
create table if not exists relay_devices (
  user_id uuid not null references users(id) on delete cascade,
  token_hash text not null,
  name text,
  last_seen_at timestamptz,
  current_url text,
  created_at timestamptz not null default now(),
  primary key (user_id, token_hash)
);
create table if not exists relay_commands (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  command jsonb not null,
  result jsonb,
  created_at timestamptz not null default now(),
  taken_at timestamptz,
  done_at timestamptz
);
create index if not exists relay_commands_pending on relay_commands(user_id, created_at) where taken_at is null;

-- Deferred single model calls (post-mortems) sent through the provider's half-price batch endpoint.
create table if not exists batch_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,                         -- postmortem
  payload jsonb not null,                     -- { messages, max_tokens, meta }
  batch_id text,                              -- provider batch id once submitted
  status text not null default 'pending',     -- pending | submitted | done | failed
  result text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists batch_jobs_status on batch_jobs(status, created_at);

-- Per-customer relay token (hashed in relay_devices) and Plaid environment live in settings; nothing else needed here.

-- Long documents (a lease, a statement, a policy) stored page by page; the message carries an outline, the document tool reads pages.
create table if not exists documents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  name text not null,
  mime text not null,
  pages int not null,
  chars int not null,
  source text not null,                       -- chat | mail
  outline text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists documents_user on documents(user_id, created_at desc);
create table if not exists document_pages (
  doc_id uuid not null references documents(id) on delete cascade,
  page int not null,
  text text not null,
  primary key (doc_id, page)
);

-- Host initiative: promises kept, reminders, fix cards, approval history and rules, reply grades, overnight readings.
alter table agent_sessions add column if not exists reminded_at timestamptz;
alter table usage_events add column if not exists provider text;
alter table usage_events add column if not exists ttft_ms int;
create table if not exists fixes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null,                         -- add_login | check_login | connect_google | enable_relay | add_bank
  domain text,
  message text not null,
  created_at timestamptz not null default now(),
  done_at timestamptz
);
create index if not exists fixes_open on fixes(user_id) where done_at is null;
create table if not exists approval_log (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  action_type text not null,
  merchant text,
  amount_usd numeric(14,2),
  summary text,
  decision text not null,                     -- approved | denied | auto
  session_id text,
  created_at timestamptz not null default now()
);
create index if not exists approval_log_user on approval_log(user_id, action_type, created_at desc);
create table if not exists reply_grades (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  session_id text,
  score int not null,
  issue text not null,
  created_at timestamptz not null default now()
);
create index if not exists reply_grades_user on reply_grades(user_id, created_at desc);
create table if not exists path_uses (
  user_id uuid not null references users(id) on delete cascade,
  domain text not null,
  name text not null,
  uses int not null default 0,
  last_used_at timestamptz,
  primary key (user_id, domain, name)
);
create table if not exists readings (
  id bigserial primary key,
  user_id uuid not null references users(id) on delete cascade,
  domain text not null,
  label text not null,
  value text not null,
  read_at timestamptz not null default now()
);
create index if not exists readings_user_time on readings(user_id, read_at desc);
-- Quick replies for the last reply, written by the fast model after the reply is on the page.
alter table agent_sessions add column if not exists chips jsonb;
