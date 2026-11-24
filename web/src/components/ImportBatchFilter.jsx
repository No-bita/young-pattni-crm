import { useState } from "react";
import { fmtDate } from "../api.js";
import { ErrorBox, useApi } from "./ui.jsx";

export default function ImportBatchFilter({ value, onChange, refreshKey = 0 }) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(0);
  const list = useApi(`/contacts/imports?q=${encodeURIComponent(q)}&limit=25&offset=${page * 25}`, [q, page, refreshKey]);
  const chosen = list.data?.imports.find((b) => b.id === value);
  return <div className="stack" style={{ gap: 8 }}>
    <label className="field"><span>Find import batch</span><input placeholder="Search import names" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} /></label>
    <label className="field"><span>Import batch</span><select aria-label="Import batch" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">All contacts, any import</option>
      {value && !list.data?.imports.some((b) => b.id === value) && <option value={value}>Selected import (outside these results)</option>}
      {list.data?.imports.map((b) => <option key={b.id} value={b.id}>{b.name} · {fmtDate(b.createdAt)} · {b.created + b.updated + b.unchanged} contacts{b.status !== "completed" ? ` · ${b.status}` : ""}</option>)}
    </select></label>
    {chosen && <div className="small mut">{chosen.filename || "No filename"} · {chosen.status} · {chosen.created} added, {chosen.updated} updated, {chosen.unchanged} unchanged. {chosen.invalid.length} invalid rows.{chosen.error && <div className="alert warn">{chosen.error}</div>}</div>}
    <ErrorBox error={list.error} onRetry={list.reload} />
    {list.data?.total > 25 && <div className="row"><button className="secondary" disabled={!page} onClick={() => setPage(page - 1)}>Earlier results</button><span className="small mut">{page * 25 + 1}–{Math.min((page + 1) * 25, list.data.total)} of {list.data.total} imports</span><button className="secondary" disabled={(page + 1) * 25 >= list.data.total} onClick={() => setPage(page + 1)}>More results</button></div>}
  </div>;
}
