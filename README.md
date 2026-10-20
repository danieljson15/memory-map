# Memory Map

Memory Map is a shared travel map for two owners with a public read-only
view. Anyone can browse the pins and photos; the two configured owner
accounts can add memories, build a wishlist, and request personalized place
or trip recommendations.

## Features

- **Public map and gallery** — browse pins, notes, and photos without signing
  in. The map uses Google Maps with light/dark themes; `/pins` provides a
  searchable memory/wishlist gallery.
- **Canonical places** — authenticated owners search Google Places with
  session-based autocomplete, then save the canonical Place ID alongside
  their own title, note, rating, tags, and optional photo.
- **Memories and wishlist** — map clicks create free-form pins; place search
  creates canonical pins. Both flows support memory and wishlist kinds.
- **Automatic taste embeddings** — `POST /api/pins` embeds every new pin with
  Voyage AI. A maintenance script backfills older or failed embeddings.
- **Ranked wishlist** — pgvector compares wishlist embeddings with the average
  of positively rated memory embeddings.
- **Nearby recommendations** — Google Places supplies real nearby candidates;
  Voyage embeds them in one batch, and a transparent score blends taste
  similarity, rating, popularity, and distance. Only places explicitly saved
  by an owner become durable wishlist pins.
- **AI trip suggester** — Groq/Llama selects a whole-trip destination from the
  ranked wishlist (or proposes a new one), estimates a cost breakdown, and
  returns persisted reasoning steps. Costs are estimates, not live prices.
- **Trip/checklist API** — the database and route handlers exist; a dedicated
  trip-management UI is not implemented yet.

## Stack

- Next.js 15, React 19, and TypeScript
- Supabase Postgres, Auth, Storage, and row-level security
- pgvector
- Google Maps JavaScript API and Places API (New)
- Voyage AI embeddings
- Groq chat completions
- `liquid-glass-react`

## Access model

- Pins, pin-photo metadata, and files in the `photos` bucket are public-read.
- Trips, checklists, suggestions, and suggestion steps are private to the two
  owner accounts.
- All writes are restricted by RLS to the two email addresses configured in
  `public.is_memory_map_owner()`.
- Metered Google, Voyage, and Groq routes check owner access before making an
  external request.

Self-service Supabase signup may remain enabled, but non-owner accounts cannot
write or consume the metered recommendation endpoints.

## Setup

### 1. Create and configure Supabase

1. Create a Supabase project.
2. Open `supabase/schema.sql` and replace `you@example.com` and
   `partner@example.com` with the two owner emails.
3. Run the complete `supabase/schema.sql` file in the SQL Editor.
4. Run `supabase/rank-wishlist-function.sql`.
5. Optionally run `supabase/seed.sql` after at least one owner account exists.

The schema is idempotent and can upgrade an earlier Memory Map database. It
creates the tables, vector extension/index, triggers, storage bucket, and RLS
policies in one pass.

### 2. Configure Google Cloud

Enable billing and these APIs in one Google Cloud project:

- Maps JavaScript API
- Places API (New)

Create two restricted keys:

- A browser key restricted by HTTP referrer for the Maps JavaScript API.
- A server key restricted to Places API (New).

Create a map ID for Advanced Markers. `DEMO_MAP_ID` is used locally when no
map ID is configured, but a project-owned map ID is recommended for deploys.

Google Places responses use explicit field masks. The UI includes Google Maps
attribution and links back to the source place. Review Google Maps Platform's
current attribution, storage, EEA, and billing terms before deployment.

### 3. Configure environment variables

```bash
cp .env.local.example .env.local
```

Fill in:

```dotenv
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
VOYAGE_API_KEY=
GROQ_API_KEY=
GOOGLE_PLACES_API_KEY=
NEXT_PUBLIC_GOOGLE_MAPS_API_KEY=
NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID=
```

`SUPABASE_SERVICE_ROLE_KEY`, `VOYAGE_API_KEY`, `GROQ_API_KEY`, and
`GOOGLE_PLACES_API_KEY` are server-only. Never give them a `NEXT_PUBLIC_`
prefix.

### 4. Install and run

```bash
npm install
npm run dev
```

Open <http://localhost:3000>. Public visitors can browse immediately; an
owner signs in to add or recommend places.

## Embedding maintenance

New UI-created pins are embedded automatically. To embed older pins or retry
pins created during a Voyage outage:

```bash
npm run embed:backfill
```

The script requires the Supabase service-role key because it runs outside a
browser session and intentionally bypasses RLS.

## Recommendation architecture

```text
Saved positive memories
        ↓
Voyage taste embedding
        +
Google Places nearby candidates
        ↓ batch embeddings
Taste similarity + rating + popularity + distance
        ↓
Top ten attributed recommendations
        ↓ explicit owner action
Saved wishlist pin
```

The existing trip suggester remains a separate destination-level flow:

```text
Memory embedding centroid
        ↓ pgvector cosine similarity
Ranked stored wishlist
        ↓
Groq trip choice and estimated budget
```

## Engineering notes

### Frontend ↔ backend

```text
Browser (React client components)
  │  fetch("/api/...")  — JSON, session cookie attached
  ▼
Next.js route handlers (app/api/**/route.ts)
  │  1. createSupabaseServerClient()  — reads the caller's session cookie
  │  2. getOwnerAccess()              — 401/403 before any metered call
  │  3. validate input → query Supabase / call Google, Voyage, Groq
  ▼
Supabase Postgres (RLS on every table)
```

- Components never talk to the database directly for data. The exceptions
  are auth (the browser Supabase client owns the session) and photo
  *uploads* to the public-read `photos` bucket; the photo's metadata is
  still registered through `/api/pins/[id]/photos`.
- Route handlers build a Supabase client from the request's cookies
  (`lib/supabase/server.ts`), so queries run **as the signed-in user** and RLS
  applies exactly as it would in the browser. The API checks owner access
  first only to avoid spending Google/Voyage/Groq quota on callers who would
  fail at the insert anyway; RLS remains the real boundary.
- `shared/api-types.ts` is the single source of truth for request/response
  shapes used on both sides.
- Some routes are public on purpose (`GET /api/pins`, the suggester, nearby
  recommendations). They are rate limited per client and, for Google calls,
  metered on a separate monthly counter. See `CLAUDE.md` for the full
  boundary.

### Testing

```bash
npm test            # run everything once (what CI runs)
npm run test:watch  # re-run on change
```

[Vitest](https://vitest.dev) with React Testing Library. Tests live in
`tests/` and need no network, credentials, or running database:

| Layer | Where | What it covers |
|---|---|---|
| Unit | `tests/*.test.ts` | Budget tiers, ranking math, cache keys, rate limiting, usage caps, owner auth, embedding batching, the suggester's budget-retry loop |
| Route handlers | `tests/routes/` | Owner vs. public behavior, input validation, status-code mapping, that public suggester runs are never persisted |
| Components | `tests/components/` | `PinModal` (create/edit, validation, duplicate-submit guard, upload rollback), `NearbyRecommendationsModal`, `AllPinsModal` |

Supabase, Groq, Voyage, and Google are replaced with in-memory fakes
(`tests/helpers.ts`, plus per-file fakes for `fetch` and storage). Tests assert
on outcomes — what was sent, what is left in storage, what the user sees —
rather than only that a mock was called.

**Current limitations**

- The fakes encode my assumptions about the real services. Nothing here
  exercises a real Supabase, Google, Voyage, or Groq response.
- The SQL functions (`rank_wishlist_hybrid`, `check_rate_limit`) and RLS
  policies are untested; they would need a Postgres with pgvector.
- Not covered yet: the trips/checklist/places/wishlist routes, `pins/[id]`
  PATCH/DELETE, `SuggesterModal`, and the map components. There is no
  browser-level end-to-end test.
- Coverage is not measured, so no coverage figure is claimed.

### Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request to `main`, on
Node 20 with a read-only token:

1. `npm ci` — clean install from the lockfile
2. `npm run lint`
3. `npm run typecheck` (`tsc --noEmit`)
4. `npm test`
5. `npm run build` — production Next.js build

It is a check, not a deploy: Vercel deploys independently. The check only
blocks merges if branch protection on `main` requires it.

### Tradeoffs worth knowing

- **Budget is enforced in code, not trusted to the LLM.** The suggester sums
  the model's cost breakdown itself, retries with the exact overage, then
  returns 422. It checks the number, not whether the estimate is realistic.
- **Usage metering is check-then-increment** (two round trips), so a burst of
  concurrent requests can slip a few calls past the cap. That is acceptable
  for an early-warning breaker in front of Google's own hard quota.
- **Failure policy is deliberate per surface:** the rate limiter and the
  owner-only Places counter fail open on a database error; the public
  endpoints' usage counter fails closed so an outage can't become unmetered
  spend.
- **Pin creation is a multi-step flow, not a transaction** (upload → create
  pin → attach photo). `PinModal` compensates on failure by deleting the pin
  and the uploaded file, so a retry doesn't leave duplicates or orphans.
- **Embedding failures don't block saving a pin.** The pin is stored without
  an embedding and picked up later by `npm run embed:backfill`.

## Commands

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run typecheck
npm test
npm run embed:backfill
```

`npm audit` currently reports three high-severity advisories in Next.js'
transitive `postcss`/`sharp` packages. npm's offered remediation is a breaking
upgrade to Next 16, so it has not been applied as part of this feature change.
The non-breaking `nanoid` remediation has been applied.

## Roadmap

- Trip and checklist management UI
- Multiple-photo composition
- Streaming trip-suggester steps
- Recommendation evaluation against explicit user feedback
