# Memory Map

A shared, private map for pinning memories and wishlist spots across Europe.
Sign in, click anywhere on the map, add a title/note/photo, and it's saved
for both accounts to see.

This is the scoped MVP: auth, pin create/read/delete, photo upload, flat
map. The 3D globe and in-app rich-text post composition are intentionally
left out of this version — build those on top once this is deployed.

## Stack

- Next.js 15 (App Router) + React 19 + TypeScript
- Supabase — Postgres, Auth, Storage
- react-leaflet — the map

## 1. Create a Supabase project

1. Go to supabase.com, create a new project, wait for it to finish provisioning.
2. In the SQL Editor, paste and run the entire contents of `supabase/schema.sql`.
   This creates the `pins` table, its row-level-security policies, and the
   `pin-photos` storage bucket.
3. In Project Settings -> API, copy the **Project URL** and the **anon public** key.
4. In Authentication -> Providers, confirm Email is enabled (it is by default).
   Optionally turn off "Confirm email" under Authentication -> Settings if
   you don't want the email-confirmation step while testing.
5. Create your two accounts (you and your girlfriend): either sign up
   through the app itself once it's running, or add them directly under
   Authentication -> Users in the dashboard.

## 2. Run it locally

```bash
cp .env.local.example .env.local
# paste your Project URL and anon key into .env.local

npm install
npm run dev
```

Open http://localhost:3000, sign up, and click the map.

## 3. Deploy to Vercel

1. Push this project to a GitHub repo.
2. In Vercel, "Add New Project" -> import that repo.
3. Under Environment Variables, add the same two keys from `.env.local`:
   - `NEXT_PUBLIC_SUPABASE_URL`
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY`
4. Deploy. Vercel will give you a live URL — that's what goes on the resume.

## Known, accepted issue

`npm audit` will flag a PostCSS source-map-disclosure vulnerability bundled
inside `next`. It only affects the local dev server, not the production
build or deployment. The vulnerable range currently spans Next's latest
release, so there's no version bump that clears it yet. Left as-is for
now — revisit later if a fixed release ships.

## Notes on scope / tradeoffs

- Storage bucket is public-read so photo URLs work simply in `<img>` tags;
  write access is restricted to signed-in users. Fine for a small shared app,
  not the pattern you'd use for a public product.
- No per-user ownership on rows — any signed-in user can edit/delete any
  pin. Matches the "shared" premise; revisit if that ever changes.
- Map is flat (OpenStreetMap tiles via Leaflet), not the 3D globe from the
  original vision. That's a deliberate cut for the resume-deadline version.
