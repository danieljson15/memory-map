-- Public read / owner-only write.
-- Run this in the Supabase SQL Editor AFTER schema.sql. Replaces the
-- earlier "any authenticated user can do anything" policies — those
-- only made sense while sign-up was meant to be invite-only, which it
-- currently isn't (see AuthScreen.tsx: open self-service sign-up).
--
-- BEFORE RUNNING: replace the two placeholder emails below with your
-- real two accounts' emails.

-- =========================================================
-- Config: the only two identities allowed to write
-- =========================================================
-- Using email via auth.jwt() rather than hardcoded UUIDs — means you
-- don't need to look up user IDs first, and it still works cleanly if
-- an account ever needs to be recreated.

-- =========================================================
-- Pins
-- =========================================================

drop policy if exists "Authenticated users can read pins" on pins;
drop policy if exists "Authenticated users can insert pins" on pins;
drop policy if exists "Authenticated users can update pins" on pins;
drop policy if exists "Authenticated users can delete pins" on pins;

drop policy if exists "Anyone can read pins" on pins;
create policy "Anyone can read pins"
  on pins for select
  to public
  using (true);

drop policy if exists "Only owners can insert pins" on pins;
create policy "Only owners can insert pins"
  on pins for insert
  to authenticated
  with check (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

drop policy if exists "Only owners can update pins" on pins;
create policy "Only owners can update pins"
  on pins for update
  to authenticated
  using (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

drop policy if exists "Only owners can delete pins" on pins;
create policy "Only owners can delete pins"
  on pins for delete
  to authenticated
  using (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

-- =========================================================
-- Pin photos
-- =========================================================

drop policy if exists "Authenticated users can read pin photos" on pin_photos;
drop policy if exists "Authenticated users can insert pin photos" on pin_photos;
drop policy if exists "Authenticated users can delete pin photos" on pin_photos;

drop policy if exists "Anyone can read pin photos" on pin_photos;
create policy "Anyone can read pin photos"
  on pin_photos for select
  to public
  using (true);

drop policy if exists "Only owners can insert pin photos" on pin_photos;
create policy "Only owners can insert pin photos"
  on pin_photos for insert
  to authenticated
  with check (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

drop policy if exists "Only owners can delete pin photos" on pin_photos;
create policy "Only owners can delete pin photos"
  on pin_photos for delete
  to authenticated
  using (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

-- =========================================================
-- Trips
-- =========================================================

drop policy if exists "Authenticated users can read trips" on trips;
drop policy if exists "Authenticated users can insert trips" on trips;
drop policy if exists "Authenticated users can update trips" on trips;
drop policy if exists "Authenticated users can delete trips" on trips;

drop policy if exists "Anyone can read trips" on trips;
create policy "Anyone can read trips"
  on trips for select
  to public
  using (true);

drop policy if exists "Only owners can insert trips" on trips;
create policy "Only owners can insert trips"
  on trips for insert
  to authenticated
  with check (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

drop policy if exists "Only owners can update trips" on trips;
create policy "Only owners can update trips"
  on trips for update
  to authenticated
  using (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

drop policy if exists "Only owners can delete trips" on trips;
create policy "Only owners can delete trips"
  on trips for delete
  to authenticated
  using (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

-- =========================================================
-- Checklist items
-- =========================================================

drop policy if exists "Authenticated users can read checklist items" on checklist_items;
drop policy if exists "Authenticated users can insert checklist items" on checklist_items;
drop policy if exists "Authenticated users can update checklist items" on checklist_items;
drop policy if exists "Authenticated users can delete checklist items" on checklist_items;

drop policy if exists "Anyone can read checklist items" on checklist_items;
create policy "Anyone can read checklist items"
  on checklist_items for select
  to public
  using (true);

drop policy if exists "Only owners can insert checklist items" on checklist_items;
create policy "Only owners can insert checklist items"
  on checklist_items for insert
  to authenticated
  with check (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

drop policy if exists "Only owners can update checklist items" on checklist_items;
create policy "Only owners can update checklist items"
  on checklist_items for update
  to authenticated
  using (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

drop policy if exists "Only owners can delete checklist items" on checklist_items;
create policy "Only owners can delete checklist items"
  on checklist_items for delete
  to authenticated
  using (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

-- =========================================================
-- Suggestions + steps
-- =========================================================

drop policy if exists "Authenticated users can read suggestions" on suggestions;
drop policy if exists "Authenticated users can insert suggestions" on suggestions;
drop policy if exists "Authenticated users can update suggestions" on suggestions;

drop policy if exists "Anyone can read suggestions" on suggestions;
create policy "Anyone can read suggestions"
  on suggestions for select
  to public
  using (true);

drop policy if exists "Only owners can insert suggestions" on suggestions;
create policy "Only owners can insert suggestions"
  on suggestions for insert
  to authenticated
  with check (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

drop policy if exists "Only owners can update suggestions" on suggestions;
create policy "Only owners can update suggestions"
  on suggestions for update
  to authenticated
  using (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

drop policy if exists "Authenticated users can read suggestion steps" on suggestion_steps;
drop policy if exists "Authenticated users can insert suggestion steps" on suggestion_steps;

drop policy if exists "Anyone can read suggestion steps" on suggestion_steps;
create policy "Anyone can read suggestion steps"
  on suggestion_steps for select
  to public
  using (true);

drop policy if exists "Only owners can insert suggestion steps" on suggestion_steps;
create policy "Only owners can insert suggestion steps"
  on suggestion_steps for insert
  to authenticated
  with check (
    (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

-- =========================================================
-- Storage: photos bucket
-- Public content now, so this goes back to public + getPublicUrl(),
-- same pattern as the original MVP — the private + signed-URL approach
-- only made sense while photos were meant to be private.
-- =========================================================

update storage.buckets set public = true where id = 'photos';

drop policy if exists "Authenticated users can upload photos" on storage.objects;
drop policy if exists "Authenticated users can read photos" on storage.objects;
drop policy if exists "Authenticated users can delete photos" on storage.objects;

drop policy if exists "Anyone can view photos" on storage.objects;
create policy "Anyone can view photos"
  on storage.objects for select
  to public
  using (bucket_id = 'photos');

drop policy if exists "Only owners can upload photos" on storage.objects;
create policy "Only owners can upload photos"
  on storage.objects for insert
  to authenticated
  with check (
    bucket_id = 'photos'
    and (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );

drop policy if exists "Only owners can delete photos" on storage.objects;
create policy "Only owners can delete photos"
  on storage.objects for delete
  to authenticated
  using (
    bucket_id = 'photos'
    and (auth.jwt() ->> 'email') in ('you@example.com', 'partner@example.com')
  );