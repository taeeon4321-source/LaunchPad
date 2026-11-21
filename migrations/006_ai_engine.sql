-- AI analysis engine: analyses (cached by input hash), per-call usage and cost, action-center tasks, generated prompts,
-- and the shared reference catalog of real Roblox experiences (public data only).

create table ai_analyses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  game_id text not null,
  optimizer text not null,
  input_hash text not null,
  model text not null,
  sources jsonb not null default '{}',
  reference_ids jsonb not null default '[]',
  result jsonb not null,
  cost_usd numeric(12, 6) not null default 0,
  created_at timestamptz not null default now()
);
create index ai_analyses_lookup on ai_analyses (user_id, game_id, optimizer, created_at desc);
create index ai_analyses_hash on ai_analyses (user_id, input_hash);

create table ai_usage (
  id bigserial primary key,
  user_id uuid references users on delete set null,
  analysis_id uuid references ai_analyses on delete set null,
  task text not null,
  model text not null,
  input_tokens int not null default 0,
  cached_tokens int not null default 0,
  output_tokens int not null default 0,
  cost_usd numeric(12, 6) not null default 0,
  ok boolean not null default true,
  error text,
  at timestamptz not null default now()
);
create index ai_usage_user on ai_usage (user_id, at desc);

create table ai_tasks (
  user_id uuid not null references users on delete cascade,
  id text not null,
  game_id text not null,
  analysis_id uuid references ai_analyses on delete cascade,
  optimizer text not null,
  finding jsonb not null,
  priority numeric(8, 3) not null,
  priority_reason text not null,
  status text not null default 'not_started' check (status in ('not_started', 'in_progress', 'completed', 'dismissed', 'superseded')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
create index ai_tasks_game on ai_tasks (user_id, game_id, status);

create table ai_prompts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users on delete cascade,
  analysis_id uuid references ai_analyses on delete cascade,
  finding_id text,
  kind text not null,
  tool text not null,
  input_hash text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);
create index ai_prompts_hash on ai_prompts (user_id, input_hash);

-- Shared catalog (not user data): public Roblox metadata and assets, plus tags. Maintained by administrators and a refresh job.
create table reference_games (
  universe_id bigint primary key,
  root_place_id bigint,
  name text not null,
  creator text,
  description text,
  genre text,
  icon_url text,
  thumbnail_urls jsonb not null default '[]',
  stats jsonb not null default '{}',
  tags jsonb not null default '{}',
  source text not null default 'roblox_public_api',
  refreshed_at timestamptz,
  added_at timestamptz not null default now(),
  active boolean not null default true
);
create index reference_games_genre on reference_games (genre) where active;

do $$ declare t text; begin
  foreach t in array array['ai_analyses', 'ai_tasks', 'ai_prompts'] loop
    execute format('alter table %I enable row level security', t);
    execute format('create policy own_rows on %I using (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid) with check (user_id = nullif(current_setting(''app.user_id'', true), '''')::uuid)', t);
    execute format('grant select, insert, update, delete on %I to app_user', t);
  end loop;
end $$;
grant select on reference_games to app_user;
