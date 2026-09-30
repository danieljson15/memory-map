# Memory Map developer notes

## Product boundary

Memory Map is a public-read, owner-write travel map. Anyone can view pins and
photos. Only the two emails configured in `supabase/schema.sql` may write —
create/edit/delete pins, upload photos, save a nearby result to the wishlist.

The suggester (`/api/suggest`) and nearby recommendations
(`/api/recommendations/nearby`) are intentionally public too, as a live demo
of the recommendation pipeline: anyone can run them against the owners'
actual travel history/taste profile. This is safe to expose because the
underlying wishlist/memory pins are already fully public via `GET /api/pins`;
what's actually being protected is cost, not data. Both routes branch on
`getOwnerAccess` internally (see `lib/api-auth.ts`) rather than gating on it:
owners get their usual behavior (higher usage ceiling, suggestions persisted
to history), public callers are rate-limited per-client
(`lib/rate-limit.ts`'s `PUBLIC_SUGGEST`/`PUBLIC_NEARBY`) and, for the nearby
route, metered on a separate and much smaller monthly counter
(`public_places_request` in `lib/usage.ts`) so a spike in public demo traffic
can't eat the owners' own search budget. A public suggester run is computed
live and never persisted — "AI suggestion history remains private to owners"
still holds; it just means the public path skips the insert rather than
being blocked from running at all.

Trips and checklists remain fully private to the two owners — no public path
exists for those.

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
  not bypassed. The same component also edits an existing pin when given a
  `pin` prop (PATCH instead of POST, prefilled from the pin, "Save changes"
  instead of "Save pin") — triggered from the "Edit" button next to "Delete"
  in each map's pin popup (`GoogleMapView.tsx` / `LeafletMapView.tsx`).
  Replacing or removing the one photo a pin can have goes through
  `DELETE /api/pins/[id]/photos/[photoId]` (added for this; there was
  previously no way to remove a `pin_photos` row at all) — a replacement
  uploads and registers the new photo first, only deleting the old one once
  that succeeds, so a failure partway through never leaves the pin with zero
  photos.
- `components/NearbyRecommendationsModal.tsx` asks the server for live nearby
  candidates and saves explicit selections as wishlist pins. Browsing is
  public; saving is owner-only — the `isOwner` prop (passed from
  `app/page.tsx`) disables the Save button with "Sign in to save" for
  everyone else instead of letting the save request fail with a 403.
- `app/api/recommendations/nearby/route.ts` loads positive and negative memory
  signals, obtains three bounded Google Nearby result groups, batch-embeds
  candidates, and ranks them in `lib/recommendations.ts`. Public by design
  (see Product boundary); owner vs. public changes only the usage-cap kind
  and whether a per-client rate limit applies, not the ranking itself.
- `app/api/suggest/route.ts` is the separate destination-level trip suggester.
  It ranks stored wishlist rows with `rank_wishlist_hybrid` (dense taste-vector
  ranking fused with a full-text keyword ranking of the optional "mood" text via
  reciprocal rank fusion, after a radius filter and a budget-derived price-tier
  filter) and asks Groq for a structured result. The total is summed and checked
  against the budget in code (`runSuggesterWithinBudget`: retry, then 422).
  Estimates are not live prices, and the budget check verifies the number, not
  that the estimate is realistic. Public callers get the same result computed
  live but skip the `suggestions`/`suggestion_steps` insert entirely (RLS
  would reject it anyway — those tables are owner-only) — the route builds
  an in-memory object matching the same shape so the frontend doesn't need
  to know which case it's in.
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
- Authorization is checked before every metered call via `lib/api-auth.ts`'s
  `getOwnerAccess`, but not every metered route hard-gates on the result —
  `/api/suggest` and `/api/recommendations/nearby` branch on it instead (see
  Product boundary) to give owners and public callers different usage
  ceilings rather than blocking public callers outright. RLS is still the
  final database boundary either way.
- `GET /api/pins`, `GET /api/maps-config`, `POST /api/suggest`, and
  `POST /api/recommendations/nearby` all take no session and are reachable
  by anyone. `lib/rate-limit.ts` throttles all four per-client
  (`check_rate_limit` in `supabase/schema.sql`) — a permissive per-minute
  window for the first two (cheap reads), a much tighter per-hour window for
  the latter two (each call is an LLM call or a live Google Places request).
  This is separate from `lib/usage.ts`, which caps Google Maps/Places cost
  over a month rather than request rate, and which tracks public nearby-
  recommendation traffic on its own `public_places_request` counter so it
  can't cannibalize the owners' own `places_request` allowance.

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

Overriding `.glass`'s own background/box-shadow/backdrop-filter isn't enough
to make a card read as fully opaque. The library renders a second element
inside it — `<span class="glass__warp">`, absolutely positioned to cover the
whole card — carrying its own hardcoded `backdrop-filter: blur(...)
saturate(140%)` plus the SVG displacement/chromatic-aberration filter,
independent of `.glass`'s own styling. `glass__warp` doesn't match a `.glass`
selector (distinct class, not a descendant), so it silently keeps sampling
and blurring whatever's behind the card even after `.glass` itself is made
opaque — the actual cause of corner smudging on PinModal/SuggesterModal/
NearbyRecommendationsModal, not the box-shadow. Fixed by hiding it outright
(`.modal-card .glass__warp { display: none !important; }`, same for
`.suggester-card`/`.recommendations-card`) — only safe because those three
cards are deliberately opaque; the topbar keeps `glass__warp` since its
translucent refraction effect is intentional there.
