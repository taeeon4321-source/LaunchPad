-- LaunchPad schema v1. Every private table carries user_id; row-level security limits app_user to its own rows.
-- System code (webhooks, jobs, admin) runs as the table owner, which bypasses RLS; user requests run as app_user.

do $$ begin if not exists (select 1 from pg_roles where rolname = 'app_user') then create role app_user nologin; end if; end $$;

create table users (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  email_verified_at timestamptz,
  display_name text not null check (length(display_name) between 1 and 60),
  avatar bytea, avatar_type text,
  password_hash text,
  status text not null default 'active' check (status in ('active', 'suspended', 'deleted')),
  suspended_reason text,
  mfa_secret_enc text, mfa_enabled_at timestamptz,
  created_at timestamptz not null default now(),
  last_login_at timestamptz,
  deleted_at timestamptz
);
create unique index users_email_uq on users (lower(email)) where status <> 'deleted';

create table auth_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  provider text not null check (provider in ('google')),
  provider_subject text not null,
  email text,
  created_at timestamptz not null default now(),
  unique (provider, provider_subject)
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null,
  authenticated_at timestamptz not null default now(),
  mfa_at timestamptz,
  ip text, user_agent text,
  revoked_at timestamptz
);
create index sessions_user on sessions (user_id);

create table auth_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  kind text not null check (kind in ('verify_email', 'reset_password')),
  token_hash text not null unique,
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default now()
);

create table user_preferences (
  user_id uuid primary key references users on delete cascade,
  prefs jsonb not null default '{}',
  consents jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

create table games (
  user_id uuid not null references users on delete cascade,
  id text not null check (length(id) <= 64),
  data jsonb not null,
  roblox_universe_id bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table reports (
  user_id uuid not null references users on delete cascade,
  id text not null check (length(id) <= 64),
  game_id text,
  optimizer text not null check (optimizer in ('game-page', 'thumbnail', 'first-session', 'retention', 'progression')),
  score int,
  data jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, game_id) references games (user_id, id) on delete cascade
);

create table recommendations (
  user_id uuid not null,
  report_id text not null,
  rec_id text not null,
  title text not null,
  priority text not null,
  done boolean not null default false,
  trigger text,
  primary key (user_id, report_id, rec_id),
  foreign key (user_id, report_id) references reports (user_id, id) on delete cascade
);

create table evidence_records (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  report_id text not null,
  finding text not null,
  source text not null,
  reference text,
  created_at timestamptz not null default now(),
  foreign key (user_id, report_id) references reports (user_id, id) on delete cascade
);

create table developer_overrides (
  user_id uuid not null,
  game_id text not null,
  field text not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  primary key (user_id, game_id, field),
  foreign key (user_id, game_id) references games (user_id, id) on delete cascade
);

create table roblox_connections (
  user_id uuid primary key references users on delete cascade,
  roblox_user_id bigint not null,
  roblox_username text,
  access_token_enc text, refresh_token_enc text,
  token_expires_at timestamptz,
  scopes text not null,
  status text not null default 'active' check (status in ('active', 'expired', 'revoked')),
  connected_at timestamptz not null default now(),
  last_used_at timestamptz
);

create table roblox_experiences (
  user_id uuid not null references users on delete cascade,
  universe_id bigint not null,
  name text,
  owner_type text, owner_id bigint,
  active boolean not null default true,
  connected_at timestamptz not null default now(),
  primary key (user_id, universe_id)
);

create table studio_installations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  token_hash text not null unique,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz,
  expires_at timestamptz not null,
  revoked_at timestamptz
);

create table pairing_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique,
  poll_secret_hash text not null,
  user_id uuid references users on delete cascade,
  installation_id uuid references studio_installations on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  claimed_at timestamptz
);

create table scan_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  universe_id bigint not null,
  installation_id uuid references studio_installations on delete set null,
  status text not null default 'queued' check (status in ('queued', 'processing', 'done', 'failed', 'cancelled')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table scan_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  universe_id bigint not null,
  place_id bigint,
  job_id uuid references scan_jobs on delete set null,
  data jsonb not null,
  section_hashes jsonb not null,
  changes jsonb not null default '[]',
  code_read boolean not null default false,
  created_at timestamptz not null default now(),
  analyzed_at timestamptz
);
create index scan_snapshots_user on scan_snapshots (user_id, universe_id, created_at desc);

create table support_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users on delete set null,
  email text not null,
  kind text not null check (kind in ('support', 'privacy_access', 'privacy_export', 'privacy_correction', 'privacy_deletion', 'copyright', 'refund', 'billing')),
  subject text not null,
  body jsonb not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'rejected')),
  resolution text,
  handled_by uuid references users on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table admin_roles (
  user_id uuid not null references users on delete cascade,
  role text not null check (role in ('owner', 'administrator', 'support', 'security')),
  granted_by uuid references users on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

create table admin_audit_log (
  id bigserial primary key,
  admin_id uuid,
  action text not null,
  target text,
  reason text,
  outcome text not null,
  at timestamptz not null default now()
);
-- Audit records are append-only, even for the application's own database user.
create function audit_immutable() returns trigger language plpgsql as $$ begin raise exception 'admin_audit_log is append-only'; end $$;
create trigger admin_audit_log_immutable before update or delete on admin_audit_log for each row execute function audit_immutable();

create table security_events (
  id bigserial primary key,
  user_id uuid,
  kind text not null,
  ip text,
  detail jsonb not null default '{}',
  at timestamptz not null default now()
);
create index security_events_at on security_events (at desc);

create table legal_documents (
  slug text not null,
  version text not null,
  title text not null,
  effective_date date,
  review_status text not null check (review_status in ('draft', 'awaiting_review', 'approved')),
  content_html text not null,
  updated_at timestamptz not null default now(),
  primary key (slug, version)
);

create table legal_acceptances (
  user_id uuid not null references users on delete cascade,
  slug text not null,
  version text not null,
  accepted_at timestamptz not null default now(),
  ip text,
  primary key (user_id, slug, version)
);

-- Billing references are kept when an account is deleted (user_id becomes null) because tax and accounting rules may require them.
create table billing_customers (
  provider text not null default 'paddle',
  environment text not null check (environment in ('sandbox', 'live')),
  customer_id text not null,
  user_id uuid references users on delete set null,
  created_at timestamptz not null default now(),
  primary key (provider, environment, customer_id)
);
create unique index billing_customers_user on billing_customers (provider, environment, user_id);

create table subscriptions (
  id uuid primary key default gen_random_uuid(),
  provider text not null default 'paddle',
  environment text not null,
  provider_subscription_id text not null,
  provider_customer_id text,
  user_id uuid references users on delete set null,
  product_id text, price_id text,
  plan text check (plan in ('light', 'max')),
  billing_interval text check (billing_interval in ('month', 'year')),
  status text not null,
  current_period_start timestamptz, current_period_end timestamptz,
  next_billed_at timestamptz,
  scheduled_change jsonb,
  canceled_at timestamptz,
  past_due_since timestamptz,
  last_event_at timestamptz, last_event_id text,
  updated_at timestamptz not null default now(),
  unique (provider, environment, provider_subscription_id)
);

create table subscription_events (
  provider text not null default 'paddle',
  environment text not null,
  event_id text not null,
  event_type text not null,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  status text not null default 'received' check (status in ('received', 'processed', 'ignored', 'failed')),
  error text,
  payload jsonb not null,
  primary key (provider, environment, event_id)
);

create table billing_transactions (
  provider text not null default 'paddle',
  environment text not null,
  transaction_id text not null,
  user_id uuid references users on delete set null,
  subscription_id text,
  status text not null,
  origin text,
  amount_cents bigint, currency text,
  billing_interval text,
  billed_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (provider, environment, transaction_id)
);

create table billing_adjustments (
  provider text not null default 'paddle',
  environment text not null,
  adjustment_id text not null,
  transaction_id text,
  action text, status text,
  amount_cents bigint, currency text,
  created_at timestamptz not null default now(),
  primary key (provider, environment, adjustment_id)
);

create table entitlements (
  user_id uuid primary key references users on delete cascade,
  plan text not null check (plan in ('free', 'light', 'max')),
  billing_interval text,
  source_subscription_id uuid references subscriptions on delete set null,
  status_note text,
  updated_at timestamptz not null default now()
);

create table usage_counters (
  user_id uuid not null references users on delete cascade,
  metric text not null,
  period text not null,
  count int not null default 0,
  primary key (user_id, metric, period)
);

create table email_outbox (
  id bigserial primary key,
  to_email text not null,
  template text not null,
  subject text not null,
  body_html text not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  error text
);

create table jobs (
  id bigserial primary key,
  kind text not null,
  payload jsonb not null default '{}',
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed', 'cancelled')),
  run_at timestamptz not null default now(),
  attempts int not null default 0,
  max_attempts int not null default 5,
  progress int not null default 0,
  last_error text,
  locked_at timestamptz,
  idempotency_key text unique,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index jobs_ready on jobs (status, run_at);

-- Row-level security for user-owned data.
do $$ declare t text; begin
  foreach t in array array['user_preferences', 'games', 'reports', 'recommendations', 'evidence_records', 'developer_overrides', 'roblox_experiences', 'scan_jobs', 'scan_snapshots'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy own_rows on %I using (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) with check (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)', t);
    execute format('grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;

create table schema_migrations (version text primary key, applied_at timestamptz not null default now());
