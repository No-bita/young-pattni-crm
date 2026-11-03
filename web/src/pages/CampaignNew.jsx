import { useState } from "react";
import { api, go } from "../api.js";
import { Empty, ErrorBox, Loading, useAction, useApi } from "../components/ui.jsx";

export function TemplateFields({ template, params, setParams }) {
  if (!template) return null;
  return (
    <div className="stack">
      <div className="card" style={{ background: "var(--surface-muted)", marginBottom: 0 }}>
        <div className="muted small">Template text</div>
        <div style={{ whiteSpace: "pre-wrap" }}>{template.bodyText}</div>
      </div>
      {params.map((p, i) => (
        <div key={i} className="row">
          <span className="mono" style={{ width: 48 }}>{`{{${i + 1}}}`}</span>
          <select value={p.type} onChange={(e) => {
            const next = [...params];
            next[i] = e.target.value === "contact_name" ? { type: "contact_name", fallback: "" } : { type: "text", value: "" };
            setParams(next);
          }}>
            <option value="contact_name">Contact's name</option>
            <option value="text">Fixed text</option>
          </select>
          {p.type === "contact_name" ? (
            <input className="grow" placeholder="Use this when a contact has no name (e.g. there)" value={p.fallback} onChange={(e) => {
              const next = [...params]; next[i] = { ...p, fallback: e.target.value }; setParams(next);
            }} />
          ) : (
            <input className="grow" placeholder="Text for every contact" value={p.value} onChange={(e) => {
              const next = [...params]; next[i] = { ...p, value: e.target.value }; setParams(next);
            }} />
          )}
        </div>
      ))}
    </div>
  );
}

export function paramsComplete(params) {
  return params.every((p) => (p.type === "contact_name" ? p.fallback.trim() : p.value.trim()));
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
      <div className="head"><h1>New campaign</h1></div>
      <div className="steps"><span className="on">1. Message</span><span>2. Audience</span><span>3. Review and confirm</span></div>
      <ErrorBox error={error || action.error} onRetry={error ? reload : undefined} />
      {loading && !data ? <Loading /> : data && !data.sender ? (
        <div className="card"><Empty>No active WhatsApp number. <a href="#/number">Set one up</a> before creating a campaign.</Empty></div>
      ) : data && (
        <div className="card stack">
          <label className="field"><span>Campaign name</span><input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label className="field">
            <span>Approved template on {data.sender.displayNumber}</span>
            <div className="row">
              <select className="grow" value={templateId} onChange={(e) => pick(e.target.value)}>
                <option value="">Choose a template</option>
                {usable.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}
              </select>
              <button type="button" className="secondary" disabled={action.busy} onClick={sync}>Refresh from Meta</button>
            </div>
          </label>
          {usable.length === 0 && <div className="alert warn">No approved templates on this number. Create one in Meta's WhatsApp Manager, wait for approval, then refresh.</div>}
          <TemplateFields template={template} params={params} setParams={setParams} />
          <div><button disabled={action.busy || !name.trim() || !template || !paramsComplete(params)} onClick={create}>Continue to audience</button></div>
        </div>
      )}
    </>
  );
}
