import { useMemo, useRef, useState } from "react";
import { readContactFile, contactSheetRows } from "../lib/contactFile.js";
import { api, fmtDate } from "../api.js";
import { Ava, Empty, ErrorBox, Loading, Strip, useAction, useApi } from "../components/ui.jsx";

import ImportBatchFilter from "../components/ImportBatchFilter.jsx";

function Importer({ onDone }) {
  const [importName, setImportName] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const selection = useRef(0);
  const [preview, setPreview] = useState(null);
  const [nameChoices,setNameChoices] = useState({});
  const [checking,setChecking] = useState(false);
  const [parsed, setParsed] = useState(null);
  const [result, setResult] = useState(null);
  const { busy, error, run, setError } = useAction();

  const [workbook, setWorkbook] = useState(null);
  const [sheetIndex, setSheetIndex] = useState("");
  const [reading, setReading] = useState(false);

  const chooseSheet = (book, index) => {
    setResult(null);
    setPreview(null);setNameChoices({});setRequestId(crypto.randomUUID());
    setSheetIndex(String(index));
    setParsed(null);
    setError(null);
    if (index === "") return;
    const out = contactSheetRows(book.sheets[Number(index)]);
    if (out.error) setError(new Error(out.error));
    else setParsed({ name: book.name, rows: out.rows, sheet: book.sheets[Number(index)].sheet });
  };
  const onFile = async (e) => {
    const version = ++selection.current;
    setResult(null);
    setPreview(null);setNameChoices({});setRequestId(crypto.randomUUID());
    setParsed(null);
    setWorkbook(null);
    setSheetIndex("");
    setError(null);
    const file = e.target.files?.[0];
    if (!file) { setReading(false); return; }
    setReading(true);
    try {
      const sheets = await readContactFile(file);
      if (version !== selection.current) return;
      const book = { name: file.name, sheets };
      setWorkbook(book);
      if (sheets.length === 1) chooseSheet(book, 0);
    } catch (error) {
      if (version === selection.current) setError(error);
    } finally {
      if (version === selection.current) setReading(false);
    }
  };

  const checkDuplicates = () => run(async () => {
    const version = selection.current;
    setChecking(true);
    try {
      const data=await api("/contacts/import/preview",{method:"POST",body:{rows:parsed.rows}});
      if(version !== selection.current) return;
      setPreview(data); setNameChoices({}); setRequestId(crypto.randomUUID());
    } finally {setChecking(false);}
  });
  const unresolved = preview?.conflicts.filter(group=>!nameChoices[group.phone]).length || 0;
  const submit = () => run(async () => {
    let res;
    try {
      res = await api("/contacts/import", { method: "POST", body: { rows: parsed.rows, importName, filename: parsed.name, sheetName:parsed.sheet, requestId, nameChoices } });
    } catch (e) {
      if (e.data?.import) { setResult(e.data.import); setParsed(null); onDone(); }
      if(e.data?.code === "IMPORT_NAME_CONFLICTS") { setPreview(null); setNameChoices({}); }
      throw e;
    }
    setResult(res);
    setParsed(null);
    onDone();
  });

  return (
    <div className="card">
      <h2>Import contacts</h2>
      <div className="stack">
        <label className="field"><span>Import name</span><input required maxLength={120} placeholder="e.g. November youth outreach" value={importName} onChange={(e) => { setImportName(e.target.value); setRequestId(crypto.randomUUID()); }} /></label>
        <input aria-label="Contact file" type="file" disabled={busy} accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={onFile} />
        <div className="mut small">CSV or Excel (.xlsx), up to 5 MB and 5,000 contact rows. Use phone and name columns. Keep phone cells as text to preserve leading zeros.</div>
        {reading && <div role="status">Reading file…</div>}
        {workbook?.sheets.length > 1 && <label className="stack">Choose a sheet
          <select aria-label="Sheet" value={sheetIndex} disabled={busy} onChange={(e) => { selection.current++; chooseSheet(workbook, e.target.value); }}>
            <option value="">Select a sheet</option>
            {workbook.sheets.map((sheet, i) => <option key={i} value={i}>{sheet.sheet}</option>)}
          </select>
          <span className="mut small">Only the selected sheet will be imported.</span>
        </label>}
        <ErrorBox error={error} />
        {parsed && (
          <>
            <div>{parsed.rows.length} source rows · {parsed.name}</div>
            {!preview && <button className="secondary" disabled={busy} onClick={checkDuplicates}>{checking ? "Checking…" : "Check duplicates and names"}</button>}
            {preview && <>
              <div role="status">{preview.contacts.length} unique {preview.contacts.length===1?"contact":"contacts"} · {preview.duplicatesInFile} duplicate {preview.duplicatesInFile===1?"row":"rows"} · {preview.invalid.length} invalid {preview.invalid.length===1?"row":"rows"}</div>
              {preview.invalid.length > 0 && <div className="alert warn">These rows will be skipped. Valid rows can still import:<ul>{preview.invalid.map((r,i)=><li key={i}>Row {r.row} ({r.phone || "empty"}): {r.error}</li>)}</ul></div>}
              {preview.conflicts.length > 0 && <div className="alert warn">Choose one name for each number. Existing Contacts names are included. Nothing is imported until you confirm.</div>}
              {preview.conflicts.map(group=><fieldset key={group.phone} className="stack" style={{border:"1px solid #dedbd5",borderRadius:12,padding:12,minWidth:0}}>
                <legend>+{group.phone}</legend>
                {group.candidates.map(candidate=><label key={candidate.name} style={{display:"flex",gap:8,alignItems:"start",overflowWrap:"anywhere"}}>
                  <input style={{width:"auto",marginTop:4}} type="radio" name={`name-${group.phone}`} checked={nameChoices[group.phone]?.name===candidate.name} disabled={busy} onChange={()=>{setNameChoices({...nameChoices,[group.phone]:{name:candidate.name,candidates:group.candidates.map(c=>c.name)}});setRequestId(crypto.randomUUID());}} />
                  <span><b>{candidate.name}</b><span className="small mut" style={{display:"block"}}>{candidate.existing?"In Contacts":""}{candidate.existing&&candidate.rows.length?" · ":""}{candidate.rows.length?`File rows ${candidate.rows.join(", ")}`:""}</span></span>
                </label>)}
              </fieldset>)}
              {unresolved > 0 && <div role="status">{unresolved} name {unresolved===1?"choice":"choices"} left.</div>}
            </>}
            <div className="table-wrap">
              <table>
                <thead><tr><th>Phone</th><th>Name</th></tr></thead>
                <tbody>{(preview ? preview.contacts.map(r=>({...r,phone:`+${r.phone}`,name:nameChoices[r.phone]?.name || (r.candidates.length>1?"Choose a name above":r.name)})) : parsed.rows).slice(0, 5).map((r, i) => <tr key={i}><td>{r.phone}</td><td>{r.name}</td></tr>)}</tbody>
              </table>
            </div>
            <div className="mut small">Numbers without a country code are treated as Indian (+91). Contacts who opted out stay opted out.</div>
            <div>{preview && <button disabled={busy || !importName.trim() || unresolved > 0 || !preview.contacts.length} onClick={submit}>{busy ? "Importing…" : `Import ${preview.contacts.length} ${preview.contacts.length===1?"contact":"contacts"}${preview.invalid.length ? ` · skip ${preview.invalid.length}` : ""}`}</button>}</div>
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

  return (
    <>
      <div className="head">
        <h1>Contacts</h1>
        <div className="row">
          <button className="secondary" onClick={() => setPanel(panel === "add" ? null : "add")}>Add contact</button>
          <button className="secondary" onClick={() => setPanel(panel === "import" ? null : "import")}>Import contacts</button>
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
          <Empty>{q || importId || filter !== "all" ? "No contacts match." : "No contacts yet. Add one or import a file."}</Empty>
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
            <div className="row" style={{ marginTop: 12 }}>
              <span className="mut grow">{data.total} contacts</span>
              <button className="secondary" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
              <button className="secondary" disabled={(page + 1) * limit >= data.total} onClick={() => setPage(page + 1)}>Next</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}
