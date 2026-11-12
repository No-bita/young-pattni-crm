import { useCallback, useEffect, useState } from "react";
import { api, statusPill } from "../api.js";

export function Pill({ status, children }) {
  const { label, cls } = statusPill(status);
  if (cls === "plain") return <span className="mut small">{children || label}</span>;
  return <span className={`pill ${cls}`}>{children || label}</span>;
}

// Semantic tinted status strip: ok -> g, warn -> a, bad -> r, anything else -> n.
export function Strip({ tone, children, dot = true }) {
  return (
    <span className={`strip ${tone}`}>
      {dot && <span className="dot"></span>}
      {children}
    </span>
  );
}

export function ErrorBox({ error, onRetry }) {
  if (!error) return null;
  const blockers = error.data?.blockers;
  return (
    <div className="alert bad" role="alert">
      {error.message}
      {Array.isArray(blockers) && blockers.length > 0 && (
        <ul>
          {blockers.map((b) => (
            <li key={b.code}>
              {b.message}
              {b.templates && ` ${b.templates.map((t) => `${t.name} (${t.language}): ${t.status}`).join(", ")}`}
              {b.campaigns && ` ${b.campaigns.map((c) => c.name).join(", ")}`}
            </li>
          ))}
        </ul>
      )}
      {onRetry && (
        <div style={{ marginTop: 8 }}>
          <button className="secondary" onClick={onRetry}>Try again</button>
        </div>
      )}
    </div>
  );
}

export function Loading() {
  return <div className="loading">Loading…</div>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

// Fetch helper with loading / error state and a reload function.
export function useApi(path, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const load = useCallback(async () => {
    if (!path) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      setState({ data: await api(path), error: null, loading: false });
    } catch (error) {
      setState({ data: null, error, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    load();
  }, [load]);
  return { ...state, reload: load };
}

// Runs a mutating call with busy + error state.
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const run = useCallback(async (fn) => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

// Initials avatar for contact rows.
export function Ava({ name }) {
  const text = (name || "").trim();
  let letters = "?";
  if (text) {
    const parts = text.split(/\s+/);
    letters = (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
  }
  return <div className="ava">{letters}</div>;
}
