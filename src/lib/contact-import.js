import { normalizePhone, PhoneError } from "./phone.js";

export function missingNamesError(rows) {
  const shown = rows.slice(0, 10);
  const label = shown.length === 1 ? String(shown[0]) : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  const more = rows.length > shown.length ? ` (and ${rows.length - shown.length} more)` : "";
  return `${rows.length === 1 ? "Row" : "Rows"} ${label}${more} ${rows.length === 1 ? "has" : "have"} no name. Add a name for every contact before importing. Nothing has been imported.`;
}
const text = (value, max) => String(value ?? "").trim().slice(0, max);

// Match the import's existing phone normalization and last-duplicate-wins rule.
// Validate every valid-phone source row, including rows later overwritten by a duplicate.
export function prepareContactImport(rows) {
  const invalid = [];
  const seen = new Map();
  const missingNameRows = [];
  rows.forEach((row, i) => {
    try {
      const phone = normalizePhone(row?.phone);
      const name = text(row?.name, 120);
      if (!name) missingNameRows.push(Number.isSafeInteger(row?.sourceRow) && row.sourceRow >= 2 ? row.sourceRow : i + 2);
      seen.set(phone, { phone, name, row: i + 1 });
    } catch (e) {
      invalid.push({ row: i + 1, phone: text(row?.phone, 40), error: e instanceof PhoneError ? e.message : "Invalid row." });
    }
  });
  const list = [...seen.values()];
  return { list, invalid, missingNameRows };
}
