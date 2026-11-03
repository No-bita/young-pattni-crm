import { fmtDate, go } from "../api.js";
import { Empty, ErrorBox, Loading, Pill, useApi } from "../components/ui.jsx";

export default function Campaigns() {
  const { data, error, loading, reload } = useApi("/campaigns");
  return (
    <>
      <div className="head">
        <h1>Campaigns</h1>
        <a className="btn" href="#/campaigns/new">New campaign</a>
      </div>
      <div className="card">
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data ? <Loading /> : data && data.campaigns.length === 0 ? (
          <Empty>No campaigns yet.</Empty>
        ) : data && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Status</th><th>Template</th><th>Audience</th><th>Sent</th><th>Failed</th><th>When</th></tr></thead>
              <tbody>
                {data.campaigns.map((c) => {
                  const r = c.recipients || {};
                  const sent = (r.sent || 0) + (r.delivered || 0) + (r.read || 0);
                  return (
                    <tr key={c.id} className="click" onClick={() => go(`/campaigns/${c.id}`)}>
                      <td>{c.name}</td>
                      <td><Pill status={c.status} /></td>
                      <td className="mono">{c.templateName}</td>
                      <td>{c.audience.chosen ? c.audience.sendable : <span className="muted">Not chosen</span>}</td>
                      <td>{sent || "–"}</td>
                      <td>{r.failed || "–"}</td>
                      <td className="muted">{fmtDate(c.scheduledAt && c.status === "scheduled" ? c.scheduledAt : c.launchedAt || c.createdAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
