# YouTube Subscription Sweeper

A local Next.js web tool for previewing and unsubscribing from YouTube channels whose subscription titles match a JavaScript regex.

The app uses the YouTube Data API `subscriptions.list` endpoint to fetch your subscriptions and `subscriptions.delete` to unsubscribe. Deleting a subscription costs 50 YouTube API quota units per channel.

## Setup

1. Create an OAuth client in Google Cloud Console.
2. Add this authorized redirect URI to the OAuth client:

   ```text
   https://unsubscriber.tzhu.dev/oauth2/callback
   ```

3. Set `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `TOKEN_SECRET`, `APP_ORIGIN`, `KV_REST_API_URL`, and `KV_REST_API_TOKEN` in your deployment environment. For local development, copy `.env.example` to `.env`.
4. Install dependencies:

   ```bash
   npm install
   ```

5. Start the app:

   ```bash
   npm run dev
   ```

6. Open `https://unsubscriber.tzhu.dev`.

For local-only development, set `APP_ORIGIN=http://localhost:4173` and add `http://localhost:4173/oauth2/callback` as an additional redirect URI in Google Cloud.

Tokens are stored in an encrypted HttpOnly cookie. Set `TOKEN_SECRET` to a long random value in production. Monthly snapshot and delete quotas are enforced with Vercel Redis/KV.

## Safety Flow

The app fetches up to 2,000 subscriptions once per Google account per UTC calendar month, then stores that snapshot in the user's browser with IndexedDB. Regex searches run against the browser cache.

The destructive bulk action is split into two steps:

1. Preview matches for a regex.
2. Confirm unsubscribe using the exact matched subscription IDs from the preview.

This keeps a changed regex or refreshed subscription list from silently deleting a different set.

Each Google account gets 25 API-powered unsubscribe deletes per UTC calendar month. If that quota runs out, channel links remain available so users can unsubscribe manually on YouTube.
