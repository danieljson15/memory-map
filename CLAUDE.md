# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Memory Map — a shared, private map for two people to pin memories and
wishlist spots across Europe. Sign in, click the map, add a title/note/photo,
and it's visible to both accounts. This is a scoped MVP: auth, pin
create/read/delete, photo upload, flat map. A 3D globe and richer post
composition were deliberately cut for a resume-deadline version — see
README.md "Notes on scope / tradeoffs" before expanding scope.

## Commands

```bash
npm run dev      # start dev server (localhost:3000)
npm run build    # production build
npm run start    # run production build
npm run lint     # next lint
```

There is no test suite configured.

## Setup

Requires a Supabase project. Run `supabase/schema.sql` once in the Supabase
SQL editor — it creates the `pins` table, its RLS policies, and the
`pin-photos` storage bucket. Then copy `.env.local.example` to `.env.local`
and fill in `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` from
the Supabase project settings. `lib/supabaseClient.ts` falls back to
placeholder values when those env vars are absent so `next build` always
succeeds without real credentials; sign-in etc. will fail at runtime until
they're set.

## Architecture

Next.js 15 App Router + TypeScript, React 19, Supabase (Postgres/Auth/Storage),
react-leaflet 5 for the map. The whole app is essentially one screen with
three client components, no server components/routes beyond the App Router
shell:

- `app/page.tsx` — root client component. Owns the Supabase auth session
  (via `supabase.auth.getSession()` / `onAuthStateChange`) and renders
  either `AuthScreen` or the map shell. `MapView` is loaded with
  `next/dynamic` and `ssr: false` because Leaflet touches `window` on
  import. Also renders the top nav as a `LiquidGlass`-wrapped floating pill
  — see "Liquid glass specifics" below before touching its positioning.
- `components/AuthScreen.tsx` — email/password sign-in and sign-up via
  Supabase Auth directly (no custom backend). Deliberately flat (no glass).
- `components/MapView.tsx` — loads all pins from the `pins` table on mount,
  renders them as Leaflet markers on a tile layer centered on Europe,
  handles map clicks to open `PinModal`, and handles pin deletion in place.
  Also owns the tile theme (light OSM / dark CartoDB `dark_all`, toggled by
  a button, default light, persisted to `localStorage`) and holds a
  `mapRef` (via `MapContainer`'s `ref` prop — react-leaflet 5 forwards the
  underlying Leaflet `Map` instance directly, no `whenCreated` callback
  needed) passed down to `SearchBox` so it can call `fitBounds`.
- `components/SearchBox.tsx` — place search via Nominatim (OSM's free
  geocoder, no API key, `accept-language=en`), debounced 400ms. Selecting a
  result calls `map.fitBounds()` on the result's `boundingbox`, which sizes
  the zoom to the actual place rather than guessing a zoom level by type.
  Rendered flat (not glass) — a text input backed by a scrolling result
  list is exactly the "dense/text-heavy" case the design brief says to
  keep flat. (Also tried as `LiquidGlass` and reverted — see the comment
  above `.search-box` in `globals.css` and "Liquid glass specifics" below
  for why.) Note: selecting a result sets the input's text to
  `display_name`, which would normally re-trigger the debounced search
  effect on that new value — a `skipNextSearchRef` flag suppresses that one
  re-trigger; don't remove it without replacing the guard some other way.
- `components/PinModal.tsx` — form for creating a pin: uploads an optional
  photo to the `pin-photos` storage bucket, gets its public URL, then
  inserts a row into `pins`. Rendered inside `LiquidGlass` (glass form, see
  below) over a lightly-dimmed map backdrop.
- `lib/types.ts` — shared `Pin` type, mirrors the `pins` table schema.
- `lib/supabaseClient.ts` — single shared Supabase client instance, imported
  everywhere data access is needed (no API routes / server actions — all
  reads/writes happen client-side against Supabase directly).
- `supabase/schema.sql` — source of truth for the DB schema; not run
  automatically, must be pasted into the Supabase SQL editor manually (see
  Setup above) and re-run manually for any schema changes.

### Floating UI over the Leaflet map

Any element positioned over `MapView`'s `<MapContainer>` (search box, theme
toggle, hint banner) needs a z-index that clears Leaflet's own internal
panes, not just the app's normal z-index scale. `.leaflet-container` has
`position: relative` but no explicit `z-index`, so it does **not** establish
an isolated stacking context — its internal panes (tile/marker/popup, up to
`z-index: 700` in Leaflet's own CSS) stack directly against page-level
siblings. `.search-box` and `.theme-toggle-btn` use `z-index: 900` for this
reason. (`.hint-banner` still uses the lower app-scale `z-index: 15` and
happens to render fine — the two weren't tested against each other, so
don't assume 15 is safe for a *new* floating element without checking.)

### Data model / trust boundary

There is no per-row ownership: any authenticated user can read, insert, or
delete any pin (see the RLS policies in `supabase/schema.sql`). This is
intentional — the app is invite-only for two accounts, so "authenticated"
*is* the trust boundary. Don't add per-user ownership checks without
revisiting this assumption first.

The `pin-photos` storage bucket is public-read (so `photo_url` values work
directly in `<img>` tags) but write-restricted to authenticated users.

## Visual direction: Apple-inspired UI

The app feels like modern Apple software (visionOS/iOS design language) —
calm, spacious, content-first, with glass and depth used deliberately
rather than everywhere. Implemented in `app/globals.css` via CSS custom
properties (`--color-*`, `--radius-*`, `--ease-*`), light/dark both
supported through `prefers-color-scheme` (no manual toggle).

### Typography
- System font stack: -apple-system, BlinkMacSystemFont, "SF Pro Display",
  "SF Pro Text", "Helvetica Neue", sans-serif
- Generous line-height (1.4-1.6 for body text)
- Restrained weight range — regular and semibold/medium, avoid heavy bold
- Clear size hierarchy but not many steps: one display size, one heading
  size, one body size, one caption size is usually enough

### Color
- Mostly neutral: true white / near-black surfaces, no colored backgrounds
  by default
- One accent color used sparingly for interactive elements (links, primary
  buttons, active states) — not scattered throughout
- Dark mode is first-class, not an inverted afterthought — true near-black
  background (not dark gray), full contrast pass in both modes

### Depth and materials
- Flat surfaces by default; reach for elevation only for floating/overlay
  UI (nav bars, modals, panels over content) — not for every card
- Where elevation is used: `liquid-glass-react` for chrome that floats over
  visually rich content — the top nav pill, the pin-creation modal (both
  float over the Leaflet map). `AuthScreen` stays flat — it's a form with
  nothing behind it worth refracting. See constraints below before touching
  either glass usage.

### Shape
- Continuous corners ("squircle" feel) over simple border-radius circles —
  larger radii (16-24px) on cards and panels, not the tight 4-8px common
  in web UI
- Consistent radius scale across the app, not ad hoc per component

### Motion
- Spring-based easing over linear/ease-in-out — motion should feel
  physical, slightly bouncy, never abrupt
- Purposeful, not decorative — transitions clarify state changes (a panel
  opening, a pin selecting), not just polish for its own sake
- Respect prefers-reduced-motion

### Iconography
- Thin/regular stroke weight, consistent stroke width across all icons —
  avoid mixing icon sets with different visual weights

### Liquid glass specifics

Requires React 19 (this repo upgraded from React 18 / Next 14 specifically
for this — see git history). `liquid-glass-react`'s actual sizing/positioning
model isn't documented in its README and doesn't match how you'd normally
place an absolutely-positioned element; reverse-engineered by reading
`node_modules/liquid-glass-react/dist/index.esm.js` directly:

- **The visible glass surface always sizes to its content.** Internally
  it's a hardcoded `display: inline-flex` box — there's no width/stretch
  prop, so it cannot be made a full-width edge-to-edge bar. This is why the
  top nav is a compact centered pill (`app/page.tsx`), not a full-width bar
  — a stretched bar was tried first and doesn't work with this library.
- **`top`/`left` describe the element's center point, not its corner.**
  The component unconditionally applies an inline
  `transform: translate(calc(-50% + elasticX), calc(-50% + elasticY))` for
  its mouse-elastic wobble. Pass `top`/`left` as where you want the glass
  *centered* (e.g. `top: "3rem", left: "50%"`), not as edge insets — edge
  insets combined with that transform shove the element off-screen.
- **The inner content box is a hardcoded row flex** (`display: inline-flex`,
  no `flex-direction` override available via props). A vertically-stacked
  form (`PinModal`) needs a CSS override targeting the library's own
  `.glass` class with `!important` to force `display: block` — see
  `.modal-card .glass` in `globals.css`. This also lets you give it a fixed
  `width` the props can't.
- **A CSS `animation` targeting `transform` on the wrapper (with
  `animation-fill-mode: both`) neutralizes the library's own transform once
  it finishes**, since animated properties win over inline styles for as
  long as the fill-mode holds. `.modal-card`'s existing `modal-pop-in`
  entrance animation does double duty this way — it's why the modal doesn't
  need the same explicit center-point styling the nav pill does. Removing
  that animation would bring back the off-position bug.
- **This library only reliably works for elements matching the topbar's
  pattern — `position: absolute` with an explicit centered `top`/`left`.**
  The search box was tried as `LiquidGlass` and reverted after several
  rounds of visual bugs; see the comment above `.search-box` in
  `globals.css` for the full account. Short version: the component's
  Fragment output includes several decorative sibling elements (black-tint
  overlays, highlight-gradient spans) alongside the actual glass box. When
  the wrapper isn't given the "absolute + centered top/left" treatment,
  those siblings default to `position: relative` boxes sized to match the
  glass element — invisible in this project (no Tailwind for their
  `bg-black`/`opacity-*` classNames to resolve), but still occupying real
  document-flow height, which silently pushed unrelated later content down
  by unpredictable amounts. A targeted fix for one symptom
  (`transform: none !important` to stop a self-centering-transform
  mis-position, or `isolation: isolate` to contain a backdrop-filter bleed)
  kept surfacing a *new* symptom rather than converging — `isolation:
  isolate` in particular broke backdrop-filter's ability to sample the
  page behind it entirely, since it walled the glass element into its own
  empty stacking context. Don't reach for this library for anything outside
  the proven absolute-positioned pattern without expecting the same fight.
- `overLight` biases the glass toward a light/frosted look regardless of
  the app's own dark/light theme — text on top of glass surfaces should use
  fixed, non-theme-swapping colors (see `.modal-card`'s color rules) rather
  than the app's `--color-text*` variables, or dark-mode text nearly
  vanishes against the always-light glass.
- Known limitation (per the library's README): Safari and Firefox only
  partially support it — no displacement/refraction, degrades to a plain
  blur. Full effect is Chrome/Edge only. Test in Safari before calling any
  glass UI done — not yet done as of this writing.
- Tunable props: displacementScale, blurAmount, saturation,
  aberrationIntensity, elasticity, cornerRadius — see
  `node_modules/liquid-glass-react/dist/index.d.ts` for the full/current
  list (the published README lags behind).

## Known issue

`npm audit` flags high-severity advisories against `next`'s bundled
`postcss` (source-map disclosure — dev server only, not production
build/deploy) and `sharp` (unused by this app — no `next/image` usage).
The vulnerable range spans through Next's latest canary as of this writing,
so there's currently no version bump that clears it; left as-is
intentionally.
