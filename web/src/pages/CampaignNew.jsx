import TemplateInspection from "../components/TemplateInspection.jsx";
import { useEffect, useRef, useState } from "react";
import { api, go } from "../api.js";
import { Empty, ErrorBox, Loading, useAction, useApi } from "../components/ui.jsx";
import { ImageUpload, MessageBubble } from "../components/media.jsx";
import { assetStillValid } from "../lib/uploadGuard.js";

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
              <input className="grow" placeholder="Fallback if no name" value={p.fallback} onChange={(e) => {
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

// Manual entry: type an approved template's exact name and language. The CRM asks Meta for that one
// template in the active number's Messaging account and adds it to the list if it exists.
function LookupByName({ senderNumber, onFound }) {
  const [open, setOpen] = useState(false);
  const [tplName, setTplName] = useState("");
  const [language, setLanguage] = useState("");
  const [result, setResult] = useState(null);
  const action = useAction();

  const submit = (e) => {
    e.preventDefault();
    setResult(null);
    action.run(async () => {
      const res = await api("/templates/lookup", { method: "POST", body: { name: tplName.trim(), language: language.trim() } });
      setResult(res.template);
      await onFound(res.template);
    });
  };

  if (!open) {
    return (
      <div style={{ marginBottom: 16 }}>
        <button type="button" className="link-btn" onClick={() => setOpen(true)}>Can&apos;t find your template? Enter its name</button>
      </div>
    );
  }
  return (
    <form className="card stack lookup-card" onSubmit={submit}>
      <div>
        <b>Find a template by name</b>
        <div className="small mut">Type it exactly as shown in WhatsApp Manager.</div>
      </div>
      <label className="field"><span>Template name</span>
        <input value={tplName} onChange={(e) => setTplName(e.target.value)} placeholder="youth_camp_poster" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
      </label>
      <label className="field"><span>Language code</span>
        <input value={language} onChange={(e) => setLanguage(e.target.value)} placeholder="en, en_US or hi" autoCapitalize="none" autoCorrect="off" spellCheck={false} required />
      </label>
      <ErrorBox error={action.error} />
      {result && (result.usable
        ? <div className="alert ok" style={{ marginBottom: 0 }}>Found {result.name} ({result.language}). It&apos;s selected above{result.needsImage ? "; upload its header image below" : ""}.</div>
        : <div className="alert warn" style={{ marginBottom: 0 }}>Found {result.name} ({result.language}), but it can&apos;t be used: {result.status !== "APPROVED" ? ({ PENDING: "Pending approval", REJECTED: "Rejected", PAUSED: "Paused", DISABLED: "Disabled" }[result.status] || result.status) : result.unsupportedReason}</div>)}
      <div className="row">
        <button disabled={action.busy || !tplName.trim() || !language.trim()}>{action.busy ? "Looking up…" : "Look up"}</button>
        <button type="button" className="secondary" onClick={() => { setOpen(false); setResult(null); action.setError(null); }}>Close</button>
      </div>
    </form>
  );
}

export default function CampaignNew() {
  const { data, error, loading, reload } = useApi("/templates");
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [params, setParams] = useState([]);
  const [asset, setAsset] = useState(null);
  const [assetUrl, setAssetUrl] = useState(null);
  const action = useAction();

  const all = data?.templates || [];
  const usable = all.filter((t) => t.usable);
  const unusable = all.filter((t) => !t.usable);
  const template = usable.find((t) => t.id === templateId);

  const selectedRef = useRef(templateId);
  selectedRef.current = templateId;
  // An attached image is dropped if the active number changes (it can only be sent by its own number).
  useEffect(() => {
    if (asset && !asset.stored && data?.sender && !assetStillValid(asset, data.sender.id)) {
      setAsset(null);
      setAssetUrl(null);
    }
  }, [asset, data?.sender]);

  const pickTemplate = (t) => {
    setTemplateId(t.id);
    setParams(Array.from({ length: t?.paramCount || 0 }, () => ({ type: "contact_name", fallback: "" })));
    setAsset(t?.defaultImage || null);
    setAssetUrl(t?.defaultImage?.previewUrl || null);
  };
  const pick = (id) => {
    const t = usable.find((x) => x.id === id);
    if (t && t.id !== templateId) pickTemplate(t);
  };

  const sync = () => action.run(async () => {
    await api("/templates/sync", { method: "POST" });
    await reload();
  });

  const create = () => action.run(async () => {
    const body = { name, templateId, params };
    if (template?.needsImage) body.mediaAssetId = asset?.id;
    const res = await api("/campaigns", { method: "POST", body });
    go(`/campaigns/${res.campaign.id}/audience`);
  });

  const imageReady = !template?.needsImage || Boolean(asset);

  return (
    <>
      <div className="head"><h1>New campaign</h1></div>
      <TemplateInspection />
      <ErrorBox error={error || action.error} onRetry={error ? reload : undefined} />
      {loading && !data ? <Loading /> : data && !data.sender ? (
        <div className="card"><Empty>No active WhatsApp number. <a href="#/number">Set one up</a> before creating a campaign.</Empty></div>
      ) : data && (
        <>
          <label className="field" style={{ marginBottom: 18 }}>
            <span>Campaign name</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="November offer" />
          </label>

          <label className="field" style={{ marginBottom: 12 }}>
            <span>Template</span>
            <select value={templateId} onChange={(e) => {
              if (!e.target.value) {
                setTemplateId(""); setParams([]); setAsset(null); setAssetUrl(null);
              } else pick(e.target.value);
            }}>
              <option value="">Select a template</option>
              {usable.map((t) => <option key={t.id} value={t.id}>{t.name} ({t.language})</option>)}
            </select>
          </label>
          {usable.length === 0 && <div className="alert warn">No approved templates this app can send in this Messaging account. Create one in Meta&apos;s WhatsApp Manager, wait for approval, then refresh.</div>}
          <div style={{ marginBottom: 12 }}>
          {template?.needsImage ? (
            <ImageUpload
              key={template.id}
              rememberDefault
              onAutoSelected={(a) => { if (template.id !== selectedRef.current) return; setAsset(a); setAssetUrl(a.previewUrl); }}
              inlineActions={<button type="button" className="secondary" disabled={action.busy} onClick={sync}>{action.busy ? "Refreshing…" : "Refresh from Meta"}</button>}
              asset={asset}
              templateId={template.id}
              activeSenderId={data.sender.id}
              senderNumber={data.sender.displayNumber}
              onUploaded={(a, url, forTemplateId) => action.run(async () => {
                if (forTemplateId !== selectedRef.current) return;
                // Select only after the default has been saved successfully.
                const saved = await api(`/templates/${forTemplateId}/default-image`, { method: "PUT", body: { mediaAssetId: a.id } });
                await reload();
                if (forTemplateId !== selectedRef.current) return;
                setAsset(saved.defaultImage);
                setAssetUrl(saved.defaultImage.previewUrl);
              })}
            />
          ) : <button type="button" className="secondary" disabled={action.busy} onClick={sync}>{action.busy ? "Refreshing…" : "Refresh from Meta"}</button>}
          </div>
          {template && (
            <>
              <div className="small mut" style={{ marginBottom: 8 }}>Message preview</div>
              <div className="wa" style={{ marginBottom: 12 }}>
                <MessageBubble
                  body={previewBody(template, params)}
                  needsImage={template.needsImage}
                  imageUrl={assetUrl}
                  headerText={template.headerText}
                  footer={template.footerText}
                  buttons={template.buttons}
                  showDestinations
                />
              </div>
            </>
          )}
          {unusable.length > 0 && (
            <details className="card cant-use">
              <summary>{unusable.length} template{unusable.length > 1 ? "s" : ""} cannot be used here</summary>
              <div className="stack" style={{ marginTop: 8 }}>
                {unusable.map((t) => (
                  <div key={t.id} className="unsupported small">
                    <b>{t.name}</b> · {t.language}
                    <div className="reason">{t.status !== "APPROVED" ? ({ PENDING: "Pending approval", REJECTED: "Rejected", PAUSED: "Paused", DISABLED: "Disabled" }[t.status] || t.status) : t.unsupportedReason}</div>
                  </div>
                ))}
              </div>
            </details>
          )}
          {template && params.length > 0 && <TemplateFields template={template} params={params} setParams={setParams} />}
          {template?.needsImage && !asset && <div className="small mut" style={{ marginTop: 10 }}>Choose an image once. It will be remembered for this template.</div>}
          <div style={{ marginTop: 16 }}>
            <button className="block" disabled={action.busy || !name.trim() || !template || !paramsComplete(params) || !imageReady} onClick={create}>Continue to audience</button>
          </div>
        </>
      )}
    </>
  );
}
