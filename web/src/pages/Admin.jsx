import { fmtDate } from "../api.js";
import { Empty, ErrorBox, Loading, useApi } from "../components/ui.jsx";

export default function Admin() {
  const { data, error, loading, reload } = useApi("/admin/overview");
  return (
    <>
      <div className="head"><h1>Accounts</h1><button className="secondary" onClick={reload}>Refresh</button></div>
      <div className="sub">Every CRM account on this deployment</div>
      <div className="card">
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data ? <Loading /> : data && data.accounts.length === 0 ? <Empty>No accounts.</Empty> : data && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Account</th><th>Login</th><th>Active number</th><th>Contacts</th><th>Opted out</th><th>Sent (7 days)</th><th>Failed (7 days)</th><th>Campaigns running</th><th>Created</th></tr></thead>
              <tbody>{data.accounts.map((a) => (
                <tr key={a.id}>
                  <td>{a.name} {a.isAdmin && <span className="pill neutral">admin</span>}</td>
                  <td className="mono">{a.login}</td>
                  <td>{a.activeNumber || <span className="mut">None</span>}</td>
                  <td>{a.contacts}</td><td>{a.suppressed}</td><td>{a.sent7d}</td>
                  <td>{a.failed7d ? <span className="pill bad">{a.failed7d}</span> : 0}</td>
                  <td>{a.activeCampaigns}</td>
                  <td className="mut">{fmtDate(a.createdAt)}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
