-- Memory Map — complete, idempotent Supabase schema.
--
-- Run this file in the Supabase SQL Editor, then run
-- supabase/rank-wishlist-function.sql. It is safe to re-run: tables and
-- columns use IF NOT EXISTS, while policies and triggers are replaced.
--
-- IMPORTANT: replace the two placeholder emails in
-- is_memory_map_owner() before running this in a real project.

create extension if not exists vector;

-- The app is publicly readable, but only the two owner accounts may write.
-- Keeping the allowlist in one helper prevents policy definitions drifting.
create or replace function public.is_memory_map_owner()
returns boolean
language sql
stable
as $$
  select coalesce(
    (auth.jwt() ->> 'email') in (
      'danieljson15@gmail.com',
      'juyds123@gmail.com'
    ),
    false
  );
$$;

grant execute on function public.is_memory_map_owner() to anon, authenticated;

-- =========================================================
-- Pins
-- =========================================================

create table if not exists public.pins (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('memory', 'wishlist')),
  lat double precision not null,
  lng double precision not null,
  title text not null,
  note text,
  embedding vector(1024),
  place_provider text,
  external_place_id text,
  user_rating smallint check (user_rating between 1 and 5),
  tags text[] not null default '{}',
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint pins_external_place_pair check (
    (place_provider is null and external_place_id is null)
    or (place_provider is not null and external_place_id is not null)
  )
);

-- Existing projects created from the earlier schema need these additions.
alter table public.pins
  add column if not exists place_provider text,
  add column if not exists external_place_id text,
  add column if not exists user_rating smallint,
  add column if not exists tags text[] not null default '{}',
  -- Owner-set coarse price tier (1 = budget-friendly ... 4 = splurge). Null
  -- means "unknown" and is never filtered out by a budget constraint.
  add column if not exists price_tier smallint,
  -- Sparse (keyword) leg of hybrid retrieval; maintained by the trigger below.
  add column if not exists search_tsv tsvector;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'pins_user_rating_check'
  ) then
    alter table public.pins
      add constraint pins_user_rating_check
      check (user_rating between 1 and 5);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'pins_price_tier_check'
  ) then
    alter table public.pins
      add constraint pins_price_tier_check
      check (price_tier between 1 and 4);
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'pins_external_place_pair'
  ) then
    alter table public.pins
      add constraint pins_external_place_pair
      check (
        (place_provider is null and external_place_id is null)
        or (place_provider is not null and external_place_id is not null)
      );
  end if;
end $$;

create index if not exists pins_kind_idx on public.pins (kind);
create index if not exists pins_external_place_idx
  on public.pins (place_provider, external_place_id)
  where external_place_id is not null;
create index if not exists pins_embedding_idx
  on public.pins using hnsw (embedding vector_cosine_ops);
create index if not exists pins_search_tsv_idx
  on public.pins using gin (search_tsv);

-- Keeps the keyword-search document in sync with what gets embedded (title,
-- note, tags). A trigger rather than a generated column because
-- array_to_string is only STABLE, and generated columns require IMMUTABLE.
create or replace function public.pins_update_search_tsv()
returns trigger
language plpgsql
as $$
begin
  new.search_tsv := to_tsvector(
    'english',
    coalesce(new.title, '') || ' ' ||
    coalesce(new.note, '') || ' ' ||
    coalesce(array_to_string(new.tags, ' '), '')
  );
  return new;
end;
$$;

drop trigger if exists pins_search_tsv on public.pins;
create trigger pins_search_tsv
  before insert or update of title, note, tags on public.pins
  for each row execute function public.pins_update_search_tsv();

-- One-time backfill for rows that predate the column; a no-op on re-runs.
update public.pins
set search_tsv = to_tsvector(
  'english',
  coalesce(title, '') || ' ' || coalesce(note, '') || ' ' ||
  coalesce(array_to_string(tags, ' '), '')
)
where search_tsv is null;

alter table public.pins enable row level security;

drop policy if exists "Authenticated users can read pins" on public.pins;
drop policy if exists "Authenticated users can insert pins" on public.pins;
drop policy if exists "Authenticated users can update pins" on public.pins;
drop policy if exists "Authenticated users can delete pins" on public.pins;
drop policy if exists "Anyone can read pins" on public.pins;
drop policy if exists "Only owners can insert pins" on public.pins;
drop policy if exists "Only owners can update pins" on public.pins;
drop policy if exists "Only owners can delete pins" on public.pins;

create policy "Anyone can read pins"
  on public.pins for select
  to public
  using (true);

create policy "Only owners can insert pins"
  on public.pins for insert
  to authenticated
  with check (public.is_memory_map_owner() and created_by = auth.uid());

create policy "Only owners can update pins"
  on public.pins for update
  to authenticated
  using (public.is_memory_map_owner())
  with check (public.is_memory_map_owner());

create policy "Only owners can delete pins"
  on public.pins for delete
  to authenticated
  using (public.is_memory_map_owner());

-- Public clients need the pin content, not the raw 1024-number embeddings.
-- The ranking RPC runs as its definer, so anonymous viewers can use ranked
-- results without being able to download the underlying vectors directly.
revoke select on public.pins from anon;
grant select (
  id, kind, lat, lng, title, note, place_provider, external_place_id,
  user_rating, tags, price_tier, created_by, created_at, updated_at
) on public.pins to anon;
grant select, insert, update, delete on public.pins to authenticated;

-- =========================================================
-- Pin photos
-- =========================================================

create table if not exists public.pin_photos (
  id uuid primary key default gen_random_uuid(),
  pin_id uuid not null references public.pins (id) on delete cascade,
  storage_path text not null,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create index if not exists pin_photos_pin_id_idx
  on public.pin_photos (pin_id);

alter table public.pin_photos enable row level security;

drop policy if exists "Authenticated users can read pin photos" on public.pin_photos;
drop policy if exists "Authenticated users can insert pin photos" on public.pin_photos;
drop policy if exists "Authenticated users can delete pin photos" on public.pin_photos;
drop policy if exists "Anyone can read pin photos" on public.pin_photos;
drop policy if exists "Only owners can insert pin photos" on public.pin_photos;
drop policy if exists "Only owners can delete pin photos" on public.pin_photos;

create policy "Anyone can read pin photos"
  on public.pin_photos for select
  to public
  using (true);

create policy "Only owners can insert pin photos"
  on public.pin_photos for insert
  to authenticated
  with check (public.is_memory_map_owner() and created_by = auth.uid());

create policy "Only owners can delete pin photos"
  on public.pin_photos for delete
  to authenticated
  using (public.is_memory_map_owner());

grant select on public.pin_photos to anon, authenticated;
grant insert, delete on public.pin_photos to authenticated;

-- =========================================================
-- Trips and checklist items (private to the two owners)
-- =========================================================

create table if not exists public.trips (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  start_date date,
  end_date date,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.trips enable row level security;

drop policy if exists "Authenticated users can read trips" on public.trips;
drop policy if exists "Authenticated users can insert trips" on public.trips;
drop policy if exists "Authenticated users can update trips" on public.trips;
drop policy if exists "Authenticated users can delete trips" on public.trips;
drop policy if exists "Anyone can read trips" on public.trips;
drop policy if exists "Only owners can read trips" on public.trips;
drop policy if exists "Only owners can insert trips" on public.trips;
drop policy if exists "Only owners can update trips" on public.trips;
drop policy if exists "Only owners can delete trips" on public.trips;

create policy "Only owners can read trips"
  on public.trips for select to authenticated
  using (public.is_memory_map_owner());
create policy "Only owners can insert trips"
  on public.trips for insert to authenticated
  with check (public.is_memory_map_owner() and created_by = auth.uid());
create policy "Only owners can update trips"
  on public.trips for update to authenticated
  using (public.is_memory_map_owner())
  with check (public.is_memory_map_owner());
create policy "Only owners can delete trips"
  on public.trips for delete to authenticated
  using (public.is_memory_map_owner());

grant select, insert, update, delete on public.trips to authenticated;

-- =========================================================
-- External API response cache (Voyage embeddings, Google Places)
-- =========================================================
--
-- Key is a hash of the normalized request (see lib/cache.ts) — same
-- input always maps to the same key, so a repeat request is a cache
-- hit regardless of which route made it. Every read/write happens from
-- an already owner-gated code path (the embedding/Places calls this
-- backs are themselves behind getOwnerAccess or the service-role
-- backfill script), so this follows the plain authenticated+owner RLS
-- pattern used by trips/checklist_items, not the security-definer-
-- function pattern google_api_usage needed for anonymous access.

create table if not exists public.api_cache (
  key text primary key,
  value jsonb not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists api_cache_expires_at_idx on public.api_cache (expires_at);

alter table public.api_cache enable row level security;

drop policy if exists "Only owners can read cache" on public.api_cache;
drop policy if exists "Only owners can insert cache" on public.api_cache;
drop policy if exists "Only owners can update cache" on public.api_cache;
drop policy if exists "Only owners can delete cache" on public.api_cache;

create policy "Only owners can read cache"
  on public.api_cache for select to authenticated
  using (public.is_memory_map_owner());
create policy "Only owners can insert cache"
  on public.api_cache for insert to authenticated
  with check (public.is_memory_map_owner());
create policy "Only owners can update cache"
  on public.api_cache for update to authenticated
  using (public.is_memory_map_owner())
  with check (public.is_memory_map_owner());
create policy "Only owners can delete cache"
  on public.api_cache for delete to authenticated
  using (public.is_memory_map_owner());

grant select, insert, update, delete on public.api_cache to authenticated;

create table if not exists public.checklist_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references public.trips (id) on delete cascade,
  text text not null,
  is_done boolean not null default false,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create index if not exists checklist_items_trip_id_idx
  on public.checklist_items (trip_id);

alter table public.checklist_items enable row level security;

drop policy if exists "Authenticated users can read checklist items" on public.checklist_items;
drop policy if exists "Authenticated users can insert checklist items" on public.checklist_items;
drop policy if exists "Authenticated users can update checklist items" on public.checklist_items;
drop policy if exists "Authenticated users can delete checklist items" on public.checklist_items;
drop policy if exists "Anyone can read checklist items" on public.checklist_items;
drop policy if exists "Only owners can read checklist items" on public.checklist_items;
drop policy if exists "Only owners can insert checklist items" on public.checklist_items;
drop policy if exists "Only owners can update checklist items" on public.checklist_items;
drop policy if exists "Only owners can delete checklist items" on public.checklist_items;

create policy "Only owners can read checklist items"
  on public.checklist_items for select to authenticated
  using (public.is_memory_map_owner());
create policy "Only owners can insert checklist items"
  on public.checklist_items for insert to authenticated
  with check (public.is_memory_map_owner() and created_by = auth.uid());
create policy "Only owners can update checklist items"
  on public.checklist_items for update to authenticated
  using (public.is_memory_map_owner())
  with check (public.is_memory_map_owner());
create policy "Only owners can delete checklist items"
  on public.checklist_items for delete to authenticated
  using (public.is_memory_map_owner());

grant select, insert, update, delete on public.checklist_items to authenticated;

-- =========================================================
-- AI suggestions and reasoning steps (private to the two owners)
-- =========================================================

create table if not exists public.suggestions (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running'
    check (status in ('running', 'complete', 'failed')),
  budget numeric,
  departure_airport text,
  travel_month text,
  nights integer,
  destination text,
  cost_breakdown jsonb,
  total_cost numeric,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table public.suggestions enable row level security;

drop policy if exists "Authenticated users can read suggestions" on public.suggestions;
drop policy if exists "Authenticated users can insert suggestions" on public.suggestions;
drop policy if exists "Authenticated users can update suggestions" on public.suggestions;
drop policy if exists "Anyone can read suggestions" on public.suggestions;
drop policy if exists "Only owners can read suggestions" on public.suggestions;
drop policy if exists "Only owners can insert suggestions" on public.suggestions;
drop policy if exists "Only owners can update suggestions" on public.suggestions;

create policy "Only owners can read suggestions"
  on public.suggestions for select to authenticated
  using (public.is_memory_map_owner());
create policy "Only owners can insert suggestions"
  on public.suggestions for insert to authenticated
  with check (public.is_memory_map_owner() and created_by = auth.uid());
create policy "Only owners can update suggestions"
  on public.suggestions for update to authenticated
  using (public.is_memory_map_owner())
  with check (public.is_memory_map_owner());

grant select, insert, update on public.suggestions to authenticated;

create table if not exists public.suggestion_steps (
  id uuid primary key default gen_random_uuid(),
  suggestion_id uuid not null references public.suggestions (id) on delete cascade,
  step_order integer not null,
  kind text not null check (kind in ('text', 'tool_call')),
  content jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists suggestion_steps_suggestion_id_idx
  on public.suggestion_steps (suggestion_id);

alter table public.suggestion_steps enable row level security;

drop policy if exists "Authenticated users can read suggestion steps" on public.suggestion_steps;
drop policy if exists "Authenticated users can insert suggestion steps" on public.suggestion_steps;
drop policy if exists "Anyone can read suggestion steps" on public.suggestion_steps;
drop policy if exists "Only owners can read suggestion steps" on public.suggestion_steps;
drop policy if exists "Only owners can insert suggestion steps" on public.suggestion_steps;

create policy "Only owners can read suggestion steps"
  on public.suggestion_steps for select to authenticated
  using (public.is_memory_map_owner());
create policy "Only owners can insert suggestion steps"
  on public.suggestion_steps for insert to authenticated
  with check (public.is_memory_map_owner());

grant select, insert on public.suggestion_steps to authenticated;

-- =========================================================
-- Google API usage tracking (usage-based fallback for maps/search)
-- =========================================================
--
-- Tracks two independent monthly counters — Maps JavaScript API loads,
-- and Places API requests (autocomplete + details + nearby combined) —
-- so the app can degrade itself before Google's own billing kicks in.
-- A Cloud Console quota or budget alert alone cannot promise a $0 bill;
-- this table plus the app-level checks in lib/usage.ts are the actual
-- control. The table is locked down entirely — no policy grants any
-- role direct access — because the only supported way to touch it is
-- through the two security-definer functions below, which is what lets
-- an anonymous public map visitor safely record/read usage without any
-- table-level grant, the same way is_memory_map_owner() is the only
-- door into checking ownership.

create table if not exists public.google_api_usage (
  kind text not null check (kind in ('maps_js_load', 'places_request')),
  period text not null, -- 'YYYY-MM', UTC calendar month
  count integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (kind, period)
);

-- 'public_places_request' tracks unauthenticated demo traffic (the public
-- suggester and nearby-recommendations pages) on its own counter, separate
-- from 'places_request' (the owners' own usage) — so a spike in public
-- demo traffic can't eat the budget the owners rely on for their own
-- search. Re-applied on every run since the table may already exist from
-- an earlier version of this schema with the narrower check.
alter table public.google_api_usage drop constraint if exists google_api_usage_kind_check;
alter table public.google_api_usage
  add constraint google_api_usage_kind_check
  check (kind in ('maps_js_load', 'places_request', 'public_places_request'));

alter table public.google_api_usage enable row level security;
revoke all on public.google_api_usage from public, anon, authenticated;

create or replace function public.increment_google_api_usage(p_kind text)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  new_count integer;
  current_period text := to_char(now() at time zone 'utc', 'YYYY-MM');
begin
  if p_kind not in ('maps_js_load', 'places_request', 'public_places_request') then
    raise exception 'Unknown Google API usage kind: %', p_kind;
  end if;

  insert into public.google_api_usage (kind, period, count)
  values (p_kind, current_period, 1)
  on conflict (kind, period)
    do update set count = public.google_api_usage.count + 1,
                  updated_at = now()
  returning count into new_count;

  return new_count;
end;
$$;

create or replace function public.get_google_api_usage(p_kind text)
returns integer
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select count from public.google_api_usage
     where kind = p_kind
       and period = to_char(now() at time zone 'utc', 'YYYY-MM')),
    0
  );
$$;

-- Both are called before any Google Maps/Places call is made, including
-- by anonymous public map visitors, so both are granted to anon.
grant execute on function public.increment_google_api_usage(text) to anon, authenticated;
grant execute on function public.get_google_api_usage(text) to anon, authenticated;

-- =========================================================
-- Rate limiting (public, unauthenticated routes)
-- =========================================================
--
-- google_api_usage above is a monthly cost breaker; it doesn't stop a
-- single client from hammering a public route many times a second. This
-- is a short fixed-window (e.g. per-minute) counter per (route, client)
-- pair, checked by lib/rate-limit.ts in front of routes that take no
-- session at all — GET /api/pins and GET /api/maps-config. Like
-- google_api_usage, the table has no direct grants; check_rate_limit is
-- the only door in, so an anonymous visitor can be rate-limited without
-- any table-level access.

create table if not exists public.rate_limits (
  bucket_key text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket_key, window_start)
);

create index if not exists rate_limits_window_start_idx
  on public.rate_limits (window_start);

alter table public.rate_limits enable row level security;
revoke all on public.rate_limits from public, anon, authenticated;

-- Atomic check-and-increment in one round trip (unlike the two-step
-- check-then-increment in increment_google_api_usage/get_google_api_usage
-- above, which accepts a small race as a soft breaker over a whole
-- month). A per-minute window is tight enough that concurrent public
-- requests need a real atomic increment or several could slip through
-- the same window at once.
create or replace function public.check_rate_limit(
  p_key text,
  p_window_seconds integer,
  p_limit integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  bucket timestamptz := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );
  new_count integer;
begin
  insert into public.rate_limits (bucket_key, window_start, count)
  values (p_key, bucket, 1)
  on conflict (bucket_key, window_start)
    do update set count = public.rate_limits.count + 1
  returning count into new_count;

  -- Opportunistic cleanup of expired buckets, amortized across calls
  -- rather than run on every request or via a separate scheduled job.
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 hour';
  end if;

  return new_count <= p_limit;
end;
$$;

grant execute on function public.check_rate_limit(text, integer, integer) to anon, authenticated;

-- =========================================================
-- updated_at maintenance
-- =========================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists pins_set_updated_at on public.pins;
create trigger pins_set_updated_at
  before update on public.pins
  for each row execute function public.set_updated_at();

drop trigger if exists trips_set_updated_at on public.trips;
create trigger trips_set_updated_at
  before update on public.trips
  for each row execute function public.set_updated_at();

-- =========================================================
-- Public photo storage; writes remain owner-only.
-- =========================================================

insert into storage.buckets (id, name, public)
values ('photos', 'photos', true)
on conflict (id) do update set public = excluded.public;

drop policy if exists "Authenticated users can upload photos" on storage.objects;
drop policy if exists "Authenticated users can read photos" on storage.objects;
drop policy if exists "Authenticated users can delete photos" on storage.objects;
drop policy if exists "Anyone can view photos" on storage.objects;
drop policy if exists "Only owners can upload photos" on storage.objects;
drop policy if exists "Only owners can delete photos" on storage.objects;

create policy "Anyone can view photos"
  on storage.objects for select
  to public
  using (bucket_id = 'photos');

create policy "Only owners can upload photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'photos'
    and public.is_memory_map_owner()
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "Only owners can delete photos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'photos' and public.is_memory_map_owner());
