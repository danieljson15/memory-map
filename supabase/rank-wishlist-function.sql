-- Ranks wishlist pins by embedding similarity to a "taste vector" —
-- the average embedding of all memory pins. This is the retrieval step
-- the AI suggester's ranking will eventually build on; usable on its
-- own right now as a genuine "embeddings do something" milestone.
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
as $$
declare
  taste_vector vector(1024);
begin
  select avg(embedding) into taste_vector
  from pins
  where kind = 'memory' and embedding is not null;

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
    limit match_count;
end;
$$;

-- Matches the "anyone can read pins" policy — this is a read-only
-- ranking over already-public data, safe to expose the same way.
grant execute on function rank_wishlist_by_taste(int) to anon, authenticated;
