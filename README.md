# YouTube Subscription Sweeper

A Next.js web tool for loading your YouTube subscriptions, filtering them with a regex, and unsubscribing from selected channels.

The app uses the YouTube Data API `subscriptions.list` endpoint to fetch subscriptions and `subscriptions.delete` to unsubscribe. YouTube charges 1 API quota unit per subscription-list page and 50 units per unsubscribe.

## What It Does

- Signs users in with Google OAuth.
- Fetches up to 2,000 YouTube subscriptions once per Google account per UTC calendar month.
- Stores the fetched subscription snapshot in the user's browser with IndexedDB.
- Filters locally as the user types a regex against channel titles and descriptions.
- Virtualizes the results table so large match lists do not render every row at once.
- Lets users delete one matched subscription at a time or confirm a bulk delete.
- Keeps YouTube channel links visible so users can manually unsubscribe when API delete quota runs out.

Channel thumbnails are rendered as plain `<img>` tags using the URLs returned by YouTube. They are loaded directly from YouTube/Google thumbnail hosts, not proxied through Vercel Image Optimization.

## Setup

1. Create a Google OAuth client in Google Cloud Console.
2. Enable YouTube Data API v3.
3. Configure OAuth scopes:

   ```text
   openid
   email
   profile
   https://www.googleapis.com/auth/youtube.force-ssl
   ```

4. Add this production redirect URI:

   ```text
   https://unsubscriber.tzhu.dev/oauth2/callback
   ```

5. For local development, also add:

   ```text
   http://localhost:4173/oauth2/callback
   ```

6. Set deployment environment variables:

   ```env
   YOUTUBE_CLIENT_ID=...
   YOUTUBE_CLIENT_SECRET=...
   TOKEN_SECRET=...
   KV_REST_API_URL=...
   KV_REST_API_TOKEN=...
   APP_ORIGIN=https://unsubscriber.tzhu.dev
   ```

   The Redis variables can come from Vercel Redis/KV or Upstash Redis REST credentials. The app also accepts `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

7. For local development, copy `.env.example` to `.env` and set:

   ```env
   APP_ORIGIN=http://localhost:4173
   PORT=4173
   ```

8. Install and run:

   ```bash
   npm install
   npm run dev
   ```

9. Open `http://localhost:4173` locally or `https://unsubscriber.tzhu.dev` in production.

## Quotas And Storage

- Subscription snapshots: 1 successful fetch per Google account per UTC calendar month.
- Snapshot size: up to 2,000 subscriptions.
- API deletes: 25 successful unsubscribe actions per Google account per UTC calendar month.
- Server quota state: Vercel Redis/KV stores small monthly keys and counters only.
- Browser cache: IndexedDB stores the subscription metadata used for local filtering.
- Auth tokens: stored in an encrypted HttpOnly cookie using `TOKEN_SECRET`.

If a user spends the monthly snapshot quota in one browser, then opens a different browser without the IndexedDB cache, the app cannot reconstruct the list until the next month. It will show an explanatory error.

## Safety Flow

The destructive bulk action is split into two steps:

1. Filter the cached list with a regex.
2. Confirm the exact current match count before bulk unsubscribe.

Per-row delete buttons unsubscribe only that channel. Successful deletes remove rows from the UI and IndexedDB cache.

## Owner Dev Console

A small fixed `dev` link opens an owner-only command box. The browser only sends the typed text to the backend; the backend verifies the signed-in Google account before deciding whether a command is valid.

## Commands

```bash
npm run dev
npm run build
npm test
```
