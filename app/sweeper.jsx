"use client";

import { useEffect, useRef, useState } from "react";

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
    if (regex.test(subscription.title)) return true;
    regex.lastIndex = 0;
    return regex.test(subscription.description || "");
  });
}

function channelUrl(subscription) {
  return subscription.channelUrl || `https://www.youtube.com/channel/${subscription.channelId}`;
}

function trackManualRemoval(subscriptionId, setStatus, trackedManualRemovalsRef) {
  if (trackedManualRemovalsRef.current.has(subscriptionId)) return;
  trackedManualRemovalsRef.current.add(subscriptionId);
  api("/api/stats/manual-removal", { method: "POST" })
    .then((payload) => {
      setStatus((current) => (current ? { ...current, globalStats: payload.globalStats } : current));
    })
    .catch(() => {
      trackedManualRemovalsRef.current.delete(subscriptionId);
    });
}

export default function Sweeper() {
  const helpRef = useRef(null);
  const trackedManualRemovalsRef = useRef(new Set());
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
  const subscriptionsScoured = status?.globalStats?.subscriptionsScoured ?? 0;
  const subscriptionsRemoved = status?.globalStats?.subscriptionsRemoved ?? 0;
  const ready = Boolean(status?.configured && status?.authenticated);
  const deleteQuotaExhausted = ready && deleteRemaining <= 0;
  const canDelete = confirmation.trim() === String(matches.length) && matches.length > 0 && matches.length <= deleteRemaining && !busy;
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

  useEffect(() => {
    if (!helpOpen) return;
    function closeFromOutside(event) {
      if (!helpRef.current?.contains(event.target)) setHelpOpen(false);
    }
    function closeFromEscape(event) {
      if (event.key === "Escape") setHelpOpen(false);
    }
    document.addEventListener("pointerdown", closeFromOutside);
    document.addEventListener("keydown", closeFromEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFromOutside);
      document.removeEventListener("keydown", closeFromEscape);
    };
  }, [helpOpen]);

  useEffect(() => {
    if (!subscriptions.length) {
      setMatches([]);
      return;
    }
    try {
      const nextMatches = filterSubscriptions(subscriptions, pattern, flags);
      setMatches(nextMatches);
      setScrollTop(0);
      setConfirmation("");
      setMessage(
        nextMatches.length
          ? `Showing ${nextMatches.length} matching channel${nextMatches.length === 1 ? "" : "s"} from ${subscriptions.length} cached subscriptions.`
          : `No channel titles or descriptions match that regex in ${subscriptions.length} cached subscriptions.`,
      );
    } catch (error) {
      setMatches([]);
      setMessage(error.message);
    }
  }, [pattern, flags, subscriptions]);

  async function fetchSnapshot() {
    if (!acknowledged) {
      setMessage("Check the acknowledgement before fetching your subscription snapshot.");
      return;
    }
    if (!status?.authenticated) {
      setMessage("Sign in before fetching subscriptions.");
      return;
    }
    setBusy(true);
    setMessage("Fetching this month’s subscription snapshot...");
    try {
      const snapshot = await api("/api/subscriptions/snapshot", { method: "POST" });
      const cached = {
        accountCacheKey: snapshot.accountCacheKey,
        fetchedAt: snapshot.fetchedAt,
        period: snapshot.period,
        truncated: snapshot.truncated,
        subscriptions: snapshot.subscriptions,
      };
      await writeCachedSnapshot(cached);
      setSubscriptions(snapshot.subscriptions);
      setSnapshotMeta(cached);
      setScrollTop(0);
      setConfirmation("");
      setMessage(
        `Fetched and cached ${snapshot.subscriptions.length} subscriptions${snapshot.truncated ? `, capped at ${snapshotLimit.toLocaleString()}` : ""}.`,
      );
      if (snapshot.globalStats) {
        setStatus((current) => (current ? { ...current, globalStats: snapshot.globalStats } : current));
      }
    } catch (error) {
      if (error.detail?.reason === "SNAPSHOT_QUOTA_USED") {
        const hasCachedList = subscriptions.length > 0 || Boolean(snapshotMeta?.subscriptions?.length);
        setMessage(
          hasCachedList
            ? "This Google account already used its monthly fetch. Keep using the cached subscription list shown below, or wait until next month for a fresh fetch."
            : "This Google account already used its monthly fetch, and this browser has no cached subscription list. Use the browser where you fetched the list, or wait until next month.",
        );
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
      setStatus((current) =>
        current ? { ...current, deleteQuota: result.deleteQuota, globalStats: result.globalStats ?? current.globalStats } : current,
      );
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
      setStatus((current) =>
        current ? { ...current, deleteQuota: result.deleteQuota, globalStats: result.globalStats ?? current.globalStats } : current,
      );
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
      <div className="help-wrap" ref={helpRef}>
        <button className="help-button" type="button" aria-expanded={helpOpen} aria-controls="quota-help" onClick={() => setHelpOpen((open) => !open)}>
          ?
        </button>
        {helpOpen && (
          <div className="help-popover" id="quota-help" role="dialog" aria-label="Quota and cache explanation">
            <strong>What this does</strong>
            <p>Sign in with your Google account, load your YouTube subscriptions, then type a pattern to narrow the list by channel name or description.</p>
            <p>You can remove one channel at a time, or confirm a bulk unsubscribe. Channel names and thumbnails open YouTube, so you can always unsubscribe manually too.</p>
            <strong className="help-section-title">Monthly quota</strong>
            <p>Your Google account can load up to {snapshotLimit.toLocaleString()} subscriptions once each calendar month.</p>
            <p>Your loaded list is saved in this browser, on this device. The app does not store that list in its database, and searches happen locally.</p>
            <p>If you switch browsers or devices after using your monthly load, that new browser may not have your saved list and will need to wait until next month.</p>
            <p>Your Google account also gets {deleteLimit} in-app unsubscribe actions each month. If you run out, you can still open the channel links and unsubscribe on YouTube.</p>
          </div>
        )}
      </div>
      <section className="command-panel" aria-labelledby="app-title">
        <div className="masthead">
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

        <div className="snapshot-actions">
          <button className="button primary" type="button" disabled={busy || !status?.authenticated} onClick={fetchSnapshot}>
            Fetch monthly snapshot
          </button>
        </div>

        <div className="regex-form">
          <label htmlFor="pattern">Channel title or description regex</label>
          <div className="regex-box">
            <span>/</span>
            <input id="pattern" name="pattern" autoComplete="off" spellCheck="false" placeholder="news|clips|official" required value={pattern} onChange={(event) => setPattern(event.target.value)} />
            <span>/</span>
            <input id="flags" name="flags" autoComplete="off" spellCheck="false" value={flags} aria-label="Regex flags" onChange={(event) => setFlags(event.target.value)} />
          </div>

          <div className="control-grid">
            <label className="check">
              <input type="checkbox" checked={acknowledged} onChange={(event) => setAcknowledged(event.target.checked)} />
              <span>I understand this fetch uses my monthly subscription snapshot quota.</span>
            </label>
          </div>
        </div>
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

        <div className="global-stats-band" aria-label="Community totals">
          <div>
            <span className="metric-value">{displayCount(subscriptionsScoured)}</span>
            <span className="metric-label">subscriptions scoured</span>
          </div>
          <div>
            <span className="metric-value">{displayCount(subscriptionsRemoved)}</span>
            <span className="metric-label">subscriptions removed</span>
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
                <th>Action</th>
                <th>Channel</th>
                <th>Channel ID</th>
                <th>Subscription ID</th>
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
                    <button className="row-action danger" type="button" disabled={busy || deleteQuotaExhausted || deletingOne === match.subscriptionId} onClick={() => unsubscribeOne(match)}>
                      {deletingOne === match.subscriptionId ? "Deleting..." : "Delete"}
                    </button>
                  </td>
                  <td>
                    <div className="channel-cell">
                      <a
                        href={channelUrl(match)}
                        target="_blank"
                        rel="noreferrer"
                        aria-label={`Open ${match.title} on YouTube`}
                        onClick={() => trackManualRemoval(match.subscriptionId, setStatus, trackedManualRemovalsRef)}
                      >
                        {match.thumbnail ? <img src={match.thumbnail} alt="" /> : <span className="thumbnail-placeholder" />}
                      </a>
                      <div>
                        <a
                          className="channel-title channel-link"
                          href={channelUrl(match)}
                          target="_blank"
                          rel="noreferrer"
                          onClick={() => trackManualRemoval(match.subscriptionId, setStatus, trackedManualRemovalsRef)}
                        >
                          {match.title}
                        </a>
                        <div className="channel-description">{match.description || "No description"}</div>
                      </div>
                    </div>
                  </td>
                  <td className="mono">{match.channelId}</td>
                  <td className="mono">{match.subscriptionId}</td>
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
