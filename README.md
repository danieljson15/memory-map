# Memory Map

A shared, private map for two people to track where they've been and where
they want to go next — pin memories, build a wishlist, and get an
AI-generated trip suggestion that's grounded in your own travel history
instead of a generic "top 10 destinations" list.

Built as a full-stack, end-to-end product: auth, a real Postgres schema with
row-level security, vector search over your own data, and an LLM feature
that actually uses that retrieval rather than bolting a chatbot on top.

## Features

- **Shared map** — sign in and see both accounts' pins together on one
  Leaflet map of Europe, with light/dark tile themes and a place search
  (OpenStreetMap/Nominatim) that flies the map to any location.
- **Memories & wishlist** — pin a place you've been (with a title, note, and
  photo) or a place you want to go. Two kinds of pins, one map.
- **Trip planning** — group wishlist pins into trips with checklists.
- **Taste-based recommendations** — every pin is embedded (Voyage AI) on
  creation. A Postgres function (`pgvector`) ranks your wishlist by
  similarity to the average embedding of the places you've actually loved,
  so "recommended" means something rather than being arbitrary.
- **AI trip suggester** — given a budget, month, and departure airport, an
  LLM (Groq, Llama 3.3 70B) picks a destination from your ranked wishlist
  (or proposes something new if it fits your taste better), estimates a
  cost breakdown, and narrates its reasoning as discrete steps.

## Stack

- Next.js 15 (App Router) + React 19 + TypeScript
- Supabase — Postgres, Auth, Storage, row-level security
- `pgvector` for embedding similarity search
- Voyage AI — embeddings
- Groq — LLM inference (Llama 3.3, OpenAI-compatible API, free tier)
- react-leaflet — the map
- `liquid-glass-react` — the floating nav and modal chrome

## Getting started

### 1. Create a Supabase project

1. Go to supabase.com, create a new project, wait for it to finish
   provisioning.
2. In the SQL Editor, run `supabase/schema.sql`, then
   `supabase/rank-wishlist-function.sql`. Together these set up the tables,
   RLS policies, the `pgvector` ranking function, and the storage bucket
   for photos.
3. In Project Settings -> API, copy the **Project URL** and the
   **anon public** key.
4. In Authentication -> Providers, confirm Email is enabled (on by default).
5. Create your two accounts, either through the app itself once it's
   running, or directly under Authentication -> Users.

### 2. Configure environment variables

```bash
cp .env.local.example .env.local
```

Fill in your Supabase URL/anon key, a Voyage AI key (for embeddings), and a
Groq key (for the trip suggester) — both have free tiers, no credit card
required.

### 3. Run it locally

```bash
npm install
npm run dev
```

Open http://localhost:3000, sign up, and click the map.

## Deploy

1. Push this project to a GitHub repo.
2. In Vercel, "Add New Project" -> import that repo.
3. Add the environment variables from `.env.local` to the Vercel project.
4. Deploy.

## Design

The UI follows an Apple-inspired visual language — glass and depth used
deliberately for floating chrome (nav, modals), flat and content-first
everywhere else, full dark-mode support throughout. See `CLAUDE.md` for the
detailed design system and the reasoning behind specific implementation
choices (the `liquid-glass-react` integration in particular required
reverse-engineering the library's positioning model — documented there for
anyone extending it).

## Roadmap

- 3D globe view as an alternative to the flat map
- Streaming the trip suggester's reasoning steps live instead of returning
  them as a completed batch
- Richer post composition (multiple photos per pin, tags)
