-- Analytics platform: credentials, game links, aggregated time series, uploads, forecasts, saved charts and dashboards.
-- Only aggregates are stored (no player-level or personal data). Every row is owned by one user (row-level security below).

-- Roblox Open Cloud API keys (Analytics Query API uses x-api-key; it has no OAuth flow). Encrypted at rest, never returned.
create table analytics_credentials (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  label text not null,
  secret_enc text not null,
  key_hint text not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz
);
create index analytics_credentials_user on analytics_credentials (user_id);

-- Which Roblox universe a LaunchPad game reads analytics from, and the last sync outcome.
create table analytics_links (
  user_id uuid not null references users on delete cascade,
  game_id text not null,
  universe_id bigint not null,
  credential_id uuid references analytics_credentials on delete set null,
  status text not null default 'pending' check (status in ('pending', 'ok', 'unauthorized', 'not_eligible', 'error')),
  status_detail text,
  last_sync_at timestamptz,
  last_success_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (user_id, game_id),
  foreign key (user_id, game_id) references games (user_id, id) on delete cascade
);

-- Developer uploads (CSV/JSON). Provenance for every uploaded point.
create table analytics_datasets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  game_id text not null,
  kind text not null check (kind in ('retention', 'sessions', 'progression', 'economy', 'milestones', 'benchmark', 'other')),
  filename text not null,
  timezone text not null,
  row_count int not null,
  columns jsonb not null default '{}',
  created_at timestamptz not null default now(),
  foreign key (user_id, game_id) references games (user_id, id) on delete cascade
);
create index analytics_datasets_user_game on analytics_datasets (user_id, game_id, created_at desc);

-- One aggregated observation. source: roblox (Actual), upload (Uploaded), benchmark (Benchmark).
-- breakdown is '' for the total, otherwise "Dim=Value" pairs joined by '|'. granularity None = one value for [t, t_end).
create table metric_points (
  user_id uuid not null references users on delete cascade,
  game_id text not null,
  source text not null check (source in ('roblox', 'upload', 'benchmark')),
  metric text not null,
  granularity text not null,
  breakdown text not null default '',
  t timestamptz not null,
  t_end timestamptz,
  value double precision not null,
  status text not null default '',
  sample_size double precision,
  dataset_id uuid references analytics_datasets on delete cascade,
  fetched_at timestamptz not null default now(),
  primary key (user_id, game_id, source, metric, granularity, breakdown, t),
  foreign key (user_id, game_id) references games (user_id, id) on delete cascade
);
create index metric_points_lookup on metric_points (user_id, game_id, metric, granularity, t);
create index metric_points_dataset on metric_points (dataset_id) where dataset_id is not null;

-- Sync history: one row per run, with per-query outcomes.
create table analytics_sync_runs (
  id bigserial primary key,
  user_id uuid not null references users on delete cascade,
  game_id text not null,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  status text not null default 'running' check (status in ('running', 'ok', 'partial', 'failed')),
  points int not null default 0,
  detail jsonb not null default '[]'
);
create index analytics_sync_runs_game on analytics_sync_runs (user_id, game_id, started_at desc);

-- Generated forecasts with their prediction intervals and the data they were trained on.
create table analytics_forecasts (
  id bigserial primary key,
  user_id uuid not null references users on delete cascade,
  game_id text not null,
  metric text not null,
  breakdown text not null default '',
  generated_at timestamptz not null default now(),
  result jsonb not null
);
create index analytics_forecasts_lookup on analytics_forecasts (user_id, game_id, metric, breakdown, generated_at desc);

create table saved_charts (
  user_id uuid not null references users on delete cascade,
  id text not null check (length(id) <= 64),
  name text not null,
  config jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table dashboards (
  user_id uuid not null references users on delete cascade,
  id text not null check (length(id) <= 64),
  name text not null,
  position int not null default 0,
  widgets jsonb not null default '[]',
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

do $$ declare t text; begin
  foreach t in array array['analytics_credentials', 'analytics_links', 'analytics_datasets', 'metric_points', 'analytics_sync_runs', 'analytics_forecasts', 'saved_charts', 'dashboards'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy own_rows on %I using (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) with check (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)', t);
    execute format('grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;
grant usage on sequence analytics_sync_runs_id_seq, analytics_forecasts_id_seq to app_user;
