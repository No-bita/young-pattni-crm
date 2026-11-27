import { unzipSync } from "fflate";
import readExcelFile from "read-excel-file/universal";
import { parseCsv, toImportRows, detectPhoneColumn } from "./contactCsv.js";

export const MAX_CONTACT_FILE_BYTES = 5 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 24 * 1024 * 1024;

export async function readContactFile(file) {
  if (file.size > MAX_CONTACT_FILE_BYTES) throw new Error("Use a file smaller than 5 MB.");
  const extension = file.name.split(".").pop().toLowerCase();
  if (extension === "csv") return [{ sheet: "CSV", data: parseCsv(await file.text()) }];
  if (extension !== "xlsx") throw new Error("Choose a .csv or .xlsx file. For older Excel files, save a copy as .xlsx first.");
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let expanded = 0;
    let entries = 0;
    // Check declared expansion sizes before inflating any workbook content.
    unzipSync(bytes, { filter: (entry) => {
      expanded += entry.originalSize;
      entries++;
      if (expanded > MAX_EXPANDED_BYTES || entries > 1000) throw new Error("WORKBOOK_TOO_LARGE");
      return false;
    } });
    const sheets = await readExcelFile(bytes);
    if (!sheets.length) throw new Error("No sheets");
    return sheets;
  } catch (error) {
    if (error.message === "WORKBOOK_TOO_LARGE") throw new Error("This workbook is too large to read safely. Save just the contacts sheet in a new file.");
    throw new Error("Could not read this workbook. Use an unprotected .xlsx file, or save the contacts sheet as CSV.");
  }
}

export function contactSheetRows(sheet) {
  try {
    // Only the first two columns are read; row 1 is ignored.
    const raw = sheet.data.map((row) => [row[0], row[1]]);
    const phoneCol = detectPhoneColumn(raw.map((row) => row.map((value) => (typeof value === "string" ? value : value == null ? "" : String(value)))));
    const table = raw.map((row, rowIndex) => row.map((value, columnIndex) => {
      if (value == null) return "";
      // Bad phone cells become invalid rows, not a whole-file error. Do not round
      // unsafe numbers or stringify a date as a plausible phone number.
      if (rowIndex > 0 && columnIndex === phoneCol && typeof value !== "string" && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) return "[invalid phone cell: use text or a whole number]";
      if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? String(value) : "";
      return typeof value === "string" ? value : "";
    }));
    const parsed = toImportRows(table);
    if (parsed.error) return parsed;
    if (!parsed.rows.length) return { rows: [], error: "No contact rows found on this sheet." };
    if (parsed.rows.length > 5000) return { rows: [], error: "Import at most 5000 rows at a time." };
    return parsed;
  } catch (error) {
    return { rows: [], error: error.message };
  }
}
