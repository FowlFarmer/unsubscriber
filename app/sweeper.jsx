"use client";

import { useEffect, useState } from "react";

const dbName = "subscription-sweeper";
const storeName = "snapshots";
const rowHeight = 72;
const virtualViewportHeight = 560;
const overscanRows = 8;

function displayCount(value) {
  return Number.isFinite(value) ? String(value) : "0";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...options.headers,
    },
  });
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload.error || "Request failed.");
    error.detail = payload.detail;
    error.status = response.status;
    throw error;
  }
  return payload;
}

function openCacheDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(storeName, { keyPath: "accountCacheKey" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readCachedSnapshot(accountCacheKey) {
  if (!accountCacheKey || typeof indexedDB === "undefined") return null;
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).get(accountCacheKey);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}

async function writeCachedSnapshot(snapshot) {
  const db = await openCacheDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(snapshot);
    transaction.oncomplete = () => {
      db.close();
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  });
}

async function removeCachedSubscriptions(accountCacheKey, subscriptionIds) {
  const snapshot = await readCachedSnapshot(accountCacheKey);
  if (!snapshot) return;
  const remove = new Set(subscriptionIds);
  await writeCachedSnapshot({
    ...snapshot,
    subscriptions: snapshot.subscriptions.filter((subscription) => !remove.has(subscription.subscriptionId)),
  });
}

function filterSubscriptions(subscriptions, pattern, flags) {
  if (!pattern) return subscriptions;
  if (!/^[dgimsuvy]*$/.test(flags) || new Set(flags).size !== flags.length) {
    throw new Error("Regex flags are invalid.");
  }
  let regex;
  try {
    regex = new RegExp(pattern, flags);
  } catch (error) {
    throw new Error(`Regex is invalid: ${error.message}`);
  }
  return subscriptions.filter((subscription) => {
    regex.lastIndex = 0;
    return regex.test(subscription.title);
  });
}

function channelUrl(subscription) {
  return subscription.channelUrl || `https://www.youtube.com/channel/${subscription.channelId}`;
}

export default function Sweeper() {
  const [status, setStatus] = useState(null);
  const [pattern, setPattern] = useState("");
  const [flags, setFlags] = useState("i");
  const [acknowledged, setAcknowledged] = useState(false);
  const [subscriptions, setSubscriptions] = useState([]);
  const [matches, setMatches] = useState([]);
  const [snapshotMeta, setSnapshotMeta] = useState(null);
  const [message, setMessage] = useState("Sign in, enter a regex, and preview before deleting anything.");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [deletingOne, setDeletingOne] = useState("");
  const [helpOpen, setHelpOpen] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);

  const deleteRemaining = status?.deleteQuota?.remaining ?? 0;
  const deleteLimit = status?.deleteQuota?.limit ?? 25;
  const snapshotLimit = status?.snapshotLimit ?? 2000;
  const ready = Boolean(status?.configured && status?.authenticated);
  const deleteQuotaExhausted = ready && deleteRemaining <= 0;
  const canDelete = confirmation.trim() === String(matches.length) && matches.length > 0 && matches.length <= deleteRemaining && !busy;
  const searchButtonText = subscriptions.length ? "Search cached list" : "Fetch monthly snapshot";
  const visibleStart = Math.max(0, Math.floor(scrollTop / rowHeight) - overscanRows);
  const visibleCount = Math.ceil(virtualViewportHeight / rowHeight) + overscanRows * 2;
  const visibleMatches = matches.slice(visibleStart, visibleStart + visibleCount);
  const topSpacerHeight = visibleStart * rowHeight;
  const bottomSpacerHeight = Math.max(0, (matches.length - visibleStart - visibleMatches.length) * rowHeight);
  const quotaMessage =
    deleteQuotaExhausted
      ? "Monthly API delete quota exhausted. Open matched channel links and unsubscribe manually on YouTube."
      : matches.length > deleteRemaining
        ? `You have ${deleteRemaining} API delete${deleteRemaining === 1 ? "" : "s"} left this month, so bulk delete is unavailable for ${matches.length} matches. Use row deletes or open channel links manually.`
        : "";

  async function refreshStatus() {
    const nextStatus = await api("/api/status");
    setStatus(nextStatus);
    return nextStatus;
  }

  useEffect(() => {
    refreshStatus().catch((error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    if (!status?.accountCacheKey) return;
    readCachedSnapshot(status.accountCacheKey)
      .then((snapshot) => {
        if (!snapshot) return;
        setSubscriptions(snapshot.subscriptions);
        setSnapshotMeta(snapshot);
        setMessage(`Loaded ${snapshot.subscriptions.length} cached subscriptions from this browser.`);
      })
      .catch((error) => setMessage(`Could not read browser cache: ${error.message}`));
  }, [status?.accountCacheKey]);

  async function preview(event) {
    event.preventDefault();
    if (!acknowledged) {
      setMessage("Check the acknowledgement before previewing matches.");
      return;
    }
    if (!status?.authenticated) {
      setMessage("Sign in before fetching or searching subscriptions.");
      return;
    }
    setBusy(true);
    setMessage(subscriptions.length ? "Searching cached subscriptions..." : "Fetching this month’s subscription snapshot...");
    try {
      let source = subscriptions;
      if (!source.length) {
        const snapshot = await api("/api/subscriptions/snapshot", { method: "POST" });
        source = snapshot.subscriptions;
        const cached = {
          accountCacheKey: snapshot.accountCacheKey,
          fetchedAt: snapshot.fetchedAt,
          period: snapshot.period,
          truncated: snapshot.truncated,
          subscriptions: source,
        };
        await writeCachedSnapshot(cached);
        setSubscriptions(source);
        setSnapshotMeta(cached);
      }
      const nextMatches = filterSubscriptions(source, pattern, flags);
      setMatches(nextMatches);
      setScrollTop(0);
      setConfirmation("");
      setMessage(
        nextMatches.length
          ? `Found ${nextMatches.length} matching channel title${nextMatches.length === 1 ? "" : "s"} in ${source.length} cached subscriptions.`
          : `No channel titles matched that regex in ${source.length} cached subscriptions.`,
      );
    } catch (error) {
      if (error.detail?.reason === "SNAPSHOT_QUOTA_USED") {
        setMessage("This Google account already used its monthly fetch, and this browser has no cached subscription list. Use the browser where you fetched the list, or wait until next month.");
      } else {
        setMessage(error.message);
      }
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribe() {
    if (!canDelete) return;
    const subscriptionIds = matches.map((match) => match.subscriptionId);
    setBusy(true);
    setMessage(`Unsubscribing from ${subscriptionIds.length} channel${subscriptionIds.length === 1 ? "" : "s"}...`);
    try {
      const result = await api("/api/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ subscriptionIds }),
      });
      const deletedIds = result.results.filter((item) => item.ok).map((item) => item.subscriptionId);
      setMessage(
        result.quotaExhausted
          ? `Deleted ${result.deleted}; failed ${result.failed}. Monthly API delete quota is exhausted, but channel links remain available for manual unsubscribe.`
          : `Deleted ${result.deleted}; failed ${result.failed}.`,
      );
      setSubscriptions((current) => current.filter((subscription) => !deletedIds.includes(subscription.subscriptionId)));
      setMatches((current) => current.filter((match) => !deletedIds.includes(match.subscriptionId)));
      if (status?.accountCacheKey) await removeCachedSubscriptions(status.accountCacheKey, deletedIds);
      setStatus((current) => (current ? { ...current, deleteQuota: result.deleteQuota } : current));
      setConfirmation("");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  async function unsubscribeOne(match) {
    if (deletingOne || busy || deleteQuotaExhausted) return;
    setDeletingOne(match.subscriptionId);
    setMessage(`Unsubscribing from ${match.title}...`);
    try {
      const result = await api("/api/unsubscribe", {
        method: "POST",
        body: JSON.stringify({ subscriptionIds: [match.subscriptionId] }),
      });
      const item = result.results[0];
      if (!item?.ok) throw new Error(item?.error || "Could not unsubscribe from that channel.");
      setSubscriptions((current) => current.filter((candidate) => candidate.subscriptionId !== match.subscriptionId));
      setMatches((current) => current.filter((candidate) => candidate.subscriptionId !== match.subscriptionId));
      if (status?.accountCacheKey) await removeCachedSubscriptions(status.accountCacheKey, [match.subscriptionId]);
      setStatus((current) => (current ? { ...current, deleteQuota: result.deleteQuota } : current));
      setConfirmation("");
      setMessage(`Unsubscribed from ${match.title}.`);
    } catch (error) {
      setMessage(error.message);
    } finally {
      setDeletingOne("");
    }
  }

  async function signOut() {
    setBusy(true);
    setMessage("Signing out...");
    try {
      await api("/auth/signout", { method: "POST" });
      setStatus((current) => (current ? { ...current, authenticated: false } : current));
      setSubscriptions([]);
      setMatches([]);
      setSnapshotMeta(null);
      setConfirmation("");
      setMessage("Signed out. Sign in again when you want to scan subscriptions.");
      await refreshStatus();
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <section className="command-panel" aria-labelledby="app-title">
        <div className="help-wrap">
          <button className="help-button" type="button" aria-expanded={helpOpen} aria-controls="quota-help" onClick={() => setHelpOpen((open) => !open)}>
            ?
          </button>
          {helpOpen && (
            <div className="help-popover" id="quota-help" role="dialog" aria-label="Quota and cache explanation">
              <strong>Monthly quota</strong>
              <p>The app can fetch up to {snapshotLimit.toLocaleString()} subscriptions once per Google account each UTC calendar month.</p>
              <p>The fetched list is stored in this browser’s local cache, not in the app database. Regex searches run against that browser cache.</p>
              <p>If you use another browser after spending the monthly fetch, that browser may not have the cached list and cannot fetch again until next month.</p>
              <p>Each Google account also gets {deleteLimit} API-powered unsubscribe deletes per month. If you run out, open matched channel links and unsubscribe manually on YouTube.</p>
            </div>
          )}
        </div>
        <div className="masthead">
          <p className="eyebrow">Local YouTube API Tool</p>
          <h1 id="app-title">Subscription Sweeper</h1>
          <a className="docs-link" href="https://developers.google.com/youtube/v3/docs/subscriptions/delete" target="_blank" rel="noreferrer">
            API docs
          </a>
        </div>

        <div className={`status-strip ${ready ? "ready" : ""}`}>
          <span className="status-dot" />
          <span>
            {!status
              ? "Checking configuration..."
              : !status.configured
                ? `Missing OAuth credentials. Redirect URI: ${status.redirectUri}`
                : !status.authenticated
                  ? `OAuth configured. Sign in with redirect URI: ${status.redirectUri}`
                  : "Signed in. Preview a regex before unsubscribing."}
          </span>
        </div>

        <div className="actions-row">
          <a className={`button primary ${status?.configured === false ? "disabled" : ""}`} href="/auth/start" aria-disabled={status?.configured === false}>
            {status?.authenticated ? "Reconnect Google" : "Sign in with Google"}
          </a>
          {status?.authenticated && (
            <button className="button" onClick={signOut} type="button" disabled={busy}>
              Sign out
            </button>
          )}
          <button className="button" onClick={() => refreshStatus().catch((error) => setMessage(error.message))} type="button">
            Refresh
          </button>
        </div>

        <form className="regex-form" onSubmit={preview}>
          <label htmlFor="pattern">Channel title regex</label>
          <div className="regex-box">
            <span>/</span>
            <input id="pattern" name="pattern" autoComplete="off" spellCheck="false" placeholder="news|clips|official" required value={pattern} onChange={(event) => setPattern(event.target.value)} />
            <span>/</span>
            <input id="flags" name="flags" autoComplete="off" spellCheck="false" value={flags} aria-label="Regex flags" onChange={(event) => setFlags(event.target.value)} />
          </div>

          <div className="control-grid">
            <label className="check">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              <span>I understand matching channels can be unsubscribed.</span>
            </label>
            <button className="button primary" type="submit" disabled={busy}>
              {searchButtonText}
            </button>
          </div>
        </form>
      </section>

      <section className="results-panel" aria-live="polite">
        <div className="metrics">
          <div>
            <span className="metric-value">{displayCount(matches.length)}</span>
            <span className="metric-label">matches</span>
          </div>
          <div>
            <span className="metric-value">{displayCount(subscriptions.length)}</span>
            <span className="metric-label">cached subscriptions</span>
          </div>
          <div>
            <span className="metric-value">{displayCount(deleteRemaining)}</span>
            <span className="metric-label">API deletes left</span>
          </div>
        </div>

        {snapshotMeta && (
          <div className="cache-band">
            Cached {snapshotMeta.subscriptions.length} subscriptions from {new Date(snapshotMeta.fetchedAt).toLocaleString()}
            {snapshotMeta.truncated ? `; capped at ${snapshotLimit.toLocaleString()}.` : "."}
          </div>
        )}

        {matches.length > 0 && (
          <div className="danger-band">
            <div>
              <strong>Ready to unsubscribe</strong>
              <p>Review the matched channels, then confirm the exact count.</p>
            </div>
            <div className="confirm-row">
              <input inputMode="numeric" autoComplete="off" placeholder="count" aria-label="Matched count confirmation" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} />
              <button className="button danger" type="button" disabled={!canDelete} onClick={unsubscribe}>
                Unsubscribe
              </button>
            </div>
          </div>
        )}

        {quotaMessage && <div className="message warning">{quotaMessage}</div>}
        <div className="message">{message}</div>
        <div className="table-wrap" onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Channel ID</th>
                <th>Subscription ID</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {topSpacerHeight > 0 && (
                <tr aria-hidden="true">
                  <td className="virtual-spacer" colSpan={4} style={{ height: topSpacerHeight }} />
                </tr>
              )}
              {visibleMatches.map((match) => (
                <tr key={match.subscriptionId}>
                  <td>
                    <div className="channel-cell">
                      <a href={channelUrl(match)} target="_blank" rel="noreferrer" aria-label={`Open ${match.title} on YouTube`}>
                        {match.thumbnail ? <img src={match.thumbnail} alt="" /> : <span className="thumbnail-placeholder" />}
                      </a>
                      <div>
                        <a className="channel-title channel-link" href={channelUrl(match)} target="_blank" rel="noreferrer">
                          {match.title}
                        </a>
                        <div className="channel-description">{match.description || "No description"}</div>
                      </div>
                    </div>
                  </td>
                  <td className="mono">{match.channelId}</td>
                  <td className="mono">{match.subscriptionId}</td>
                  <td>
                    <button className="row-action danger" type="button" disabled={busy || deleteQuotaExhausted || deletingOne === match.subscriptionId} onClick={() => unsubscribeOne(match)}>
                      {deletingOne === match.subscriptionId ? "Deleting..." : "Delete"}
                    </button>
                  </td>
                </tr>
              ))}
              {bottomSpacerHeight > 0 && (
                <tr aria-hidden="true">
                  <td className="virtual-spacer" colSpan={4} style={{ height: bottomSpacerHeight }} />
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
