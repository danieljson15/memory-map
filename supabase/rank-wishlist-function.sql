-- Ranks wishlist pins by embedding similarity to a "taste vector" —
-- the average embedding of all memory pins.
--
-- rank_wishlist_by_taste (below) is the dense-only baseline. The app itself
-- calls rank_wishlist_hybrid, defined at the bottom of this file, which
-- fuses this dense ranking with a keyword ranking and applies location and
-- price-tier constraints. The baseline stays defined so an offline
-- evaluation can compare dense-only against hybrid on the same data.
--
-- Run this in the Supabase SQL Editor after schema.sql.

create or replace function rank_wishlist_by_taste(match_count int default 10)
returns table (
  id uuid,
  title text,
  note text,
  lat double precision,
  lng double precision,
  similarity float
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  taste_vector vector(1024);
  safe_match_count int := greatest(1, least(coalesce(match_count, 10), 50));
begin
  select avg(embedding) into taste_vector
  from pins
  where kind = 'memory'
    and embedding is not null
    -- Unrated memories preserve the original behavior. Explicitly low-rated
    -- places should not pull the positive taste centroid toward things the
    -- owners disliked.
    and (user_rating is null or user_rating >= 3);

  -- No memory pins with embeddings yet — nothing to rank against.
  -- Return an empty result rather than erroring, so the frontend can
  -- show "add some memories first" instead of a 500.
  if taste_vector is null then
    return;
  end if;

  return query
    select
      p.id,
      p.title,
      p.note,
      p.lat,
      p.lng,
      (1 - (p.embedding <=> taste_vector))::float as similarity
    from pins p
    where p.kind = 'wishlist' and p.embedding is not null
    order by p.embedding <=> taste_vector
    limit safe_match_count;
end;
$$;

-- Matches the "anyone can read pins" policy — this is a read-only
-- ranking over already-public data, safe to expose the same way.
grant execute on function rank_wishlist_by_taste(int) to anon, authenticated;


-- =========================================================
-- Hybrid retrieval: dense (pgvector) + sparse (full-text) + constraints
-- =========================================================
--
-- 1. Constraints first. Wishlist pins outside the radius (haversine, km)
--    or above the price tier are dropped. A pin with no price tier is
--    unknown, not expensive, so it is never filtered out by budget.
-- 2. Dense ranking: cosine similarity to the taste vector (same centroid
--    as rank_wishlist_by_taste, excluding low-rated memories).
-- 3. Sparse ranking: Postgres full-text search over title, note, and tags
--    using websearch_to_tsquery, ordered by ts_rank_cd. Only pins that
--    actually match get a sparse rank.
-- 4. Fusion: reciprocal rank fusion, score = 1/(60 + dense_rank) +
--    1/(60 + sparse_rank). RRF combines ranks rather than raw scores, so
--    cosine similarity and ts_rank_cd, which live on incomparable scales,
--    need no normalization. k = 60 is the value from the original RRF paper.
--    Keywords boost matching pins; they do not exclude non-matching ones.
--    With no keyword query the result is dense-only, in the same order as
--    rank_wishlist_by_taste.

create or replace function rank_wishlist_hybrid(
  match_count int default 10,
  keyword_query text default null,
  center_lat double precision default null,
  center_lng double precision default null,
  radius_km double precision default null,
  max_price_tier int default null
)
returns table (
  id uuid,
  title text,
  note text,
  lat double precision,
  lng double precision,
  price_tier smallint,
  similarity float,
  dense_position int,
  sparse_position int,
  keyword_match boolean,
  distance_km float,
  rrf_score float
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  taste_vector vector(1024);
  safe_match_count int := greatest(1, least(coalesce(match_count, 10), 50));
  tsq tsquery;
  use_location boolean :=
    center_lat is not null and center_lng is not null
    and radius_km is not null and radius_km > 0;
  rrf_k constant int := 60;
begin
  select avg(embedding) into taste_vector
  from pins
  where kind = 'memory'
    and embedding is not null
    and (user_rating is null or user_rating >= 3);

  if taste_vector is null then
    return;
  end if;

  if keyword_query is not null and btrim(keyword_query) <> '' then
    tsq := websearch_to_tsquery('english', keyword_query);
  end if;

  return query
  with candidates as (
    select
      p.id as pin_id,
      p.title as pin_title,
      p.note as pin_note,
      p.lat as pin_lat,
      p.lng as pin_lng,
      p.price_tier as pin_price_tier,
      p.search_tsv as pin_tsv,
      (1 - (p.embedding <=> taste_vector))::float as sim,
      case when use_location then
        (6371 * 2 * asin(sqrt(least(1,
          power(sin(radians(p.lat - center_lat) / 2), 2)
          + cos(radians(center_lat)) * cos(radians(p.lat))
            * power(sin(radians(p.lng - center_lng) / 2), 2)
        ))))::float
      end as dist_km
    from pins p
    where p.kind = 'wishlist'
      and p.embedding is not null
      and (max_price_tier is null
           or p.price_tier is null
           or p.price_tier <= max_price_tier)
  ),
  in_range as (
    select c.* from candidates c
    where not use_location or c.dist_km <= radius_km
  ),
  dense as (
    select r.*, (row_number() over (order by r.sim desc))::int as d_pos
    from in_range r
  ),
  sparse as (
    select
      d.pin_id,
      (row_number() over (
        order by ts_rank_cd(d.pin_tsv, tsq) desc, d.sim desc
      ))::int as s_pos
    from dense d
    where tsq is not null and d.pin_tsv @@ tsq
  )
  select
    d.pin_id,
    d.pin_title,
    d.pin_note,
    d.pin_lat,
    d.pin_lng,
    d.pin_price_tier,
    d.sim,
    d.d_pos,
    s.s_pos,
    (s.s_pos is not null),
    d.dist_km,
    (1.0 / (rrf_k + d.d_pos)
      + coalesce(1.0 / (rrf_k + s.s_pos), 0))::float
  from dense d
  left join sparse s on s.pin_id = d.pin_id
  order by
    (1.0 / (rrf_k + d.d_pos) + coalesce(1.0 / (rrf_k + s.s_pos), 0)) desc,
    d.d_pos asc
  limit safe_match_count;
end;
$$;

grant execute on function rank_wishlist_hybrid(
  int, text, double precision, double precision, double precision, int
) to anon, authenticated;
