import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const tokenDir = path.join(process.cwd(), ".tokens");
const tokenPath = path.join(tokenDir, "youtube.json");
const scope = "https://www.googleapis.com/auth/youtube.force-ssl";

export function getConfig() {
  const origin = process.env.APP_ORIGIN || "https://unsubscriber.tzhu.dev";
  return {
    origin,
    redirectUri: `${origin}/oauth2/callback`,
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    scope,
  };
}

export function assertConfigured() {
  const { clientId, clientSecret } = getConfig();
  if (!clientId || !clientSecret) {
    const error = new Error("Missing YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET in .env.local or .env.");
    error.statusCode = 400;
    throw error;
  }
}

export async function readTokens() {
  if (!existsSync(tokenPath)) return null;
  return JSON.parse(await readFile(tokenPath, "utf8"));
}

async function saveTokens(tokens) {
  await mkdir(tokenDir, { recursive: true });
  await writeFile(tokenPath, JSON.stringify(tokens, null, 2), "utf8");
}

export async function exchangeCode(code) {
  assertConfigured();
  const { clientId, clientSecret, redirectUri } = getConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw googleError("OAuth token exchange failed.", response, payload);
  await saveTokens(withExpiry(payload));
}

async function refreshAccessToken(tokens) {
  assertConfigured();
  if (!tokens?.refresh_token) {
    const error = new Error("No refresh token saved. Sign in again.");
    error.statusCode = 401;
    throw error;
  }
  const { clientId, clientSecret } = getConfig();
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      grant_type: "refresh_token",
    }),
  });
  const payload = await response.json();
  if (!response.ok) throw googleError("OAuth token refresh failed.", response, payload);
  const nextTokens = withExpiry({ ...tokens, ...payload, refresh_token: tokens.refresh_token });
  await saveTokens(nextTokens);
  return nextTokens;
}

function withExpiry(tokens) {
  return {
    ...tokens,
    expires_at: Date.now() + Math.max(0, Number(tokens.expires_in || 0) - 60) * 1000,
  };
}

async function getAccessToken() {
  let tokens = await readTokens();
  if (!tokens) {
    const error = new Error("Not signed in.");
    error.statusCode = 401;
    throw error;
  }
  if (!tokens.expires_at || Date.now() >= tokens.expires_at) tokens = await refreshAccessToken(tokens);
  return tokens.access_token;
}

async function youtubeFetch(url, options = {}) {
  const accessToken = await getAccessToken();
  const response = await fetch(url, {
    ...options,
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
      ...options.headers,
    },
  });
  if (response.status === 204) return null;
  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;
  if (!response.ok) throw googleError("YouTube API request failed.", response, payload);
  return payload;
}

function googleError(message, response, payload) {
  const detail = payload?.error?.message || payload?.error_description || response.statusText;
  const error = new Error(`${message} ${detail}`);
  error.statusCode = response.status || 500;
  error.payload = payload;
  return error;
}

export async function listSubscriptions() {
  const subscriptions = [];
  let pageToken = "";
  do {
    const url = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
    url.searchParams.set("part", "id,snippet");
    url.searchParams.set("mine", "true");
    url.searchParams.set("maxResults", "50");
    url.searchParams.set("order", "alphabetical");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const page = await youtubeFetch(url);
    for (const item of page.items || []) subscriptions.push(toSubscriptionSummary(item));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return subscriptions;
}

function toSubscriptionSummary(item) {
  const snippet = item.snippet || {};
  return {
    subscriptionId: item.id,
    title: snippet.title || "",
    description: snippet.description || "",
    channelId: snippet.resourceId?.channelId || "",
    thumbnail: snippet.thumbnails?.medium?.url || snippet.thumbnails?.default?.url || "",
    publishedAt: snippet.publishedAt || "",
  };
}

export function compileRegex(pattern, flags = "i") {
  if (!pattern || typeof pattern !== "string") {
    const error = new Error("Enter a regex pattern.");
    error.statusCode = 400;
    throw error;
  }
  if (!/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length) {
    const error = new Error("Regex flags are invalid.");
    error.statusCode = 400;
    throw error;
  }
  try {
    return new RegExp(pattern, flags);
  } catch (cause) {
    const error = new Error(`Regex is invalid: ${cause.message}`);
    error.statusCode = 400;
    throw error;
  }
}

export async function previewMatches({ pattern, flags = "i" }) {
  const regex = compileRegex(pattern, flags);
  const subscriptions = await listSubscriptions();
  const matches = subscriptions.filter((subscription) => {
    regex.lastIndex = 0;
    return regex.test(subscription.title);
  });
  return { total: subscriptions.length, matches };
}

export async function unsubscribe(subscriptionIds) {
  const ids = Array.isArray(subscriptionIds) ? subscriptionIds : [];
  if (!ids.length) {
    const error = new Error("No subscription IDs were provided.");
    error.statusCode = 400;
    throw error;
  }
  if (ids.length > 100) {
    const error = new Error("Refusing to delete more than 100 subscriptions in one request.");
    error.statusCode = 400;
    throw error;
  }

  const results = [];
  for (const id of ids) {
    try {
      const url = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
      url.searchParams.set("id", id);
      await youtubeFetch(url, { method: "DELETE" });
      results.push({ subscriptionId: id, ok: true });
    } catch (error) {
      results.push({ subscriptionId: id, ok: false, error: error.message });
    }
  }
  return {
    deleted: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    results,
  };
}

export function errorResponse(error) {
  return Response.json(
    {
      error: error.message || "Unexpected server error.",
      detail: error.payload,
    },
    { status: error.statusCode || 500 },
  );
}
