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

## Commands

```bash
npm run dev
npm run build
npm run start
npm run lint
npm run embed:backfill
```

There is currently no automated test suite.

`npm audit` currently reports three high-severity advisories in Next.js'
transitive `postcss`/`sharp` packages. npm's offered remediation is a breaking
upgrade to Next 16, so it has not been applied as part of this feature change.
The non-breaking `nanoid` remediation has been applied.

## Roadmap

- Trip and checklist management UI
- Multiple-photo composition
- Streaming trip-suggester steps
- Recommendation evaluation against explicit user feedback
