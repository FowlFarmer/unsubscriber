"use client";

import { useEffect, useMemo, useState } from "react";

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
  if (!response.ok) throw new Error(payload.error || "Request failed.");
  return payload;
}

export default function Sweeper() {
  const [status, setStatus] = useState(null);
  const [pattern, setPattern] = useState("");
  const [flags, setFlags] = useState("i");
  const [acknowledged, setAcknowledged] = useState(false);
  const [matches, setMatches] = useState([]);
  const [total, setTotal] = useState(0);
  const [message, setMessage] = useState("Sign in, enter a regex, and preview before deleting anything.");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);

  const quotaUnits = useMemo(() => matches.length * 50, [matches]);
  const ready = Boolean(status?.configured && status?.authenticated);
  const canDelete = confirmation.trim() === String(matches.length) && matches.length > 0 && !busy;

  async function refreshStatus() {
    const nextStatus = await api("/api/status");
    setStatus(nextStatus);
  }

  useEffect(() => {
    refreshStatus().catch((error) => setMessage(error.message));
  }, []);

  async function preview(event) {
    event.preventDefault();
    if (!acknowledged) {
      setMessage("Check the acknowledgement before previewing matches.");
      return;
    }
    setBusy(true);
    setMessage("Fetching subscriptions and testing titles...");
    try {
      const result = await api("/api/preview", {
        method: "POST",
        body: JSON.stringify({ pattern, flags }),
      });
      setMatches(result.matches);
      setTotal(result.total);
      setConfirmation("");
      setMessage(
        result.matches.length
          ? `Found ${result.matches.length} matching channel title${result.matches.length === 1 ? "" : "s"}.`
          : "No channel titles matched that regex.",
      );
    } catch (error) {
      setMessage(error.message);
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
      setMessage(`Deleted ${result.deleted}; failed ${result.failed}. Run preview again to refresh the list.`);
      setMatches((current) =>
        current.filter((match) =>
          result.results.some((item) => item.subscriptionId === match.subscriptionId && !item.ok),
        ),
      );
      setConfirmation("");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <section className="command-panel" aria-labelledby="app-title">
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
              Preview matches
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
            <span className="metric-value">{displayCount(total)}</span>
            <span className="metric-label">subscriptions scanned</span>
          </div>
          <div>
            <span className="metric-value">{displayCount(quotaUnits)}</span>
            <span className="metric-label">delete quota units</span>
          </div>
        </div>

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

        <div className="message">{message}</div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Channel</th>
                <th>Channel ID</th>
                <th>Subscription ID</th>
              </tr>
            </thead>
            <tbody>
              {matches.map((match) => (
                <tr key={match.subscriptionId}>
                  <td>
                    <div className="channel-cell">
                      {match.thumbnail ? <img src={match.thumbnail} alt="" /> : <span />}
                      <div>
                        <div className="channel-title">{match.title}</div>
                        <div className="channel-description">{match.description || "No description"}</div>
                      </div>
                    </div>
                  </td>
                  <td className="mono">{match.channelId}</td>
                  <td className="mono">{match.subscriptionId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
