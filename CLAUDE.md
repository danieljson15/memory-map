# Memory Map developer notes

## Product boundary

Memory Map is a public-read, owner-write travel map. Anyone can view pins and
photos. Only the two emails configured in `supabase/schema.sql` may write or
call metered recommendation routes. Trips, checklists, and AI suggestion
history remain private to those owners.

## Commands

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run typecheck
npm run embed:backfill
```

There is no automated test suite yet. `.github/workflows/ci.yml` runs lint,
typecheck, and build on push/PR to `main` — it's a merge gate, separate from
Vercel's own build-on-push, which only proves the code builds and doesn't
block a bad push to main before it deploys.

## Architecture

- `app/page.tsx` owns the Supabase browser session and modal/navigation state.
- `components/MapView.tsx` loads Google Maps lazily, fetches public pins through
  `/api/pins`, renders advanced markers, and opens `PinModal` for map clicks or
  canonical Google Places selections.
- `components/SearchBox.tsx` calls the authenticated autocomplete/details
  routes. It maintains a UUID session token across typing and selection.
- `components/PinModal.tsx` uploads optional photos directly to the public-read
  `photos` bucket, but creates pins and registers photo metadata through API
  routes. Pin creation must continue to go through `/api/pins` so embedding is
  not bypassed.
- `components/NearbyRecommendationsModal.tsx` asks the server for live nearby
  candidates and saves explicit selections as wishlist pins.
- `app/api/recommendations/nearby/route.ts` loads positive and negative memory
  signals, obtains three bounded Google Nearby result groups, batch-embeds
  candidates, and ranks them in `lib/recommendations.ts`.
- `app/api/suggest/route.ts` is the separate destination-level trip suggester.
  It ranks stored wishlist rows with `rank_wishlist_hybrid` (dense taste-vector
  ranking fused with a full-text keyword ranking of the optional "mood" text via
  reciprocal rank fusion, after a radius filter and a budget-derived price-tier
  filter) and asks Groq for a structured result. The total is summed and checked
  against the budget in code (`runSuggesterWithinBudget`: retry, then 422).
  Estimates are not live prices, and the budget check verifies the number, not
  that the estimate is realistic.
- `lib/budget.ts` holds the pure budget logic: trip budget to maximum price
  tier, Google price level to tier, and the filter predicate. Unknown price is
  never filtered out.
- `shared/api-types.ts` is the source of truth for API shapes.
- `lib/supabase/server.ts` reads the same cookie-backed session created by the
  browser client, so API queries remain subject to RLS.
- `supabase/schema.sql` is a complete idempotent schema, not just a migration.
  Run `supabase/rank-wishlist-function.sql` after it.

## External API boundaries

- `NEXT_PUBLIC_GOOGLE_MAPS_API_KEY` is browser-visible and must be restricted
  by HTTP referrer and API.
- `GOOGLE_PLACES_API_KEY`, `VOYAGE_API_KEY`, `GROQ_API_KEY`, and the Supabase
  service-role key are server-only.
- Google Places responses use narrow field masks. Nearby result sets stay
  transient; when an owner explicitly saves a result, its selected place
  fields and canonical Place ID become a durable pin. Re-check Google's
  current storage terms before changing which provider fields are persisted.
- Keep Google attribution and source links attached to live results.
- Authorization must be checked before metered calls. `lib/api-auth.ts` exists
  for that purpose; RLS is still the final database boundary.
- `GET /api/pins` and `GET /api/maps-config` take no session and are the only
  fully public, unauthenticated routes. `lib/rate-limit.ts` throttles them
  per-client per-minute (backed by `check_rate_limit` in `supabase/schema.sql`)
  against scraping/abuse; this is separate from `lib/usage.ts`, which caps
  Google Maps/Places cost over a month rather than request rate.

## Data model

`pins` supports `memory` and `wishlist`, a 1024-dimensional embedding, optional
Google provider/Place ID, owner rating, owner tags, an optional 1-4 `price_tier`
(set in the pin form, or derived from Google's price level when an owner
explicitly saves a nearby result), and a `search_tsv` keyword document kept in
sync by a trigger. `rank_wishlist_by_taste` is the dense-only baseline, kept for
evaluation; the app calls `rank_wishlist_hybrid`. The taste centroid
excludes explicitly low-rated memories. Pin photos are one-to-many, although
the current UI uploads and displays one.

The two owners intentionally share one taste profile. Do not silently add a
`created_by` filter to recommendation queries unless changing the product to
per-user recommendations.

## Liquid glass

`liquid-glass-react` sizes its visible surface to content and interprets the
explicit `top`/`left` coordinates as its center because of its internal
translate transform. Keep the top bar absolutely centered. Modal CSS forces
the library's inner `.glass` element to block layout and constrains height so
forms and recommendation results remain scrollable.

Use glass for floating map chrome and modals; dense content such as the "All
pins" modal (`components/AllPinsModal.tsx`, formerly a standalone `/pins`
route — moved into a modal specifically to reuse the already-loaded map for
its blurred backdrop instead of mounting a second one) remains flat.
`overLight` surfaces need fixed dark text rather than theme-aware light text.

The library also sets its own heavy box-shadow (`0px 16px 70px rgba(0,0,0,0.75)`
under `overLight`) via an inline style on `.glass`, which any custom shadow
must override with `!important` — a plain rule loses to the inline style
regardless of source order, and silently doing nothing is easy to miss.
