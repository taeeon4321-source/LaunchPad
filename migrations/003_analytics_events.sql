-- Anonymous product analytics for pricing and checkout. No account link, no IP, no cookies: a random per-tab session id.
create table analytics_events (
  id bigserial primary key,
  name text not null,
  session text,
  variants jsonb not null default '{}',
  props jsonb not null default '{}',
  at timestamptz not null default now()
);
create index analytics_events_at on analytics_events (at desc);
create index analytics_events_name on analytics_events (name, at desc);
