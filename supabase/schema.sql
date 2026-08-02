-- Memory Map — full schema
-- Run this whole file once in the Supabase SQL Editor for your project.
-- Supersedes the earlier MVP schema — this adds photos as a separate
-- table, kind (memory/wishlist), embeddings, trips, checklist, and the
-- AI suggester's tables.

create extension if not exists vector;

-- =========================================================
-- Pins
-- =========================================================

create table if not exists pins (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('memory', 'wishlist')),
  lat double precision not null,
  lng double precision not null,
  title text not null,
  note text,
  -- voyage-3.5-lite / voyage-4-lite at 1024 dimensions (default).
  -- If you pick a different embeddings model, this must match its
  -- output dimension exactly, or inserts will fail.
  embedding vector(1024),
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists pins_kind_idx on pins (kind);

-- Cosine-similarity index for the AI suggester's taste-ranking step.
-- HNSW works without needing the table pre-populated first, unlike
-- ivfflat, so it's safe to create right away even with an empty table.
create index if not exists pins_embedding_idx
  on pins using hnsw (embedding vector_cosine_ops);

alter table pins enable row level security;

create policy "Authenticated users can read pins"
  on pins for select
  to authenticated
  using (true);

create policy "Authenticated users can insert pins"
  on pins for insert
  to authenticated
  with check (true);

create policy "Authenticated users can update pins"
  on pins for update
  to authenticated
  using (true);

create policy "Authenticated users can delete pins"
  on pins for delete
  to authenticated
  using (true);

-- =========================================================
-- Pin photos
-- One pin can have several photos, uploaded directly to storage from
-- the browser, then registered here via POST /api/pins/:id/photos.
-- =========================================================

create table if not exists pin_photos (
  id uuid primary key default gen_random_uuid(),
  pin_id uuid not null references pins (id) on delete cascade,
  storage_path text not null,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create index if not exists pin_photos_pin_id_idx on pin_photos (pin_id);

alter table pin_photos enable row level security;

create policy "Authenticated users can read pin photos"
  on pin_photos for select
  to authenticated
  using (true);

create policy "Authenticated users can insert pin photos"
  on pin_photos for insert
  to authenticated
  with check (true);

create policy "Authenticated users can delete pin photos"
  on pin_photos for delete
  to authenticated
  using (true);

-- =========================================================
-- Trips
-- =========================================================

create table if not exists trips (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  start_date date,
  end_date date,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table trips enable row level security;

create policy "Authenticated users can read trips"
  on trips for select
  to authenticated
  using (true);

create policy "Authenticated users can insert trips"
  on trips for insert
  to authenticated
  with check (true);

create policy "Authenticated users can update trips"
  on trips for update
  to authenticated
  using (true);

create policy "Authenticated users can delete trips"
  on trips for delete
  to authenticated
  using (true);

-- =========================================================
-- Checklist items
-- =========================================================

create table if not exists checklist_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips (id) on delete cascade,
  text text not null,
  is_done boolean not null default false,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

create index if not exists checklist_items_trip_id_idx
  on checklist_items (trip_id);

alter table checklist_items enable row level security;

create policy "Authenticated users can read checklist items"
  on checklist_items for select
  to authenticated
  using (true);

create policy "Authenticated users can insert checklist items"
  on checklist_items for insert
  to authenticated
  with check (true);

create policy "Authenticated users can update checklist items"
  on checklist_items for update
  to authenticated
  using (true);

create policy "Authenticated users can delete checklist items"
  on checklist_items for delete
  to authenticated
  using (true);

-- =========================================================
-- AI suggester: suggestions + their reasoning steps
-- =========================================================

create table if not exists suggestions (
  id uuid primary key default gen_random_uuid(),
  status text not null default 'running'
    check (status in ('running', 'complete', 'failed')),
  budget numeric,
  departure_airport text,
  travel_month text,
  nights integer,
  destination text,
  -- flights / lodging / food / activities, each line editable client-side,
  -- totals recomputed server-side per the brief
  cost_breakdown jsonb,
  total_cost numeric,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

alter table suggestions enable row level security;

create policy "Authenticated users can read suggestions"
  on suggestions for select
  to authenticated
  using (true);

create policy "Authenticated users can insert suggestions"
  on suggestions for insert
  to authenticated
  with check (true);

create policy "Authenticated users can update suggestions"
  on suggestions for update
  to authenticated
  using (true);

create table if not exists suggestion_steps (
  id uuid primary key default gen_random_uuid(),
  suggestion_id uuid not null references suggestions (id) on delete cascade,
  step_order integer not null,
  kind text not null check (kind in ('text', 'tool_call')),
  content jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists suggestion_steps_suggestion_id_idx
  on suggestion_steps (suggestion_id);

alter table suggestion_steps enable row level security;

create policy "Authenticated users can read suggestion steps"
  on suggestion_steps for select
  to authenticated
  using (true);

create policy "Authenticated users can insert suggestion steps"
  on suggestion_steps for insert
  to authenticated
  with check (true);

-- =========================================================
-- updated_at maintenance
-- =========================================================

create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

create trigger pins_set_updated_at
  before update on pins
  for each row execute function set_updated_at();

create trigger trips_set_updated_at
  before update on trips
  for each row execute function set_updated_at();

-- =========================================================
-- Storage bucket for photos — PRIVATE.
-- The brief calls for signed URLs generated client-side, not public
-- URLs, so this bucket must not be public like the MVP's was.
-- =========================================================

insert into storage.buckets (id, name, public)
values ('photos', 'photos', false)
on conflict (id) do nothing;

create policy "Authenticated users can upload photos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'photos');

create policy "Authenticated users can read photos"
  on storage.objects for select
  to authenticated
  using (bucket_id = 'photos');

create policy "Authenticated users can delete photos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'photos');