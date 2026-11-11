import { useEffect, useMemo, useState } from "react";
import { api, fmtDate, go } from "../api.js";
import { Ava, Empty, ErrorBox, Loading, Pill, Strip, useAction, useApi } from "../components/ui.jsx";
import { previewBody } from "./CampaignNew.jsx";
import { ImageUpload, MessageBubble } from "../components/media.jsx";

const TONE = { completed: "g", sending: "a", scheduled: "a", draft: "n", cancelled: "n" };
const LABEL = { completed: "Completed", sending: "Sending", scheduled: "Scheduled", draft: "Draft", cancelled: "Cancelled" };

function AudienceStep({ campaign, initialIds, onSaved }) {
  const [selected, setSelected] = useState(() => new Set(initialIds || []));
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const limit = 50;
  const list = useApi(`/contacts?q=${encodeURIComponent(q)}&filter=all&limit=${limit}&offset=${page * limit}`, [q, page]);
  const action = useAction();
  const [note, setNote] = useState(null);

  const toggle = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelected(next);
  };

  const selectAllMatching = () => action.run(async () => {
    const res = await api(`/contacts/ids?q=${encodeURIComponent(q)}`);
    setSelected(new Set([...selected, ...res.ids]));
    setNote(res.truncated ? `Only the first ${res.cap} matching contacts were added: a campaign can reach at most ${res.cap}.` : `${res.ids.length} matching contacts who can be messaged were added.`);
  });

  const save = () => action.run(async () => {
    await api(`/campaigns/${campaign.id}/audience`, { method: "PUT", body: { contactIds: [...selected] } });
    onSaved();
  });

  return (
    <>
      <div className="head"><h1>Who receives it</h1><span className="small faint">2 of 3</span></div>
      <ErrorBox error={action.error || list.error} />
      {note && <div className="alert ok">{note}</div>}
      <div className="row" style={{ marginBottom: 12, flexWrap: "nowrap" }}>
        <input className="grow" placeholder="Search name or number" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <button className="secondary" disabled={action.busy} onClick={selectAllMatching}>Select all matching</button>
        <button className="secondary" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>Clear</button>
        <b className="grow" style={{ textAlign: "right" }}>{selected.size} selected</b>
      </div>
      {list.loading && !list.data ? <Loading /> : list.data && list.data.contacts.length === 0 ? (
        <div className="card"><Empty>{q ? "No contacts match." : <>No contacts yet. <a href="#/contacts">Add or import contacts</a> first.</>}</Empty></div>
      ) : list.data && (
        <div className="card" style={{ padding: "6px 16px" }}>
          {list.data.contacts.map((c) => (
            <label key={c.id} className="crow" style={{ cursor: c.suppressed ? "default" : "pointer" }}>
              <input type="checkbox" className="check" disabled={c.suppressed} checked={!c.suppressed && selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name || c.phone}`} />
              <Ava name={c.name} />
              <div className="grow">
                <b>{c.name || <span className="mut">No name</span>}</b>
                <div className="small mut">{c.phone}</div>
              </div>
              {c.suppressed && <span className="strip r" style={{ fontSize: 11.5 }}>Opted out</span>}
            </label>
          ))}
        </div>
      )}
      {list.data && (
        <div className="row" style={{ marginBottom: 12 }}>
          <button className="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <button className="secondary" disabled={(page + 1) * limit >= list.data.total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
      <button className="block" disabled={action.busy || selected.size === 0} onClick={save}>Save audience and review</button>
    </>
  );
}

function toLocalInput(iso) {
  if (!iso) return undefined;
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function ReviewStep({ campaign, template, onLaunched, onChanged }) {
  const preview = useApi(`/campaigns/${campaign.id}/preview`);
  const [mode, setMode] = useState("now");
  const [when, setWhen] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const action = useAction();
  const a = preview.data?.audience;
  const blocker = preview.data?.blocker;
  const latestStart = preview.data?.latestStart;
  const [replaced, setReplaced] = useState(null);
  const mediaBlocked = blocker && String(blocker.code || "").startsWith("MEDIA_");

  const replaceImage = (asset, url) => action.run(async () => {
    await api(`/campaigns/${campaign.id}`, { method: "PATCH", body: { mediaAssetId: asset.id } });
    setReplaced(url);
    preview.reload();
    onChanged?.();
  });

  const launch = () => action.run(async () => {
    const body = { confirmCount: a.sendable };
    if (mode === "later") body.scheduledAt = new Date(when).toISOString();
    try {
      await api(`/campaigns/${campaign.id}/launch`, { method: "POST", body });
      onLaunched();
    } catch (e) {
      if (e.data?.code === "AUDIENCE_CHANGED") {
        setConfirmed(false);
        preview.reload();
      }
      throw e;
    }
  });

  if (preview.loading && !preview.data) return <Loading />;
  return (
    <>
      <div className="head"><h1>Review and send</h1><span className="small faint">3 of 3</span></div>
      <ErrorBox error={preview.error || action.error} />
      <div className="stats" style={{ marginBottom: 12 }}>
        <div className="stat"><b>{a?.sendable ?? 0}</b><span className="mut">will receive it</span></div>
        <div className="stat"><b>{a?.selected ?? 0}</b><span className="mut">selected</span></div>
        <div className="stat"><b>{a?.suppressed ?? 0}</b><span className="mut">opted out, skipped</span></div>
      </div>
      {template && (
        <div className="card">
          <div className="small mut" style={{ marginBottom: 8 }}>Message preview · {campaign.templateName} ({campaign.templateLanguage})</div>
          <div className="wa">
            <MessageBubble
              body={previewBody({ ...template, bodyText: campaign.content?.body?.text ?? campaign.frozen?.bodyText ?? template.bodyText }, campaign.params || [])}
              needsImage={(campaign.content?.header?.format ?? template.headerFormat) === "IMAGE"}
              imageUrl={replaced || campaign.media?.previewUrl}
              headerText={campaign.content?.header?.text ?? template.headerText}
              footer={campaign.content?.footer?.text ?? template.footerText}
              buttons={campaign.content?.buttons ?? template.buttons}
              showDestinations
            />
          </div>
          {campaign.media && (
            <div className="small mut" style={{ marginTop: 8 }}>
              Image uploaded through {campaign.media.senderNumber || "a WhatsApp number"} · must start by {fmtDate(latestStart || campaign.media.latestStart)}
            </div>
          )}
        </div>
      )}
      {blocker ? (
        <>
          <div className="alert bad">{blocker.message}</div>
          {mediaBlocked && template?.needsImage && (
            <ImageUpload key={`replace-${campaign.id}`} templateId={campaign.id} asset={null} onUploaded={replaceImage} />
          )}
        </>
      ) : (
        <div className="card stack">
          <div className="row">
            <label className="row" style={{ gap: 6 }}><input type="radio" className="check" checked={mode === "now"} onChange={() => setMode("now")} /> Send now</label>
            <label className="row" style={{ gap: 6 }}><input type="radio" className="check" checked={mode === "later"} onChange={() => setMode("later")} /> Schedule</label>
            {mode === "later" && <input type="datetime-local" value={when} max={toLocalInput(latestStart)} onChange={(e) => setWhen(e.target.value)} />}
          </div>
          {mode === "later" && latestStart && (
            <div className="small mut">Meta keeps uploaded images for 30 days, so this image campaign must be scheduled to start by {fmtDate(latestStart)}.</div>
          )}
          <label className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
            <input type="checkbox" className="check" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            <span className="grow">I confirm this campaign goes to exactly {a?.sendable} contacts</span>
          </label>
          <div className="row">
            <button className="secondary" onClick={() => go(`/campaigns/${campaign.id}/audience`)}>Change audience</button>
            <button className="grow" style={{ justifyContent: "center" }} disabled={!confirmed || action.busy || (mode === "later" && !when)} onClick={launch}>
              {mode === "later" ? "Schedule campaign" : `Send to ${a?.sendable} contacts`}
            </button>
          </div>
        </div>
      )}
    </>
  );
}

function Progress({ campaign, reload }) {
  const [filter, setFilter] = useState("");
  const rec = useApi(`/campaigns/${campaign.id}/recipients${filter ? `?status=${filter}` : ""}`, [filter, campaign.recipients]);
  const action = useAction();
  const r = campaign.recipients || {};
  const live = campaign.status === "sending";

  useEffect(() => {
    if (!live) return undefined;
    const t = setInterval(reload, 4000);
    return () => clearInterval(t);
  }, [live, reload]);

  const cancel = () => action.run(async () => {
    await api(`/campaigns/${campaign.id}/cancel`, { method: "POST" });
    reload();
  });

  const stats = [["sent", (r.sent || 0) + (r.delivered || 0) + (r.read || 0)], ["delivered", (r.delivered || 0) + (r.read || 0)], ["read", r.read || 0], ["failed", r.failed || 0], ["opted out, skipped", r.skipped_suppressed || 0]];
  if (r.queued || r.sending) stats.unshift(["queued", (r.queued || 0) + (r.sending || 0)]);
  if (r.cancelled) stats.push(["cancelled", r.cancelled]);
  return (
    <>
      <ErrorBox error={action.error} />
      {campaign.error && <div className="alert bad">{campaign.error}</div>}
      <div className="card stack">
        <div className="row">
          <div className="grow">
            <div className="small mut">
              {campaign.status === "scheduled" ? `Goes out ${fmtDate(campaign.scheduledAt)}` : `Started ${fmtDate(campaign.launchedAt)}`}
              {campaign.completedAt && ` · Finished ${fmtDate(campaign.completedAt)}`}
              {campaign.confirmedCount != null && ` · Confirmed for ${campaign.confirmedCount} contacts`}
            </div>
            {campaign.sendDeadline && (
              <div className="small mut">
                Sending window ends {fmtDate(campaign.sendDeadline)}. Recipients still queued then are not sent.
                {campaign.notSentDeadline > 0 && <b> {campaign.notSentDeadline} not sent because the window ended.</b>}
              </div>
            )}
            {campaign.contentCheck && (
              <div className="small mut check-note">
                {campaign.contentCheck.source === "meta"
                  ? `Template compared with Meta ${fmtDate(campaign.contentCheck.at)}.`
                  : `Template NOT freshly checked with Meta at ${fmtDate(campaign.contentCheck.at)}: ${campaign.contentCheck.note}`}
              </div>
            )}
            {campaign.media && (
              <div className="row small" style={{ marginTop: 8, flexWrap: "nowrap" }}>
                <img src={campaign.media.previewUrl} alt="Header image" style={{ width: 44, height: 44, objectFit: "cover", borderRadius: 8 }} />
                <span className="mut">Header image {campaign.media.originalName} · sent through {campaign.media.senderNumber || "the campaign's number"}</span>
              </div>
            )}
          </div>
          {(campaign.status === "scheduled" || campaign.status === "sending") && (
            <button className="danger" disabled={action.busy} onClick={cancel}>{campaign.status === "scheduled" ? "Cancel schedule" : "Stop sending"}</button>
          )}
        </div>
        {campaign.status !== "scheduled" && (
          <div className="stats">{stats.map(([k, v]) => <div className="stat" key={k}><b className={k === "failed" && v ? "bad" : ""}>{v}</b><span className="mut">{k}</span></div>)}</div>
        )}
      </div>
      {campaign.status !== "scheduled" && (
        <div className="card">
          <div className="row" style={{ marginBottom: 12 }}>
            <h2 className="grow" style={{ margin: 0 }}>Recipients</h2>
            <select value={filter} onChange={(e) => setFilter(e.target.value)}>
              <option value="">All</option><option value="sent">Sent</option><option value="delivered">Delivered</option><option value="read">Read</option>
              <option value="failed">Failed</option><option value="skipped_suppressed">Skipped (opted out)</option><option value="queued">Queued</option>
            </select>
          </div>
          <ErrorBox error={rec.error} />
          {rec.data && rec.data.recipients.length === 0 ? <Empty>No recipients in this view.</Empty> : rec.data && (
            <>
              <div className="mobile-records">
                {rec.data.recipients.map((x) => (
                  <div key={x.id} className="record">
                    <div className="record-head"><b>{x.name || "No name"}</b><Pill status={x.status} /></div>
                    <div className="small mut mono">{x.phone}</div>
                    {x.error && <div className="small record-error">{x.error}</div>}
                  </div>
                ))}
              </div>
            <div className="table-wrap desktop-records">
              <table>
                <thead><tr><th>Contact</th><th>Phone</th><th>Status</th><th>Detail</th></tr></thead>
                <tbody>{rec.data.recipients.map((x) => (
                  <tr key={x.id}><td>{x.name || <span className="mut">No name</span>}</td><td className="mono">{x.phone}</td><td><Pill status={x.status} /></td><td className="mut small">{x.error}</td></tr>
                ))}</tbody>
              </table>
            </div>
            </>
          )}
        </div>
      )}
    </>
  );
}

export default function CampaignDetail({ id, step }) {
  const { data, error, loading, reload } = useApi(`/campaigns/${id}`);
  const campaign = data?.campaign;
  const current = useMemo(() => {
    if (!campaign || campaign.status !== "draft") return null;
    if (step === "audience" || !campaign.audience.chosen) return "audience";
    return "review";
  }, [campaign, step]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorBox error={error} onRetry={reload} />;
  const showSteps = current || campaign.status !== "draft";
  return (
    <>
      <div className="head">
        <div className="grow">
          <a href="#/campaigns" className="mut small backlink">← Campaigns</a>
          <div className="row" style={{ flexWrap: "nowrap" }}>
            <h1>{campaign.name}</h1>
            <Strip tone={TONE[campaign.status] || "n"} dot={campaign.status !== "draft" && campaign.status !== "cancelled"}>{LABEL[campaign.status] || campaign.status}</Strip>
          </div>
        </div>
        {!current && <button type="button" className="secondary" onClick={reload} disabled={loading} aria-label="Refresh campaign">{loading ? "Refreshing…" : "Refresh"}</button>}
      </div>
      {showSteps && !current && <div className="sub">{campaign.templateName} from {campaign.senderNumber || "the active number"}</div>}
      {current === "audience" && <AudienceStep campaign={campaign} initialIds={data.audienceIds} onSaved={() => { go(`/campaigns/${id}/review`); reload(); }} />}
      {current === "review" && <ReviewStep campaign={campaign} template={data.template} onLaunched={() => { go(`/campaigns/${id}`); reload(); }} onChanged={reload} />}
      {!current && <Progress campaign={campaign} reload={reload} />}
    </>
  );
}
