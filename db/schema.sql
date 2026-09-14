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
