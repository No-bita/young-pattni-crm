import { useEffect, useMemo, useState } from "react";
import { api, fmtDate, go } from "../api.js";
import { Empty, ErrorBox, Loading, Pill, useAction, useApi } from "../components/ui.jsx";

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
    <div className="card stack">
      <h2>Choose who receives "{campaign.name}"</h2>
      <ErrorBox error={action.error || list.error} />
      {note && <div className="alert ok">{note}</div>}
      <div className="row">
        <input className="grow" placeholder="Search name or number" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
        <button className="secondary" disabled={action.busy} onClick={selectAllMatching}>Select all matching</button>
        <button className="secondary" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>Clear selection</button>
      </div>
      {list.loading && !list.data ? <Loading /> : list.data && list.data.contacts.length === 0 ? (
        <Empty>{q ? "No contacts match." : <>No contacts yet. <a href="#/contacts">Add or import contacts</a> first.</>}</Empty>
      ) : list.data && (
        <div className="table-wrap">
          <table>
            <thead><tr><th></th><th>Name</th><th>Phone</th><th>Status</th></tr></thead>
            <tbody>
              {list.data.contacts.map((c) => (
                <tr key={c.id}>
                  <td>
                    <input type="checkbox" className="check" disabled={c.suppressed} checked={!c.suppressed && selected.has(c.id)} onChange={() => toggle(c.id)} aria-label={`Select ${c.name || c.phone}`} />
                  </td>
                  <td>{c.name || <span className="muted">No name</span>}</td>
                  <td className="mono">{c.phone}</td>
                  <td>{c.suppressed ? <span className="pill bad">Opted out: cannot be selected</span> : <span className="pill ok">Can be messaged</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && (
        <div className="row">
          <button className="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
          <button className="secondary" disabled={(page + 1) * limit >= list.data.total} onClick={() => setPage(page + 1)}>Next</button>
        </div>
      )}
      <div className="row">
        <b className="grow">{selected.size} selected</b>
        <button disabled={action.busy || selected.size === 0} onClick={save}>Save audience and review</button>
      </div>
    </div>
  );
}

function ReviewStep({ campaign, template, onLaunched }) {
  const preview = useApi(`/campaigns/${campaign.id}/preview`);
  const [mode, setMode] = useState("now");
  const [when, setWhen] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const action = useAction();
  const a = preview.data?.audience;
  const blocker = preview.data?.blocker;

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
    <div className="card stack">
      <h2>Review and confirm</h2>
      <ErrorBox error={preview.error || action.error} />
      <div className="stats">
        <div className="stat"><span className="muted small">Will receive it</span><b>{a?.sendable ?? 0}</b></div>
        <div className="stat"><span className="muted small">Selected</span><b>{a?.selected ?? 0}</b></div>
        <div className="stat"><span className="muted small">Skipped (opted out)</span><b>{a?.suppressed ?? 0}</b></div>
      </div>
      <div>
        <div className="muted small">Template</div>
        <div className="mono">{campaign.templateName} ({campaign.templateLanguage})</div>
        {template && <div style={{ whiteSpace: "pre-wrap", marginTop: 6 }}>{template.bodyText}</div>}
      </div>
      {blocker ? (
        <div className="alert bad">{blocker.message}</div>
      ) : (
        <>
          <div className="row">
            <label className="row"><input type="radio" checked={mode === "now"} onChange={() => setMode("now")} /> Send now</label>
            <label className="row"><input type="radio" checked={mode === "later"} onChange={() => setMode("later")} /> Schedule</label>
            {mode === "later" && <input type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}
          </div>
          <label className="row">
            <input type="checkbox" className="check" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
            I confirm this campaign goes to exactly {a?.sendable} contacts.
          </label>
          <div className="row">
            <button className="secondary" onClick={() => go(`/campaigns/${campaign.id}/audience`)}>Change audience</button>
            <button disabled={!confirmed || action.busy || (mode === "later" && !when)} onClick={launch}>
              {mode === "later" ? "Schedule campaign" : `Send to ${a?.sendable} contacts`}
            </button>
          </div>
        </>
      )}
    </div>
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

  const stats = [["Queued", (r.queued || 0) + (r.sending || 0)], ["Sent", r.sent || 0], ["Delivered", r.delivered || 0], ["Read", r.read || 0], ["Failed", r.failed || 0], ["Skipped (opted out)", r.skipped_suppressed || 0], ["Cancelled", r.cancelled || 0]];
  return (
    <>
      <ErrorBox error={action.error} />
      {campaign.error && <div className="alert bad">{campaign.error}</div>}
      <div className="card stack">
        <div className="row">
          <div className="grow">
            <div>Template <span className="mono">{campaign.templateName}</span> from {campaign.senderNumber || "the active number"}</div>
            <div className="muted small">
              {campaign.status === "scheduled" ? `Scheduled for ${fmtDate(campaign.scheduledAt)}` : `Started ${fmtDate(campaign.launchedAt)}`}
              {campaign.completedAt && ` · Finished ${fmtDate(campaign.completedAt)}`}
              {campaign.confirmedCount != null && ` · Confirmed for ${campaign.confirmedCount} contacts`}
            </div>
          </div>
          {(campaign.status === "scheduled" || campaign.status === "sending") && (
            <button className="danger" disabled={action.busy} onClick={cancel}>{campaign.status === "scheduled" ? "Cancel schedule" : "Stop sending"}</button>
          )}
        </div>
        {campaign.status !== "scheduled" && <div className="stats">{stats.map(([k, v]) => <div className="stat" key={k}><span className="muted small">{k}</span><b>{v}</b></div>)}</div>}
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
            <div className="table-wrap">
              <table>
                <thead><tr><th>Contact</th><th>Phone</th><th>Status</th><th>Detail</th></tr></thead>
                <tbody>{rec.data.recipients.map((x) => (
                  <tr key={x.id}><td>{x.name || <span className="muted">No name</span>}</td><td className="mono">{x.phone}</td><td><Pill status={x.status} /></td><td className="muted small">{x.error}</td></tr>
                ))}</tbody>
              </table>
            </div>
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
  return (
    <>
      <div className="head">
        <div>
          <a href="#/campaigns" className="muted small">← Campaigns</a>
          <h1>{campaign.name} <Pill status={campaign.status} /></h1>
        </div>
      </div>
      {current && (
        <div className="steps"><span>1. Message</span><span className={current === "audience" ? "on" : ""}>2. Audience</span><span className={current === "review" ? "on" : ""}>3. Review and confirm</span></div>
      )}
      {current === "audience" && <AudienceStep campaign={campaign} initialIds={data.audienceIds} onSaved={() => { go(`/campaigns/${id}/review`); reload(); }} />}
      {current === "review" && <ReviewStep campaign={campaign} template={data.template} onLaunched={() => { go(`/campaigns/${id}`); reload(); }} />}
      {!current && <Progress campaign={campaign} reload={reload} />}
    </>
  );
}
