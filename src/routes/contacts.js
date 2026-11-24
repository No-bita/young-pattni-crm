import { Hono } from "hono";
import { all, one, run, newId, nowIso } from "../lib/db.js";
import { normalizePhone, PhoneError, formatPhone } from "../lib/phone.js";
import { accountId, readJson, str, intEnv } from "../lib/http.js";

import { previewContactImport, resolveImportNames } from "../lib/import-preview.js";
import { prepareContactImport, missingNamesError } from "../lib/contact-import.js";

import { presentImport, importFingerprint, writeNamedImport } from "../lib/named-imports.js";

const contacts = new Hono();
const MAX_IMPORT_ROWS = 5000;

export function presentContact(r) {
  return {
    id: r.id,
    name: r.name,
    phone: formatPhone(r.phone_e164),
    suppressed: Boolean(r.suppressed),
    suppressedAt: r.suppressed_at,
    lastMessageAt: r.last_message_at,
    createdAt: r.created_at,
  };
}

function filterSql(q, filter, importId = "", batchName = "") {
  const where = ["account_id = ?"];
  const args = [];
  if (filter === "suppressed") where.push("suppressed = 1");
  if (filter === "active") where.push("suppressed = 0");
  if (q) {
    const digits = q.replace(/\D/g, "");
    where.push(digits ? "(LOWER(name) LIKE ? OR phone_e164 LIKE ?)" : "LOWER(name) LIKE ?");
    const like = `%${q.toLowerCase().replace(/[%_]/g, "")}%`;
    args.push(like);
    if (digits) args.push(`%${digits}%`);
  }
  if (importId || batchName) {
    where.push(`EXISTS (SELECT 1 FROM contact_import_members im JOIN contact_imports bi ON bi.id=im.import_id AND bi.account_id=im.account_id WHERE im.account_id=contacts.account_id AND im.contact_id=contacts.id${importId ? " AND im.import_id=?" : ""}${batchName ? " AND instr(lower(bi.name),lower(?))>0" : ""})`);
    if (importId) args.push(importId);
    if (batchName) args.push(batchName);
  }
  return { where: where.join(" AND "), args };
}

contacts.get("/", async (c) => {
  const q = str(c.req.query("q"), 100);
  const filter = c.req.query("filter") || "all";
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const { where, args } = filterSql(q, filter, str(c.req.query("importId"), 80), str(c.req.query("batchName"), 120));
  const id = accountId(c);
  const rows = await all(c.env.DB, `SELECT * FROM contacts WHERE ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, id, ...args, limit, offset);
  const total = await one(c.env.DB, `SELECT COUNT(*) AS n FROM contacts WHERE ${where}`, id, ...args);
  return c.json({ contacts: rows.map(presentContact), total: total?.n ?? 0 });
});

// Ids of every non-suppressed contact matching a search, for an explicit "select all" in campaign setup.
contacts.get("/ids", async (c) => {
  const q = str(c.req.query("q"), 100);
  const cap = intEnv(c.env, "MAX_CAMPAIGN_AUDIENCE", 1000);
  const { where, args } = filterSql(q, "active", str(c.req.query("importId"), 80), str(c.req.query("batchName"), 120));
  const rows = await all(c.env.DB, `SELECT id FROM contacts WHERE ${where} ORDER BY created_at DESC, id LIMIT ?`, accountId(c), ...args, cap + 1);
  if (c.req.query("importId") && rows.length > cap) return c.json({ error: `This batch has more than ${cap} eligible contacts. Select a smaller audience. Nothing was selected.`, code: "AUDIENCE_TOO_LARGE", cap }, 400);
  return c.json({ ids: rows.slice(0, cap).map((r) => r.id), truncated: rows.length > cap, cap });
});

contacts.post("/", async (c) => {
  const body = await readJson(c);
  let phone;
  try {
    phone = normalizePhone(body.phone);
  } catch (e) {
    if (e instanceof PhoneError) return c.json({ error: e.message }, 400);
    throw e;
  }
  const id = accountId(c);
  const existing = await one(c.env.DB, "SELECT id FROM contacts WHERE account_id = ? AND phone_e164 = ?", id, phone);
  if (existing) return c.json({ error: "A contact with this number already exists.", contactId: existing.id }, 409);
  const contactId = newId("cnt");
  const ts = nowIso();
  await run(c.env.DB, "INSERT INTO contacts (id, account_id, phone_e164, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)", contactId, id, phone, str(body.name, 120), ts, ts);
  return c.json({ contact: presentContact(await one(c.env.DB, "SELECT * FROM contacts WHERE id = ? AND account_id = ?", contactId, id)) }, 201);
});

contacts.patch("/:id", async (c) => {
  const body = await readJson(c);
  const id = accountId(c);
  const changes = await run(c.env.DB, "UPDATE contacts SET name = ?, updated_at = ? WHERE id = ? AND account_id = ?", str(body.name, 120), nowIso(), c.req.param("id"), id);
  if (!changes) return c.json({ error: "Contact not found." }, 404);
  return c.json({ contact: presentContact(await one(c.env.DB, "SELECT * FROM contacts WHERE id = ? AND account_id = ?", c.req.param("id"), id)) });
});

// Rows are parsed from CSV in the browser and sent as JSON: [{ phone, name }].
// Existing contacts keep their suppression; a non-empty name updates the stored name.
contacts.post("/import/preview", async (c) => {
  const body = await readJson(c);
  if (!Array.isArray(body.rows) || !body.rows.length || body.rows.length > MAX_IMPORT_ROWS) return c.json({error:"Choose 1 to 5000 contact rows."},400);
  const preview = await previewContactImport(c.env.DB, accountId(c), body.rows);
  if (preview.missingNameRows.length) return c.json({error:missingNamesError(preview.missingNameRows),code:"MISSING_IMPORT_NAMES"},400);
  return c.json({ contacts: preview.list, conflicts: preview.conflicts, invalid: preview.invalid, duplicatesInFile: preview.duplicatesInFile });
});

contacts.post("/import", async (c) => {
  const body = await readJson(c);
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || rows.length === 0) return c.json({ error: "No rows to import." }, 400);
  if (rows.length > MAX_IMPORT_ROWS) return c.json({ error: `Import at most ${MAX_IMPORT_ROWS} rows at a time.` }, 400);

  const id = accountId(c);
  const preview = await previewContactImport(c.env.DB, id, rows);
  const {list,invalid,missingNameRows}=preview;
  if (missingNameRows.length) return c.json({ error: missingNamesError(missingNameRows), code: "MISSING_IMPORT_NAMES", missingNameCount: missingNameRows.length, missingNameRows: missingNameRows.slice(0, 10), moreMissingNameRows: Math.max(0, missingNameRows.length - 10) }, 400);

  const name = str(body.importName, 120);
  if (!name) return c.json({ error: "Name this import before importing.", code: "IMPORT_NAME_REQUIRED" }, 400);
  const filename = str(body.filename, 255);
  const requestKey = str(body.requestId, 100) || newId("req");
  const fingerprint = await importFingerprint({ name, filename, sheetName:str(body.sheetName,120), rows, nameChoices: body.nameChoices || {} });
  const previous = await one(c.env.DB,"SELECT * FROM contact_imports WHERE account_id=? AND request_key=?",id,requestKey);
  if(previous){
    if(previous.payload_hash !== fingerprint) return c.json({error:"This request was used for different import data.",code:"IMPORT_REQUEST_CONFLICT"},409);
    if(previous.status === "completed") return c.json({...presentImport(previous),replayed:true});
    return c.json({error:"This import is already started. Review its saved progress.",code:"IMPORT_ALREADY_STARTED",import:presentImport(previous)},409);
  }
  const unresolved = resolveImportNames(preview, body.nameChoices);
  if (unresolved.length) return c.json({error:"Choose a name for every conflict. If contacts changed, review the refreshed choices.",code:"IMPORT_NAME_CONFLICTS",phones:unresolved},409);
  const batchId = newId("imp");
  const ts = nowIso();
  await run(c.env.DB, `INSERT INTO contact_imports(id,account_id,name,filename,request_key,payload_hash,status,source_rows,duplicates,invalid_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,'importing',?,?,?,?,?) ON CONFLICT(account_id,request_key) DO NOTHING`,
    batchId,id,name,filename,requestKey,fingerprint,rows.length,rows.length-invalid.length-list.length,JSON.stringify(invalid),ts,ts);
  let batch = await one(c.env.DB, "SELECT * FROM contact_imports WHERE account_id=? AND request_key=?", id, requestKey);
  if (batch.payload_hash !== fingerprint) return c.json({ error: "This import request was already used for a different file or name.", code: "IMPORT_REQUEST_CONFLICT" }, 409);
  if (batch.id !== batchId) {
    if (batch.status === "completed") return c.json({ ...presentImport(batch), replayed: true });
    return c.json({ error: "This import is already started. Check its saved progress before starting another import.", code: "IMPORT_ALREADY_STARTED", import: presentImport(batch) }, 409);
  }
  try {
    await run(c.env.DB,"UPDATE contact_imports SET name_choices_json=? WHERE id=? AND account_id=?",JSON.stringify(list.map(row=>({phone:row.phone,name:row.name,sourceRows:row.sourceRows}))),batch.id,id);
    await run(c.env.DB,"UPDATE contact_imports SET sheet_name=? WHERE id=? AND account_id=?",str(body.sheetName,120),batch.id,id);
    await writeNamedImport(c.env.DB, batch, list);
  } catch {
    await run(c.env.DB, `UPDATE contact_imports SET status=CASE WHEN created_count+updated_count+unchanged_count>0 THEN 'partial' ELSE 'failed' END,error=?,updated_at=? WHERE id=? AND account_id=?`,
      "Import stopped. Some earlier rows may already be saved. Review this batch before retrying.",nowIso(),batch.id,id);
    batch = await one(c.env.DB, "SELECT * FROM contact_imports WHERE id=? AND account_id=?", batch.id,id);
    return c.json({ error: batch.error, code: "IMPORT_STOPPED", import: presentImport(batch) }, 500);
  }
  batch = await one(c.env.DB, "SELECT * FROM contact_imports WHERE id=? AND account_id=?", batch.id,id);
  return c.json(presentImport(batch));
});

contacts.get("/imports", async (c) => {
  const q = str(c.req.query("q"), 120);
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 100);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const rows = await all(c.env.DB, "SELECT * FROM contact_imports WHERE account_id=? AND instr(lower(name),lower(?))>0 ORDER BY created_at DESC,id LIMIT ? OFFSET ?", accountId(c), q, limit,offset);
  const total = await one(c.env.DB, "SELECT COUNT(*) AS n FROM contact_imports WHERE account_id=? AND instr(lower(name),lower(?))>0", accountId(c),q);
  return c.json({ imports: rows.map(presentImport), total: total.n });
});
contacts.get("/imports/:importId", async (c) => {
  const row = await one(c.env.DB, "SELECT * FROM contact_imports WHERE id=? AND account_id=?", c.req.param("importId"),accountId(c));
  if (!row) return c.json({ error: "Import not found." },404);
  return c.json({ import: presentImport(row) });
});

export default contacts;
