// Pre-import checks are switched off for now (see the commented blocks below); restore them to re-enable.
// import { prepareContactImport, missingNamesError } from "../../../src/lib/contact-import.js";

// Minimal RFC 4180-style CSV parser (quoted fields, escaped quotes, CRLF).
export function parseCsv(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
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

function looksLikePhone(value) {
  const s = String(value ?? "").trim();
  return /^[+\d\s\-().]+$/.test(s) && s.replace(/\D/g, "").length >= 6;
}

// Row 1 is always ignored. The phone column is whichever of the first two columns has more phone-like values.
export function detectPhoneColumn(table) {
  const sample = table.slice(1, 51);
  const c0 = sample.filter((r) => looksLikePhone(r[0])).length;
  const c1 = sample.filter((r) => looksLikePhone(r[1])).length;
  return c1 > c0 ? 1 : 0;
}

export function toImportRows(table) {
  if (!table.length || !table.some((r) => r.some((c) => c.trim()))) return { rows: [], error: "The file is empty." };
  const dataRows = table.slice(1);
  // Pre-import check switched off for now:
  // if (!dataRows.length) return { rows: [], error: "No data rows found after row 1." };
  // Pre-import check switched off for now:
  // const hasPhones = dataRows.slice(0, 50).some((r) => looksLikePhone(r[0]) || looksLikePhone(r[1]));
  // if (!hasPhones) return { rows: [], error: "Could not find a column with phone numbers." };
  const phoneCol = detectPhoneColumn(table);
  const nameCol = phoneCol === 0 ? 1 : 0;
  const rows = dataRows.map((r, i) => ({ sourceRow: i + 2, phone: (r[phoneCol] || "").trim(), name: (r[nameCol] || "").trim() })).filter((r) => r.phone || r.name);
  // Pre-import check switched off for now (rows with a phone but no name):
  // const { missingNameRows } = prepareContactImport(rows);
  // if (missingNameRows.length) return { rows: [], error: missingNamesError(missingNameRows) };
  return { rows };
}
