import { fmtDate, go } from "../api.js";
import { Empty, ErrorBox, Loading, Strip, useApi } from "../components/ui.jsx";

const TONE = { completed: "g", sending: "a", scheduled: "a", draft: "n", cancelled: "n" };
const LABEL = { completed: "Completed", sending: "Sending", scheduled: "Scheduled", draft: "Draft", cancelled: "Cancelled" };

function summary(c) {
  const r = c.recipients || {};
  if (c.status === "scheduled") {
    return `Goes out ${fmtDate(c.scheduledAt)} · ${c.audience.chosen ? `${c.audience.sendable} people` : "audience still to pick"}`;
  }
  if (c.status === "draft") {
    return c.audience.chosen ? "Audience picked · review to send" : "Message ready · audience still to pick";
  }
  if (c.status === "cancelled") return c.error || "Cancelled before going out";
  const parts = [];
  const delivered = (r.delivered || 0) + (r.read || 0);
  if (c.status === "sending") parts.push(`${(r.sent || 0) + delivered} sent so far`);
  if (delivered) parts.push(`${delivered} delivered`);
  if (r.read) parts.push(`${r.read} read`);
  if (r.failed) parts.push(`${r.failed} failed`);
  if (r.skipped_suppressed) parts.push(`${r.skipped_suppressed} opted out, skipped`);
  if (!parts.length) parts.push("Queued");
  parts.push(`${c.audience.selected} people`);
  return parts.join(" · ");
}

export default function Campaigns() {
  const { data, error, loading, reload } = useApi("/campaigns");
  const count = data?.campaigns.length || 0;
  const running = data?.campaigns.filter((c) => c.status === "sending" || c.status === "scheduled").length || 0;
  return (
    <>
      <div className="head">
        <h1>Campaigns</h1>
        <a className="btn" href="#/campaigns/new">+ New</a>
      </div>
      <div className="sub">{count ? `${count} campaign${count === 1 ? "" : "s"}${running ? ` · ${running} running` : ""}` : "Your WhatsApp campaigns live here"}</div>
      <ErrorBox error={error} onRetry={reload} />
      {loading && !data ? <Loading /> : data && data.campaigns.length === 0 ? (
        <div className="card"><Empty>No campaigns yet<br /><span className="small">Tap + New and send your first one</span></Empty></div>
      ) : data && data.campaigns.map((c) => (
        <div key={c.id} className="card click" onClick={() => go(`/campaigns/${c.id}`)}>
          <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
            <b style={{ fontSize: 15.5 }}>{c.name}</b>
            <Strip tone={TONE[c.status] || "n"} dot={c.status !== "draft" && c.status !== "cancelled"}>{LABEL[c.status] || c.status}</Strip>
          </div>
          <div className="small mut" style={{ marginTop: 8 }}>{summary(c)}</div>
        </div>
      ))}
    </>
  );
}
