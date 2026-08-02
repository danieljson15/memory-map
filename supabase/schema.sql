-- Run this whole file once in the Supabase SQL Editor for your project.

-- 1. Pins table
create table if not exists pins (
  id uuid primary key default gen_random_uuid(),
  lat double precision not null,
  lng double precision not null,
  title text not null,
  note text,
  photo_url text,
  created_by uuid not null references auth.users (id),
  created_at timestamptz not null default now()
);

alter table pins enable row level security;

-- Any signed-in user of this app can read/write all pins. This app is
-- meant for a small, invite-only pair of accounts (you create both logins
-- yourself in the Supabase dashboard), so "authenticated" is the whole
-- trust boundary rather than per-row ownership.
create policy "Authenticated users can read pins"
  on pins for select
  to authenticated
  using (true);

create policy "Authenticated users can insert pins"
  on pins for insert
  to authenticated
  with check (true);

create policy "Authenticated users can delete pins"
  on pins for delete
  to authenticated
  using (true);

-- 2. Storage bucket for pin photos
insert into storage.buckets (id, name, public)
values ('pin-photos', 'pin-photos', true)
on conflict (id) do nothing;

create policy "Authenticated users can upload pin photos"
  on storage.objects for insert
  to authenticated
  with check (bucket_id = 'pin-photos');

create policy "Anyone can view pin photos"
  on storage.objects for select
  to public
  using (bucket_id = 'pin-photos');

create policy "Authenticated users can delete pin photos"
  on storage.objects for delete
  to authenticated
  using (bucket_id = 'pin-photos');
