-- Workmate schema. Every statement is idempotent; the whole file is applied when its hash changes.

-- A business (tenant). Members log in with their email; everything else hangs off org_id.
create table if not exists orgs (
  id text primary key,
  name text not null,
  timezone text not null default 'America/New_York',
  settings jsonb not null default '{}'::jsonb,
  stripe_customer_id text unique,
  subscription_status text not null default 'none',   -- none | trialing | active | past_due | canceled
  plan text not null default 'standard',
  current_period_end timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists users (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  email text not null unique,
  name text,
  role text not null default 'owner',                 -- owner | member
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
create index if not exists users_org on users(org_id);

create table if not exists login_codes (
  email text not null,
  code_hash text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists login_codes_email on login_codes(email);

-- The unit of work. One task = one conversation with the model = one browser tab.
create table if not exists tasks (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  title text not null,
  instruction text not null,
  status text not null default 'queued',              -- queued | running | waiting_user | waiting_time | done | failed | cancelled
  outcome text,                                       -- done | blocked | failed (set when finished)
  priority int not null default 5,                    -- 1 = highest
  source text not null default 'chat',                -- chat | email | schedule | agent | api
  parent_id text,
  schedule_id text,
  mail_message_id text,
  created_by text,                                    -- user id or 'system'
  conversation jsonb not null default '[]'::jsonb,    -- the model's message array
  steps int not null default 0,
  cost_cents numeric(14,3) not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  model text,
  scheduled_at timestamptz not null default now(),
  wake_at timestamptz,
  waiting jsonb,                                      -- {kind: question|approval, tool_use_id, question, options, action, amount_usd}
  result text,
  error text,
  worker text,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_progress text,
  browser_used boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists tasks_org_status on tasks(org_id, status, created_at desc);
create index if not exists tasks_runnable on tasks(status, scheduled_at) where status in ('queued', 'waiting_time');
create index if not exists tasks_running on tasks(heartbeat_at) where status = 'running';

-- What happened inside a task, for the console's step log. One row per model step, tool call, note, or message.
create table if not exists task_events (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  org_id text not null,
  kind text not null,                                 -- step | tool | progress | user | question | approval | result | error | system
  summary text not null,
  data jsonb,
  at timestamptz not null default now()
);
create index if not exists task_events_task on task_events(task_id, at);

-- Messages the user sends to a running task, picked up at its next step.
create table if not exists task_inbox (
  id text primary key,
  task_id text not null references tasks(id) on delete cascade,
  text text not null,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  delivered_at timestamptz
);
create index if not exists task_inbox_pending on task_inbox(task_id) where delivered_at is null;

-- Recurring work: "every weekday at 8am, ...".
create table if not exists schedules (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  title text not null,
  instruction text not null,
  cron text not null,
  timezone text not null,
  active boolean not null default true,
  last_run_at timestamptz,
  next_run_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists schedules_due on schedules(next_run_at) where active;

-- Mailboxes the business connects (IMAP in, SMTP out). Passwords are encrypted with MASTER_KEY.
create table if not exists mail_accounts (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  label text not null,
  address text not null,
  from_name text,
  imap_host text, imap_port int, imap_user text, imap_pass_enc text,
  smtp_host text, smtp_port int, smtp_user text, smtp_pass_enc text,
  last_uid bigint not null default 0,
  last_polled_at timestamptz,
  last_error text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists mail_accounts_org on mail_accounts(org_id);

create table if not exists mail_messages (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  account_id text references mail_accounts(id) on delete set null,
  direction text not null,                            -- in | out
  uid bigint,
  message_id text,
  in_reply_to text,
  from_address text not null,
  to_address text not null,
  subject text,
  body text,
  attachments jsonb not null default '[]'::jsonb,     -- [{file_id, name, mime, bytes}]
  received_at timestamptz not null default now(),
  triage jsonb,
  task_id text
);
create index if not exists mail_messages_org on mail_messages(org_id, received_at desc);
create index if not exists mail_messages_msgid on mail_messages(message_id);

-- Long-term memory: facts about the business, site notes, contacts, procedures, task history.
create table if not exists memories (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  kind text not null,                                 -- fact | site | contact | procedure | history
  key text not null,
  content text not null,
  updated_at timestamptz not null default now(),
  unique (org_id, kind, key)
);
create index if not exists memories_org_kind on memories(org_id, kind);

-- Site logins the worker may use. Only the host ever decrypts; the model types nothing it can read.
create table if not exists credentials (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  domain text not null,
  username text not null,
  secret_enc text not null,
  totp_enc text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, domain, username)
);

create table if not exists files (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  task_id text,
  name text not null,
  mime text not null,
  bytes bigint not null,
  path text not null,
  created_at timestamptz not null default now()
);
create index if not exists files_org on files(org_id, created_at desc);

create table if not exists usage (
  org_id text not null references orgs(id) on delete cascade,
  month date not null,
  cost_cents numeric(14,3) not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  tasks int not null default 0,
  primary key (org_id, month)
);

create table if not exists push_subscriptions (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  user_id text not null,
  endpoint text not null unique,
  keys jsonb not null,
  created_at timestamptz not null default now()
);

-- Notifications shown in the console (and mirrored to email/push).
create table if not exists notifications (
  id text primary key,
  org_id text not null references orgs(id) on delete cascade,
  task_id text,
  kind text not null,                                 -- needs_you | done | failed | info
  title text not null,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_org on notifications(org_id, created_at desc);
