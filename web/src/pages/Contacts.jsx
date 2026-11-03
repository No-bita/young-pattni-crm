import { useMemo, useState } from "react";
import { api, fmtDate } from "../api.js";
import { Empty, ErrorBox, Loading, useAction, useApi } from "../components/ui.jsx";

// Minimal RFC 4180-style CSV parser (quoted fields, escaped quotes, CRLF).
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') q = false;
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function toImportRows(table) {
  if (!table.length) return { rows: [], error: "The file is empty." };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const phoneCol = header.findIndex((h) => ["phone", "mobile", "number", "phone number", "whatsapp"].includes(h));
  const nameCol = header.findIndex((h) => ["name", "full name", "contact name"].includes(h));
  if (phoneCol === -1) return { rows: [], error: 'Add a header row with a "phone" column (and optionally "name").' };
  return { rows: table.slice(1).map((r) => ({ phone: (r[phoneCol] || "").trim(), name: nameCol >= 0 ? (r[nameCol] || "").trim() : "" })) };
}

function Importer({ onDone }) {
  const [parsed, setParsed] = useState(null);
  const [result, setResult] = useState(null);
  const { busy, error, run, setError } = useAction();

  const onFile = async (e) => {
    setResult(null);
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    const out = toImportRows(parseCsv(await file.text()));
    if (out.error) setError(new Error(out.error));
    setParsed(out.error ? null : { name: file.name, rows: out.rows });
  };

  const submit = () => run(async () => {
    const res = await api("/contacts/import", { method: "POST", body: { rows: parsed.rows } });
    setResult(res);
    setParsed(null);
    onDone();
  });

  return (
    <div className="card">
      <h2>Import contacts from CSV</h2>
      <div className="stack">
        <input type="file" accept=".csv,text/csv" onChange={onFile} />
        <ErrorBox error={error} />
        {parsed && (
          <>
            <div>{parsed.rows.length} rows in {parsed.name}. First rows:</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Phone</th><th>Name</th></tr></thead>
                <tbody>{parsed.rows.slice(0, 5).map((r, i) => <tr key={i}><td>{r.phone}</td><td>{r.name}</td></tr>)}</tbody>
              </table>
            </div>
            <div className="muted small">Numbers without a country code are treated as Indian (+91). Contacts who opted out stay opted out.</div>
            <div><button disabled={busy} onClick={submit}>{busy ? "Importing…" : `Import ${parsed.rows.length} rows`}</button></div>
          </>
        )}
        {result && (
          <div className={`alert ${result.invalid.length ? "warn" : "ok"}`}>
            {result.created} added, {result.updated} updated, {result.unchanged} unchanged
            {result.duplicatesInFile ? `, ${result.duplicatesInFile} duplicate rows ignored` : ""}.
            {result.invalid.length > 0 && (
              <>
                {" "}{result.invalid.length} rows were not imported:
                <ul>{result.invalid.slice(0, 20).map((r) => <li key={r.row}>Row {r.row} ({r.phone || "empty"}): {r.error}</li>)}</ul>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function AddContact({ onDone }) {
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const { busy, error, run } = useAction();
  const submit = (e) => {
    e.preventDefault();
    run(async () => {
      await api("/contacts", { method: "POST", body: { phone, name } });
      setPhone("");
      setName("");
      onDone();
    });
  };
  return (
    <form className="card" onSubmit={submit}>
      <h2>Add a contact</h2>
      <ErrorBox error={error} />
      <div className="row">
        <input placeholder="Phone, e.g. 98765 43210 or +44…" value={phone} onChange={(e) => setPhone(e.target.value)} required />
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <button disabled={busy || !phone}>Add</button>
      </div>
    </form>
  );
}

export default function Contacts() {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [panel, setPanel] = useState(null);
  const limit = 50;
  const path = useMemo(() => `/contacts?q=${encodeURIComponent(q)}&filter=${filter}&limit=${limit}&offset=${page * limit}`, [q, filter, page]);
  const { data, error, loading, reload } = useApi(path);

  return (
    <>
      <div className="head">
        <h1>Contacts</h1>
        <div className="row">
          <button className="secondary" onClick={() => setPanel(panel === "add" ? null : "add")}>Add contact</button>
          <button className="secondary" onClick={() => setPanel(panel === "import" ? null : "import")}>Import CSV</button>
        </div>
      </div>
      {panel === "add" && <AddContact onDone={reload} />}
      {panel === "import" && <Importer onDone={reload} />}
      <div className="card">
        <div className="row" style={{ marginBottom: 12 }}>
          <input className="grow" placeholder="Search name or number" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
          <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }}>
            <option value="all">All contacts</option>
            <option value="active">Can be messaged</option>
            <option value="suppressed">Opted out</option>
          </select>
        </div>
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data ? <Loading /> : data && data.contacts.length === 0 ? (
          <Empty>{q || filter !== "all" ? "No contacts match." : "No contacts yet. Add one or import a CSV."}</Empty>
        ) : data && (
          <>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Name</th><th>Phone</th><th>Status</th><th>Last message</th><th>Added</th></tr></thead>
                <tbody>
                  {data.contacts.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name || <span className="muted">No name</span>}</td>
                      <td className="mono">{c.phone}</td>
                      <td>{c.suppressed ? <span className="pill bad" title={`Opted out ${fmtDate(c.suppressedAt)}`}>Opted out · {fmtDate(c.suppressedAt)}</span> : <span className="pill ok">Can be messaged</span>}</td>
                      <td className="muted">{fmtDate(c.lastMessageAt)}</td>
                      <td className="muted">{fmtDate(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <span className="muted grow">{data.total} contacts</span>
              <button className="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
              <button className="secondary" disabled={(page + 1) * limit >= data.total} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
