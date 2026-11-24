import "../style.css";
import { useEffect, useRef, useState } from "react";
import { api, fmtDate } from "../api.js";
import { ErrorBox } from "./ui.jsx";

const statuses = [["all", "All contacts"], ["active", "Can be messaged"], ["suppressed", "Opted out"]];
export default function ContactsFilter({ value, onChange, refreshKey = 0 }) {
  const [open, setOpen] = useState(false);
  const [imports, setImports] = useState([]);
  const [total, setTotal] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);
  const root = useRef(null);
  const button = useRef(null);
  const generation = useRef(0);
  const inFlight = useRef(false);
  const load = async (offset = 0, version = generation.current) => {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError(null);
    try {
      const result = await api(`/contacts/imports?limit=25&offset=${offset}`);
      if (version !== generation.current) return;
      setImports(previous => offset === 0 ? result.imports : [...new Map([...previous, ...result.imports].map(item => [item.id,item])).values()]);
      setTotal(result.total);
    } catch (error) { if (version === generation.current) setError(error); }
    finally { if (version === generation.current) { inFlight.current=false;setBusy(false); } }
  };
  useEffect(() => {
    const version = ++generation.current;
    inFlight.current=false;
    load(0,version);
    return () => { generation.current++; inFlight.current=false; };
  }, [refreshKey]);
  useEffect(() => {
    if (!open) return;
    const outside = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    const escape = event => { if (event.key === "Escape") { setOpen(false); button.current?.focus(); } };
    document.addEventListener("pointerdown",outside);
    document.addEventListener("keydown",escape);
    return () => { document.removeEventListener("pointerdown",outside);document.removeEventListener("keydown",escape); };
  }, [open]);
  const choose = (next, item = null) => { setSelected(item);onChange(next);setOpen(false);button.current?.focus(); };
  const label = value.importId ? (selected?.name || imports.find(item=>item.id===value.importId)?.name || "Selected import") : statuses.find(([key])=>key===value.filter)?.[1] || "All contacts";
  return <div className="contacts-filter" ref={root}>
    <button ref={button} className="secondary contacts-filter-toggle" aria-label={`Contacts filter: ${label}`} aria-expanded={open} aria-controls="contacts-filter-options" onClick={()=>setOpen(!open)}>{label}<span aria-hidden="true">▾</span></button>
    {open && <div id="contacts-filter-options" className="contacts-filter-options" aria-label="Contact filters">
      {statuses.map(([key,label])=><button key={key} className="contacts-filter-option" aria-pressed={!value.importId && value.filter===key} onClick={()=>choose({filter:key,importId:""})}>{!value.importId && value.filter===key ? "✓ " : ""}{label}</button>)}
      <div className="small mut contacts-filter-heading">Imports</div>
      {!imports.length && !busy && !error && <div className="small mut" style={{padding:12}}>No imports yet.</div>}
      {imports.map(item=><button key={item.id} className="contacts-filter-option" aria-pressed={value.importId===item.id} onClick={()=>choose({filter:"all",importId:item.id},item)}>
        <b>{value.importId===item.id ? "✓ " : ""}{item.name}</b>
        <span className="small mut">{fmtDate(item.createdAt)} · {item.created+item.updated+item.unchanged} contacts{item.status!=="completed" ? ` · ${item.status}` : ""}</span>
      </button>)}
      {busy && <div role="status" className="small mut" style={{padding:12}}>Loading imports…</div>}
      <ErrorBox error={error} onRetry={()=>load(imports.length)} />
      {imports.length<total && !error && <button className="link-btn" style={{padding:12}} disabled={busy} onClick={()=>load(imports.length)}>Load more imports</button>}
    </div>}
  </div>;
}
