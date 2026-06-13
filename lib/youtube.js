import crypto from "node:crypto";
import { cookies } from "next/headers";

const tokenCookie = "youtube_tokens";
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
  const cookieStore = await cookies();
  const value = cookieStore.get(tokenCookie)?.value;
  if (!value) return null;
  try {
    return decryptTokens(value);
  } catch {
    return null;
  }
}

async function saveTokens(tokens) {
  const cookieStore = await cookies();
  cookieStore.set(tokenCookie, encryptTokens(tokens), getTokenCookieOptions());
}

export function setTokenCookie(response, tokens) {
  response.cookies.set(tokenCookie, encryptTokens(tokens), getTokenCookieOptions());
}

function getTokenCookieOptions() {
  return {
    httpOnly: true,
    maxAge: 60 * 60 * 24 * 180,
    path: "/",
    sameSite: "lax",
    secure: getConfig().origin.startsWith("https://"),
  };
}

function getTokenSecret() {
  const { clientSecret } = getConfig();
  const secret = process.env.TOKEN_SECRET || clientSecret;
  if (!secret) {
    const error = new Error("Missing TOKEN_SECRET or YOUTUBE_CLIENT_SECRET for token cookie encryption.");
    error.statusCode = 400;
    throw error;
  }
  return crypto.createHash("sha256").update(secret).digest();
}

function encryptTokens(tokens) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getTokenSecret(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((buffer) => buffer.toString("base64url")).join(".");
}

function decryptTokens(value) {
  const [iv, tag, ciphertext] = value.split(".").map((part) => Buffer.from(part, "base64url"));
  if (!iv || !tag || !ciphertext) throw new Error("Token cookie is malformed.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", getTokenSecret(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  return JSON.parse(plaintext);
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
  return withExpiry(payload);
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
