# YouTube Subscription Sweeper

A local Next.js web tool for previewing and unsubscribing from YouTube channels whose subscription titles match a JavaScript regex.

The app uses the YouTube Data API `subscriptions.list` endpoint to fetch your subscriptions and `subscriptions.delete` to unsubscribe. Deleting a subscription costs 50 YouTube API quota units per channel.

## Setup

1. Create an OAuth client in Google Cloud Console.
2. Add this authorized redirect URI to the OAuth client:

   ```text
   https://unsubscriber.tzhu.dev/oauth2/callback
   ```

3. Copy `.env.example` to `.env` and fill in `YOUTUBE_CLIENT_ID` and `YOUTUBE_CLIENT_SECRET`.
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

Tokens are stored locally in `.tokens/youtube.json`, which is ignored by git.

## Safety Flow

The destructive action is split into two steps:

1. Preview matches for a regex.
2. Confirm unsubscribe using the exact matched subscription IDs from the preview.

This keeps a changed regex or refreshed subscription list from silently deleting a different set.
