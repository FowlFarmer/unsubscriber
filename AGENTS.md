# Agent Notes

## Project Shape

- Next.js App Router app deployed at `https://unsubscriber.tzhu.dev`.
- Main UI is in `app/sweeper.jsx`.
- YouTube/OAuth/quota logic is in `lib/youtube.js`.
- Monthly subscription fetch endpoint is `POST /api/subscriptions/snapshot`.
- Delete endpoint is `POST /api/unsubscribe`.
- Legacy `POST /api/preview` intentionally returns `410`; regex filtering happens client-side.

## Current Product Behavior

- Users sign in with Google OAuth scopes: `openid email profile https://www.googleapis.com/auth/youtube.force-ssl`.
- The backend hashes the Google `sub` into an opaque `accountCacheKey`.
- Vercel Redis/KV enforces:
  - 1 successful subscription snapshot per account per UTC calendar month.
  - 25 successful API unsubscribe deletes per account per UTC calendar month.
- The browser stores subscription snapshots in IndexedDB under the account cache key.
- Regex filters title and description locally as the user types.
- The table uses lightweight fixed-row virtualization; do not replace it with a full `matches.map` render for large lists.
- Channel thumbnails use plain `<img>` tags with YouTube-returned URLs, so images are loaded directly from YouTube/Google CDN hosts.

## Implementation Constraints

- Do not store subscription metadata in Redis/KV; only quota keys/counters belong there.
- Do not reintroduce backend regex preview calls; that would spend YouTube API quota unnecessarily.
- Keep destructive bulk unsubscribe behind exact-count confirmation.
- If delete quota is exhausted, keep channel links visible for manual unsubscribe.
- Sign out clears auth cookies but intentionally does not clear IndexedDB cache.

## Required Environment

```env
YOUTUBE_CLIENT_ID=...
YOUTUBE_CLIENT_SECRET=...
TOKEN_SECRET=...
KV_REST_API_URL=...
KV_REST_API_TOKEN=...
APP_ORIGIN=https://unsubscriber.tzhu.dev
```

The Redis code also accepts:

```env
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

## Verification

Run this before handing off changes:

```bash
npm run build
```
