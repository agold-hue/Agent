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
