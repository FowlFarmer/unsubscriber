import crypto from "node:crypto";
import { cookies } from "next/headers";

const tokenCookie = "youtube_tokens";
const oauthStateCookie = "youtube_oauth_state";
const youtubeScope = "https://www.googleapis.com/auth/youtube.force-ssl";
const identityScopes = "openid email profile";
const snapshotLimit = 2000;
const deleteLimit = 25;
const globalScouredKey = "global:subscriptions_scoured";
const globalRemovedKey = "global:subscriptions_removed";
const devEmail = "theodorez888@gmail.com";

export function getConfig() {
  const origin = process.env.APP_ORIGIN || "https://unsubscriber.tzhu.dev";
  return {
    origin,
    redirectUri: `${origin}/oauth2/callback`,
    clientId: process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    scope: `${identityScopes} ${youtubeScope}`,
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

export function clearAuthCookies(response) {
  response.cookies.delete(tokenCookie);
  response.cookies.delete(oauthStateCookie);
}

export function setOauthStateCookie(response, state) {
  response.cookies.set(oauthStateCookie, state, {
    httpOnly: true,
    maxAge: 10 * 60,
    path: "/",
    sameSite: "lax",
    secure: getConfig().origin.startsWith("https://"),
  });
}

export function readOauthStateCookie(request) {
  return request.cookies.get(oauthStateCookie)?.value;
}

export function getAccountCacheKey(user) {
  if (!user?.sub) return null;
  return crypto.createHash("sha256").update(`${getTokenSecret().toString("hex")}:${user.sub}`).digest("hex").slice(0, 32);
}

export async function getAuthStatus() {
  const config = getConfig();
  const tokens = await readTokens();
  const accountCacheKey = getAccountCacheKey(tokens?.user);
  const deleteQuota = accountCacheKey ? await getDeleteQuota(accountCacheKey) : getEmptyDeleteQuota();
  const globalStats = await getGlobalStats();
  return {
    configured: Boolean(config.clientId && config.clientSecret),
    authenticated: Boolean(tokens),
    accountCacheKey,
    email: tokens?.user?.email || "",
    origin: config.origin,
    redirectUri: config.redirectUri,
    snapshotLimit,
    deleteQuota,
    globalStats,
    redisConfigured: isRedisConfigured(),
  };
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
  const tokens = withExpiry(payload);
  tokens.user = await fetchUserInfo(tokens.access_token);
  return tokens;
}

async function fetchUserInfo(accessToken) {
  const response = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", {
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: "application/json",
    },
  });
  const payload = await response.json();
  if (!response.ok) throw googleError("Google identity request failed.", response, payload);
  if (!payload.sub) {
    const error = new Error("Google identity response did not include a stable account ID.");
    error.statusCode = 401;
    throw error;
  }
  return {
    sub: payload.sub,
    email: payload.email || "",
  };
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

async function getAccountSession() {
  let tokens = await readTokens();
  if (!tokens) {
    const error = new Error("Not signed in.");
    error.statusCode = 401;
    throw error;
  }
  if (!tokens.expires_at || Date.now() >= tokens.expires_at) tokens = await refreshAccessToken(tokens);
  if (!tokens.user?.sub) {
    tokens = { ...tokens, user: await fetchUserInfo(tokens.access_token) };
    await saveTokens(tokens);
  }
  return {
    tokens,
    accountCacheKey: getAccountCacheKey(tokens.user),
  };
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

export async function listSubscriptions(limit = snapshotLimit) {
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
  } while (pageToken && subscriptions.length < limit);
  return {
    subscriptions: subscriptions.slice(0, limit),
    truncated: Boolean(pageToken),
  };
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
    channelUrl: snippet.resourceId?.channelId ? `https://www.youtube.com/channel/${snippet.resourceId.channelId}` : "",
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
  const { subscriptions } = await listSubscriptions();
  const matches = subscriptions.filter((subscription) => {
    regex.lastIndex = 0;
    return regex.test(subscription.title);
  });
  return { total: subscriptions.length, matches };
}

export async function createSubscriptionSnapshot() {
  const { accountCacheKey } = await getAccountSession();
  if (!accountCacheKey) {
    const error = new Error("Reconnect Google before fetching subscriptions.");
    error.statusCode = 401;
    throw error;
  }

  const period = getMonthlyPeriod();
  const key = `snapshot:${period}:${accountCacheKey}`;
  const reserved = await redisCommand(["SET", key, JSON.stringify({ startedAt: new Date().toISOString() }), "EX", secondsUntilNextMonth(), "NX"]);
  if (reserved !== "OK") {
    const error = new Error("This Google account already used its monthly subscription fetch. If this browser has no cached list, sign in from the browser where you fetched it or wait until next month.");
    error.statusCode = 429;
    error.code = "SNAPSHOT_QUOTA_USED";
    error.payload = {
      reason: "SNAPSHOT_QUOTA_USED",
      period,
      snapshotLimit,
    };
    throw error;
  }

  try {
    const { subscriptions, truncated } = await listSubscriptions(snapshotLimit);
    const fetchedAt = new Date().toISOString();
    await redisCommand([
      "SET",
      key,
      JSON.stringify({ fetchedAt, period, subscriptionCount: subscriptions.length, truncated }),
      "EX",
      secondsUntilNextMonth(),
    ]);
    await incrementGlobalScoured(subscriptions.length);
    return {
      accountCacheKey,
      fetchedAt,
      period,
      snapshotLimit,
      subscriptions,
      count: subscriptions.length,
      truncated,
      globalStats: await getGlobalStats(),
    };
  } catch (error) {
    await redisCommand(["DEL", key]).catch(() => null);
    throw error;
  }
}

export async function unsubscribe(subscriptionIds) {
  const { accountCacheKey } = await getAccountSession();
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
    const reserved = await reserveDelete(accountCacheKey);
    if (!reserved.ok) {
      results.push({ subscriptionId: id, ok: false, quotaExhausted: true, error: reserved.message });
      continue;
    }
    try {
      const url = new URL("https://www.googleapis.com/youtube/v3/subscriptions");
      url.searchParams.set("id", id);
      await youtubeFetch(url, { method: "DELETE" });
      results.push({ subscriptionId: id, ok: true });
    } catch (error) {
      await releaseDelete(accountCacheKey).catch(() => null);
      results.push({ subscriptionId: id, ok: false, error: error.message });
    }
  }
  const quotaExhausted = results.some((result) => result.quotaExhausted);
  const deleted = results.filter((result) => result.ok).length;
  if (deleted) await incrementGlobalRemoved(deleted);
  return {
    deleted,
    failed: results.filter((result) => !result.ok).length,
    quotaExhausted,
    deleteQuota: await getDeleteQuota(accountCacheKey),
    globalStats: await getGlobalStats(),
    results,
  };
}

export async function getGlobalStats() {
  if (!isRedisConfigured()) {
    return {
      subscriptionsScoured: 0,
      subscriptionsRemoved: 0,
    };
  }
  const [subscriptionsScoured, subscriptionsRemoved] = await Promise.all([
    redisCommand(["GET", globalScouredKey]),
    redisCommand(["GET", globalRemovedKey]),
  ]);
  return {
    subscriptionsScoured: Math.max(0, Number(subscriptionsScoured || 0)),
    subscriptionsRemoved: Math.max(0, Number(subscriptionsRemoved || 0)),
  };
}

async function incrementGlobalScoured(count) {
  if (count > 0) await redisCommand(["INCRBY", globalScouredKey, count]);
}

export async function incrementGlobalRemoved(count = 1) {
  if (count <= 0) return getGlobalStats();
  await redisCommand(["INCRBY", globalRemovedKey, count]);
  return getGlobalStats();
}

export async function runDevCommand(command) {
  await assertDevUser();
  const normalized = String(command || "").trim();

  if (normalized === "/reset_all_quotas") {
    const deleted = await deleteKeysByPatterns(["snapshot:*", "deletes:*"]);
    return {
      ok: true,
      message: `Reset ${deleted} quota key${deleted === 1 ? "" : "s"}.`,
      deleted,
      deleteQuota: getEmptyDeleteQuota(),
      globalStats: await getGlobalStats(),
    };
  }

  if (normalized === "/reset_global_leaderboard") {
    await redisCommand(["DEL", globalScouredKey, globalRemovedKey]);
    return {
      ok: true,
      message: "Reset global community stats.",
      globalStats: await getGlobalStats(),
    };
  }

  const error = new Error("Unknown command.");
  error.statusCode = 400;
  throw error;
}

async function assertDevUser() {
  const tokens = await readTokens();
  const email = String(tokens?.user?.email || "").toLowerCase();
  if (email === devEmail) return;

  const error = new Error("Dev commands are only available to the project owner.");
  error.statusCode = tokens ? 403 : 401;
  throw error;
}

async function deleteKeysByPatterns(patterns) {
  const keySets = await Promise.all(patterns.map((pattern) => scanRedisKeys(pattern)));
  const keys = [...new Set(keySets.flat())];
  let deleted = 0;

  for (let index = 0; index < keys.length; index += 100) {
    const batch = keys.slice(index, index + 100);
    if (batch.length) deleted += Number(await redisCommand(["DEL", ...batch]) || 0);
  }

  return deleted;
}

async function scanRedisKeys(pattern) {
  const keys = [];
  let cursor = "0";

  do {
    const result = await redisCommand(["SCAN", cursor, "MATCH", pattern, "COUNT", 100]);
    cursor = String(result?.[0] ?? "0");
    keys.push(...(Array.isArray(result?.[1]) ? result[1] : []));
  } while (cursor !== "0");

  return keys;
}

function getMonthlyPeriod() {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function secondsUntilNextMonth() {
  const now = new Date();
  const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0));
  return Math.max(60, Math.ceil((nextMonth.getTime() - now.getTime()) / 1000));
}

function getRedisConfig() {
  return {
    url: process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "",
    token: process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "",
  };
}

function isRedisConfigured() {
  const config = getRedisConfig();
  return Boolean(config.url && config.token);
}

async function redisCommand(command) {
  const config = getRedisConfig();
  if (!config.url || !config.token) {
    const error = new Error("Vercel Redis/KV is not configured. Set KV_REST_API_URL and KV_REST_API_TOKEN.");
    error.statusCode = 500;
    throw error;
  }
  const response = await fetch(config.url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(command),
    cache: "no-store",
  });
  const payload = await response.json();
  if (!response.ok || payload.error) {
    const error = new Error(payload.error || `Redis command failed: ${command[0]}`);
    error.statusCode = 500;
    throw error;
  }
  return payload.result;
}

function getDeleteKey(accountCacheKey) {
  return `deletes:${getMonthlyPeriod()}:${accountCacheKey}`;
}

function getEmptyDeleteQuota() {
  return {
    limit: deleteLimit,
    used: 0,
    remaining: deleteLimit,
    period: getMonthlyPeriod(),
  };
}

export async function getDeleteQuota(accountCacheKey) {
  if (!accountCacheKey || !isRedisConfigured()) return getEmptyDeleteQuota();
  const raw = await redisCommand(["GET", getDeleteKey(accountCacheKey)]);
  const used = Math.max(0, Number(raw || 0));
  return {
    limit: deleteLimit,
    used,
    remaining: Math.max(0, deleteLimit - used),
    period: getMonthlyPeriod(),
  };
}

async function reserveDelete(accountCacheKey) {
  const key = getDeleteKey(accountCacheKey);
  const used = Number(await redisCommand(["INCR", key]));
  await redisCommand(["EXPIRE", key, secondsUntilNextMonth()]);
  if (used <= deleteLimit) return { ok: true };
  await redisCommand(["DECR", key]);
  return {
    ok: false,
    message: "Monthly API delete quota exhausted. You can still open matched channel links and unsubscribe manually on YouTube.",
  };
}

async function releaseDelete(accountCacheKey) {
  const key = getDeleteKey(accountCacheKey);
  const used = Number(await redisCommand(["DECR", key]));
  if (used < 0) await redisCommand(["SET", key, "0", "EX", secondsUntilNextMonth()]);
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
