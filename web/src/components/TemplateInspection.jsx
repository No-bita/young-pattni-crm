import { useRef, useState } from "react";
import { ApiError, fmtDate } from "../api.js";
import { ErrorBox, useApi } from "./ui.jsx";

const sourceLabel = (r) => ({ url: "Image URL returned", upload_handle: "Approval upload handle returned", numeric_reference: "Numeric reference returned", opaque_string: "Other reference returned", invalid_url: "Invalid URL returned" }[r.kind] || "Unexpected reference type");

const RESPONSE_REASONS = new Set([
  "CONTENT_TYPE", "BODY_MISSING", "UTF8_INVALID", "JSON_INVALID", "ROOT_TYPE",
  "ID_MISSING", "ID_MISMATCH", "COMPONENTS_TYPE", "COMPONENTS_LIMIT", "COMPONENT_TYPE",
  "BUTTONS_TYPE", "BUTTONS_LIMIT", "BUTTON_TYPE", "HEADER_REFERENCES_LIMIT", "EXAMPLE_VALUES_LIMIT",
]);
export default function TemplateInspection() {
  const { data } = useApi("/templates/inspection");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [used, setUsed] = useState(false);
  const running = useRef(false);
  // The server hides this action when disabled, expired, or outside its account/template scope.
  if (!data?.enabled) return null;
  const inspect = async () => {
    if (running.current || used) return;
    running.current = true;
    setBusy(true);
    setUsed(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`/api/templates/${encodeURIComponent(data.template.id)}/inspect`, {
        method: "POST", credentials: "same-origin", headers: { "X-Template-Inspection": "1" },
      });
      const body = await response.json();
      if (!response.ok) throw new ApiError(body?.error || "The inspection hit a bump", response.status, body);
      setResult(body);
    } catch (e) {
      setError(e instanceof ApiError ? e : new ApiError("Couldn't finish this peek at Meta. No messages were sent", 0, null));
    } finally {
      running.current = false;
      setBusy(false);
    }
  };
  const reason = error?.data?.code === "INVALID_RESPONSE" && RESPONSE_REASONS.has(error?.data?.reason) ? error.data.reason : null;
  const inventory = result?.inventory;
  const headers = inventory?.components?.filter((c) => c.type === "HEADER") || [];
  const refs = headers.flatMap((c) => c.example?.headerHandle?.items || (c.example?.headerHandle?.item ? [c.example.headerHandle.item] : []))
    .filter((r) => ["url", "upload_handle", "numeric_reference", "opaque_string"].includes(r.kind));
  return (
    <section className="card template-inspection" aria-labelledby="inspection-heading">
      <div className="row" style={{ justifyContent: "space-between", marginBottom: 8 }}>
        <h2 id="inspection-heading" style={{ margin: 0 }}>A peek at Meta</h2>
        <span className="strip n">Diagnostic only</span>
      </div>
      <div className="small mut" style={{ marginBottom: 12 }}>Check what Meta returns for this template, without sending a message</div>
      <div className="inspection-template"><b>{data.template.name}</b><span className="small mut">{data.template.language}</span></div>
      <button type="button" className="secondary" disabled={busy || used || Date.now() >= Date.parse(data.expiresAt)} onClick={inspect}>
        {busy ? "Taking a peek…" : used ? "Inspection requested" : "Inspect template"}
      </button>
      <div className="small mut" style={{ marginTop: 8 }}>Available until {fmtDate(data.expiresAt)} · Private values stay hidden</div>
      <div aria-live="polite" aria-busy={busy}>
        {busy && <p className="small mut">One template, one read. Nothing is being sent</p>}
        <div style={{ marginTop: error || result ? 12 : 0 }}><ErrorBox error={error} /></div>
        {reason && <div className="small" role="status" style={{ marginTop: 8 }}>
          Inspection reason: <code>{reason}</code>. No response values are shown. Don't retry yet
        </div>}
        {inventory && <>
          <div className={`alert ${refs.length ? "ok" : "warn"}`}>
            {refs.length ? "Meta returned a header reference" : inventory.componentsState === "absent" ? "Meta did not return the components field" : "No header reference found in this response"}
            <div className="small" style={{ marginTop: 4 }}>{refs.length ? "This doesn't prove that the image can be reused or will stay available" : "This describes this response only, not whether Meta has an image elsewhere"}</div>
          </div>
          {refs.map((r, i) => <div className="inspection-row" key={i}><span>{sourceLabel(r)}</span>{r.hostname && <span className="mono">{r.hostname === "hidden_non_meta_host" ? "Hostname hidden" : r.hostname}</span>}</div>)}
          <div className="inspection-row"><span>Template status</span><b>{inventory.status === "ABSENT" ? "Not returned" : inventory.status}</b></div>
          <div className="inspection-row"><span>Variable format</span><b>{inventory.parameterFormat === "ABSENT" ? "Not returned" : inventory.parameterFormat}</b></div>
          <div className="inspection-row"><span>Components returned</span><b>{inventory.components.map((c) => c.type).join(", ") || "None"}</b></div>
          <div className="small mut" style={{ marginTop: 10 }}>{result.graphVersion} · {result.requestCount} Meta read · Text, examples and full links hidden</div>
          <details style={{ marginTop: 12 }}>
            <summary>Sanitized field inventory</summary>
            <pre className="inspection-json">{JSON.stringify(result, null, 2)}</pre>
          </details>
        </>}
      </div>
    </section>
  );
}
