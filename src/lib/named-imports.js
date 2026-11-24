import { all, one, run, newId, nowIso } from "./db.js";

export function presentImport(row) {
  return { id: row.id, name: row.name, filename: row.filename, status: row.status,
    sourceRows: row.source_rows, created: row.created_count, updated: row.updated_count,
    unchanged: row.unchanged_count, duplicatesInFile: row.duplicates,
    invalid: JSON.parse(row.invalid_json), error: row.error, createdAt: row.created_at };
}
export async function importFingerprint(value) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value)));
  return [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
}

// Each contact chunk, its membership, and progress counts commit together.
// New contact ids are generated first so outcome classification stays correct even
// if another import already inserted the phone. Never reset suppression.
export async function writeNamedImport(db, batch, list) {
  for (let i = 0; i < list.length; i += 50) {
    const stmts = [];
    for (const row of list.slice(i, i + 50)) {
      const cid = newId("cnt");
      stmts.push(db.prepare("INSERT INTO contacts(id,account_id,phone_e164,name,created_at,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,phone_e164) DO NOTHING")
        .bind(cid, batch.account_id, row.phone, row.name, batch.created_at, batch.created_at));
      stmts.push(db.prepare(`INSERT INTO contact_import_members(import_id,account_id,contact_id,outcome,source_row)
        SELECT ?,?,id,CASE WHEN id=? THEN 'created' WHEN name<>? THEN 'updated' ELSE 'unchanged' END,?
        FROM contacts WHERE account_id=? AND phone_e164=?`)
        .bind(batch.id, batch.account_id, cid, row.name, row.sourceRow || row.row + 1, batch.account_id, row.phone));
      if (row.name) stmts.push(db.prepare("UPDATE contacts SET name=?,updated_at=? WHERE account_id=? AND phone_e164=? AND name<>?")
        .bind(row.name, nowIso(), batch.account_id, row.phone, row.name));
    }
    stmts.push(db.prepare(`UPDATE contact_imports SET
      created_count=(SELECT COUNT(*) FROM contact_import_members WHERE import_id=? AND outcome='created'),
      updated_count=(SELECT COUNT(*) FROM contact_import_members WHERE import_id=? AND outcome='updated'),
      unchanged_count=(SELECT COUNT(*) FROM contact_import_members WHERE import_id=? AND outcome='unchanged'),updated_at=? WHERE id=? AND account_id=?`)
      .bind(batch.id, batch.id, batch.id, nowIso(), batch.id, batch.account_id));
    await db.batch(stmts);
  }
  await run(db, "UPDATE contact_imports SET status='completed',updated_at=? WHERE id=? AND account_id=?", nowIso(), batch.id, batch.account_id);
}
