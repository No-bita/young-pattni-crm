import { useEffect, useMemo, useState } from "react";
import { parseCsv, toImportRows } from "../lib/contactCsv.js";
import { api, fmtDate } from "../api.js";
import { Ava, Empty, ErrorBox, Loading, Strip, useAction, useApi } from "../components/ui.jsx";

import ListPagination from "../components/ListPagination.jsx";
import { pageInfo } from "../lib/pagination.js";
import ImportBatchFilter from "../components/ImportBatchFilter.jsx";

function Importer({ onDone }) {
  const [importName, setImportName] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [parsed, setParsed] = useState(null);
  const [result, setResult] = useState(null);
  const { busy, error, run, setError } = useAction();

  const onFile = async (e) => {
    setResult(null);
    setParsed(null);
    setRequestId(crypto.randomUUID());
    setError(null);
    const file = e.target.files?.[0];
    if (!file) return;
    const out = toImportRows(parseCsv(await file.text()));
    if (out.error) setError(new Error(out.error));
    setParsed(out.error ? null : { name: file.name, rows: out.rows });
  };

  const submit = () => run(async () => {
    let res;
    try {
      res = await api("/contacts/import", { method: "POST", body: { rows: parsed.rows, importName, filename: parsed.name, requestId } });
    } catch (e) {
      if (e.data?.import) { setResult(e.data.import); setParsed(null); onDone(); }
      throw e;
    }
    setResult(res);
    setParsed(null);
    onDone();
  });

  return (
    <div className="card">
      <h2>Import CSV</h2>
      <div className="stack">
        <label className="field"><span>Import name</span><input required maxLength={120} placeholder="e.g. November youth outreach" value={importName} onChange={(e) => { setImportName(e.target.value); setRequestId(crypto.randomUUID()); }} /></label>
        <input type="file" accept=".csv,text/csv" onChange={onFile} />
        <ErrorBox error={error} />
        {parsed && (
          <>
            <div>{parsed.rows.length} rows · {parsed.name}</div>
            <div className="table-wrap">
              <table>
                <thead><tr><th>Phone</th><th>Name</th></tr></thead>
                <tbody>{parsed.rows.slice(0, 5).map((r, i) => <tr key={i}><td>{r.phone}</td><td>{r.name}</td></tr>)}</tbody>
              </table>
            </div>
            <div className="mut small">Numbers without a country code are treated as Indian (+91). Contacts who opted out stay opted out.</div>
            <div><button disabled={busy || !importName.trim()} onClick={submit}>{busy ? "Importing…" : `Import ${parsed.rows.length} rows`}</button></div>
          </>
        )}
        {result && (
          <div className={`alert ${result.invalid.length ? "warn" : "ok"}`}>
            <b>{result.name}</b> · {result.status}
            <div>{result.created} added, {result.updated} updated, {result.unchanged} unchanged
            {result.duplicatesInFile ? `, ${result.duplicatesInFile} duplicate rows ignored` : ""}.
            </div>
            {result.invalid.length > 0 && (
              <>
                {" "}{result.invalid.length} rows were not imported:
                <ul>{result.invalid.slice(0, 20).map((r) => <li key={r.row}>Row {r.row} ({r.phone || "empty"}): {r.error}</li>)}</ul>
              </>
            )}
          </div>
        )}
        {data && <ListPagination total={data.total} page={page} onPage={setPage} noun="contacts" busy={loading} />}
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
  const [importId, setImportId] = useState("");
  const [importRefresh, setImportRefresh] = useState(0);
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const [panel, setPanel] = useState(null);
  const limit = 50;
  const path = useMemo(() => `/contacts?q=${encodeURIComponent(q)}&importId=${encodeURIComponent(importId)}&filter=${filter}&limit=${limit}&offset=${page * limit}`, [q, filter, page, importId]);
  const { data, error, loading, reload } = useApi(path);
  useEffect(() => { if (data && !loading) { const safe = pageInfo(data.total, page).page; if (safe !== page) setPage(safe); } }, [data,loading,page]);

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
      {panel === "import" && <Importer onDone={() => { reload(); setImportRefresh((n) => n + 1); }} />}
      <div className="card">
        <ImportBatchFilter value={importId} refreshKey={importRefresh} onChange={(id) => { setImportId(id); setPage(0); }} />
        <div className="row" style={{ marginBottom: 8, marginTop: 12 }}>
          <input className="grow" placeholder="Search name or number" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} />
          <select value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0); }}>
            <option value="all">All contacts</option>
            <option value="active">Can be messaged</option>
            <option value="suppressed">Opted out</option>
          </select>
        </div>
        <ErrorBox error={error} onRetry={reload} />
        {loading && !data ? <Loading /> : data && data.contacts.length === 0 ? (
          <Empty>{q || importId || filter !== "all" ? "No contacts match." : "No contacts yet. Add one or import a CSV."}</Empty>
        ) : data && (
          <>
            <div>
              {data.contacts.map((c) => (
                <div key={c.id} className="crow">
                  <Ava name={c.name} />
                  <div className="grow">
                    <b>{c.name || <span className="mut">No name</span>}</b>
                    <div className="small mut">
                      {c.phone}
                      {c.lastMessageAt && ` · last message ${fmtDate(c.lastMessageAt)}`}
                    </div>
                    <div className="small mut">Added {fmtDate(c.createdAt)}</div>
                  </div>
                  {c.suppressed
                    ? <Strip tone="r" dot={false}>Opted out</Strip>
                    : null}
                </div>
              ))}
            </div>

          </>
        )}
      </div>
    </>
  );
}
