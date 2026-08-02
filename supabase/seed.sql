-- Realistic seed data so the frontend can be built against real-shaped
-- data before the real backend logic (embeddings, the suggester) exists.
-- Run this after schema.sql. Safe to re-run — it clears its own data
-- first rather than duplicating rows on every run.

-- Uses whichever account already exists (created during auth testing) —
-- doesn't matter which of the two accounts owns the seed rows for a
-- shared two-person app.
do $$
declare
  seed_user_id uuid;
  trip1_id uuid;
  sugg1_id uuid;
  pin1_id uuid;
begin
  select id into seed_user_id from auth.users limit 1;

  if seed_user_id is null then
    raise exception 'No user found in auth.users — sign up in the app at least once before seeding.';
  end if;

  -- Clear previous seed runs
  delete from suggestion_steps;
  delete from suggestions;
  delete from checklist_items;
  delete from trips;
  delete from pin_photos;
  delete from pins;

  -- Pins: a mix of memories and wishlist spots
  insert into pins (kind, lat, lng, title, note, created_by)
  values ('memory', 48.8566, 2.3522, 'Paris — first trip together',
    'Croissants every morning, got lost near Montmartre on purpose.', seed_user_id)
  returning id into pin1_id;

  insert into pin_photos (pin_id, storage_path, created_by)
  values (pin1_id, 'seed/paris-1.jpg', seed_user_id);

  insert into pins (kind, lat, lng, title, note, created_by)
  values
    ('memory', 41.9028, 12.4964, 'Rome weekend',
     'Trevi Fountain at 6am before the crowds. Best carbonara of the trip.',
     seed_user_id),
    ('wishlist', 38.7223, -9.1393, 'Lisbon',
     'Keeps coming up — pastel de nata and the tram 28 route.', seed_user_id),
    ('wishlist', 41.1579, -8.6291, 'Porto',
     'Cheaper than Lisbon, similar vibe, worth comparing.', seed_user_id),
    ('wishlist', 45.4408, 12.3155, 'Venice',
     'Off-season, to avoid the worst of the crowds.', seed_user_id);

  -- A trip with a checklist
  insert into trips (title, start_date, end_date, created_by)
  values ('Copenhagen semester', '2026-08-15', '2026-12-15', seed_user_id)
  returning id into trip1_id;

  insert into checklist_items (trip_id, text, is_done, created_by)
  values
    (trip1_id, 'Book flights', true, seed_user_id),
    (trip1_id, 'Sort out housing', true, seed_user_id),
    (trip1_id, 'Get a European SIM / eSIM', false, seed_user_id),
    (trip1_id, 'Confirm DIS course registration', false, seed_user_id);

  -- A completed suggestion with a full reasoning trace, per the brief
  insert into suggestions (
    status, budget, departure_airport, travel_month, nights,
    destination, cost_breakdown, total_cost, created_by, completed_at
  )
  values (
    'complete', 2000, 'CPH', 'October', 4,
    'Porto',
    '{"flights": 220, "lodging": 480, "food": 260, "activities": 120}'::jsonb,
    1080,
    seed_user_id,
    now()
  )
  returning id into sugg1_id;

  insert into suggestion_steps (suggestion_id, step_order, kind, content)
  values
    (sugg1_id, 1, 'text',
     '{"text": "Considering Lisbon based on your wishlist and past trips..."}'::jsonb),
    (sugg1_id, 2, 'tool_call',
     '{"tool": "price_flights", "input": {"from": "CPH", "to": "LIS", "month": "October"}, "result": {"price": 340}}'::jsonb),
    (sugg1_id, 3, 'text',
     '{"text": "Lisbon flights alone are 340 EUR — checking Porto as a cheaper alternative with a similar feel."}'::jsonb),
    (sugg1_id, 4, 'tool_call',
     '{"tool": "price_flights", "input": {"from": "CPH", "to": "OPO", "month": "October"}, "result": {"price": 220}}'::jsonb),
    (sugg1_id, 5, 'tool_call',
     '{"tool": "price_lodging", "input": {"city": "Porto", "nights": 4}, "result": {"total": 480}}'::jsonb),
    (sugg1_id, 6, 'text',
     '{"text": "Porto totals 1080 EUR against a 2000 EUR budget — well within range. Finalizing."}'::jsonb);

  raise notice 'Seed complete: % pins, 1 trip with 4 checklist items, 1 completed suggestion with 6 steps',
    (select count(*) from pins);
end $$;
