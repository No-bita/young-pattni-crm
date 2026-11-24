import { prepareContactImport, missingNamesError } from "../../../src/lib/contact-import.js";

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
  return rows;
}

export function toImportRows(table) {
  if (!table.length || !table.some((r) => r.some((c) => c.trim()))) return { rows: [], error: "The file is empty." };
  const header = table[0].map((h) => h.trim().toLowerCase());
  const phoneCol = header.findIndex((h) => ["phone", "mobile", "number", "phone number", "whatsapp"].includes(h));
  const nameCol = header.findIndex((h) => ["name", "full name", "contact name"].includes(h));
  if (phoneCol === -1) return { rows: [], error: 'Add a header row with a "phone" column and a "name" column.' };
  const rows = table.slice(1).map((r, i) => ({ sourceRow: i + 2, phone: (r[phoneCol] || "").trim(), name: nameCol >= 0 ? (r[nameCol] || "").trim() : "" })).filter((r) => r.phone || r.name);
  const { missingNameRows } = prepareContactImport(rows);
  if (missingNameRows.length) return { rows: [], error: missingNamesError(missingNameRows) };
  return { rows };
}
