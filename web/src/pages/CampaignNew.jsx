import { useState } from "react";
import { api, go } from "../api.js";
import { Empty, ErrorBox, Loading, useAction, useApi } from "../components/ui.jsx";

export function TemplateFields({ template, params, setParams }) {
  if (!template) return null;
  return (
    <div className="stack">
      {params.map((p, i) => (
        <div key={i} className="card" style={{ marginBottom: 0 }}>
          <div className="small mut" style={{ marginBottom: 6, fontFamily: "var(--font-mono)" }}>{`{{${i + 1}}} in ${template.name}`}</div>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <select value={p.type} onChange={(e) => {
              const next = [...params];
              next[i] = e.target.value === "contact_name" ? { type: "contact_name", fallback: "" } : { type: "text", value: "" };
              setParams(next);
            }}>
              <option value="contact_name">Contact's name</option>
              <option value="text">Fixed text</option>
            </select>
            {p.type === "contact_name" ? (
              <input className="grow" placeholder="If no name: there" value={p.fallback} onChange={(e) => {
                const next = [...params]; next[i] = { ...p, fallback: e.target.value }; setParams(next);
              }} />
            ) : (
              <input className="grow" placeholder="Text for every contact" value={p.value} onChange={(e) => {
                const next = [...params]; next[i] = { ...p, value: e.target.value }; setParams(next);
              }} />
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function paramsComplete(params) {
  return params.every((p) => (p.type === "contact_name" ? p.fallback.trim() : p.value.trim()));
}

// Renders the template body the way a message bubble would carry it, with a
// sample name filled into contact_name slots. Labelled Message preview.
export function previewBody(template, params) {
  let i = 0;
  return (template.bodyText || "").replace(/\{\{\s*(\d+)\s*\}\}/g, (m) => {
    const p = params[i++];
    if (!p) return "Riya";
    return p.type === "contact_name" ? "Riya" : (p.value.trim() || m);
  });
}

export default function CampaignNew() {
  const { data, error, loading, reload } = useApi("/templates");
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [params, setParams] = useState([]);
  const action = useAction();

  const usable = (data?.templates || []).filter((t) => t.usable);
  const template = usable.find((t) => t.id === templateId);

  const pick = (id) => {
    setTemplateId(id);
    const t = usable.find((x) => x.id === id);
    setParams(Array.from({ length: t?.paramCount || 0 }, () => ({ type: "contact_name", fallback: "" })));
  };

  const sync = () => action.run(async () => {
    await api("/templates/sync", { method: "POST" });
    await reload();
  });

  const create = () => action.run(async () => {
    const res = await api("/campaigns", { method: "POST", body: { name, templateId, params } });
    go(`/campaigns/${res.campaign.id}/audience`);
  });

  return (
    <>
      <div className="head"><h1>New campaign</h1><span className="small faint">1 of 3</span></div>
      <div className="sub">Message → Audience → Send</div>
      <ErrorBox error={error || action.error} onRetry={error ? reload : undefined} />
      {loading && !data ? <Loading /> : data && !data.sender ? (
        <div className="card"><Empty>No active WhatsApp number. <a href="#/number">Set one up</a> before creating a campaign.</Empty></div>
      ) : data && (
        <>
          <label className="field" style={{ marginBottom: 18 }}>
            <span>Name it something you'll recognise</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="November offer" />
          </label>

          <h2>Pick the message</h2>
          <div className="small mut" style={{ margin: "-4px 0 10px" }}>Message preview · approved templates on {data.sender.displayNumber}</div>
          {usable.length === 0 && <div className="alert warn">No approved templates on this number. Create one in Meta's WhatsApp Manager, wait for approval, then refresh.</div>}
          {usable.map((t) => (
            <div key={t.id} className={`wa pick ${t.id === templateId ? "picked" : ""}`} style={{ marginBottom: 12 }} onClick={() => pick(t.id)}>
              <div className="bub out">
                {t.id === templateId ? previewBody(t, params) : previewBody(t, [])}
                <div className="bmeta">6:56 pm <span className="ticks">✓✓</span></div>
              </div>
              <div className="row" style={{ justifyContent: "flex-end", marginTop: 6, flexWrap: "nowrap" }}>
                <span className="small mut">{t.name} · {t.language}</span>
                {t.id === templateId && <span style={{ width: 20, height: 20, borderRadius: "50%", background: "var(--ink)", color: "#fff", display: "grid", placeItems: "center", fontSize: 12 }}>✓</span>}
              </div>
            </div>
          ))}
          <div className="row" style={{ marginBottom: 16 }}>
            <button type="button" className="secondary" disabled={action.busy} onClick={sync}>{action.busy ? "Refreshing…" : "Refresh from Meta"}</button>
          </div>

          {template && params.length > 0 && <TemplateFields template={template} params={params} setParams={setParams} />}
          <div style={{ marginTop: 16 }}>
            <button className="block" disabled={action.busy || !name.trim() || !template || !paramsComplete(params)} onClick={create}>Continue to audience</button>
          </div>
        </>
      )}
    </>
  );
}
