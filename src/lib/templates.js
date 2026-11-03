import { all, nowIso, newId } from "./db.js";
import { listTemplates, describeTemplate } from "../whatsapp/graph.js";

// Replaces the local copy of a sender's templates with what Meta reports for its WABA.
// Rows are upserted, never deleted: a template missing from Meta is marked status 'MISSING'.
export async function syncTemplates(env, sender) {
  const remote = await listTemplates(env, sender);
  const ts = nowIso();
  const stmts = [];
  const seen = new Set();
  for (const t of remote) {
    if (!t?.name || !t?.language) continue;
    const d = describeTemplate(t);
    seen.add(`${t.name}\u0000${t.language}`);
    stmts.push(env.DB.prepare(
      `INSERT INTO templates (id, account_id, sender_id, waba_id, meta_template_id, name, language, category, status, body_text, body_param_count, has_header_media, synced_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(sender_id, name, language) DO UPDATE SET
         meta_template_id = excluded.meta_template_id, category = excluded.category, status = excluded.status,
         body_text = excluded.body_text, body_param_count = excluded.body_param_count,
         has_header_media = excluded.has_header_media, synced_at = excluded.synced_at`,
    ).bind(newId("tpl"), sender.account_id, sender.id, sender.waba_id, t.id ? String(t.id) : null, t.name, t.language,
      t.category || null, String(t.status || "UNKNOWN").toUpperCase(), d.bodyText, d.bodyParamCount, d.hasHeaderMedia ? 1 : 0, ts));
  }
  const existing = await all(env.DB, "SELECT id, name, language FROM templates WHERE sender_id = ? AND account_id = ?", sender.id, sender.account_id);
  for (const e of existing) {
    if (!seen.has(`${e.name}\u0000${e.language}`)) {
      stmts.push(env.DB.prepare("UPDATE templates SET status = 'MISSING', synced_at = ? WHERE id = ? AND account_id = ?").bind(ts, e.id, sender.account_id));
    }
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return remote.length;
}

// A template is usable when it is APPROVED and v1 can fill it (text body variables only, no media header).
export function isUsable(t) {
  return t && t.status === "APPROVED" && !t.has_header_media;
}

export function presentTemplate(t) {
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    bodyText: t.body_text,
    paramCount: t.body_param_count,
    hasHeaderMedia: Boolean(t.has_header_media),
    usable: isUsable(t),
    syncedAt: t.synced_at,
  };
}
