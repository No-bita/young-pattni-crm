import { all, nowIso, newId } from "./db.js";
import { listTemplates, describeTemplate, findTemplate } from "../whatsapp/graph.js";

// One INSERT-or-UPDATE of a template definition from Meta into this sender's local copy.
function upsertStatement(env, sender, t, ts) {
  const d = describeTemplate(t);
  return env.DB.prepare(
    `INSERT INTO templates (id, account_id, sender_id, waba_id, meta_template_id, name, language, category, status, body_text, body_param_count, has_header_media, synced_at,
                            header_format, header_param_count, header_text, buttons_json, unsupported_reason, footer_text, content_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(sender_id, name, language) DO UPDATE SET
       meta_template_id = excluded.meta_template_id, category = excluded.category, status = excluded.status,
       body_text = excluded.body_text, body_param_count = excluded.body_param_count,
       has_header_media = excluded.has_header_media, synced_at = excluded.synced_at,
       header_format = excluded.header_format, header_param_count = excluded.header_param_count,
       header_text = excluded.header_text, buttons_json = excluded.buttons_json, unsupported_reason = excluded.unsupported_reason,
       footer_text = excluded.footer_text, content_json = excluded.content_json`,
  ).bind(newId("tpl"), sender.account_id, sender.id, sender.waba_id, t.id ? String(t.id) : null, t.name, t.language,
    t.category || null, String(t.status || "UNKNOWN").toUpperCase(), d.bodyText, d.bodyParamCount, d.hasHeaderMedia ? 1 : 0, ts,
    d.headerFormat, d.headerParamCount, d.headerText || null, JSON.stringify(d.buttons), d.unsupportedReason,
    d.footerText || null, JSON.stringify(d.content));
}

export function parseContent(json) {
  if (!json) return null;
  try {
    const c = JSON.parse(json);
    return c && typeof c === "object" ? c : null;
  } catch {
    return null;
  }
}

// Fetches one named template from the sender's Messaging account and saves it like a synced one.
// Returns the saved row, or null when Meta has no template with that exact name and language.
// Other templates are left untouched (nothing is marked MISSING).
export async function lookupTemplate(env, sender, { name, language }, { timeoutMs = null } = {}) {
  const t = await findTemplate(env, sender, { name, language }, { timeoutMs });
  if (!t) return null;
  await env.DB.batch([upsertStatement(env, sender, t, nowIso())]);
  return env.DB.prepare("SELECT * FROM templates WHERE account_id = ? AND sender_id = ? AND name = ? AND language = ?")
    .bind(sender.account_id, sender.id, name, language).first();
}

// Replaces the local copy of a sender's templates with what Meta reports for its WABA.
// Rows are upserted, never deleted: a template missing from Meta is marked status 'MISSING'.
export async function syncTemplates(env, sender) {
  const remote = await listTemplates(env, sender);
  const ts = nowIso();
  const stmts = [];
  const seen = new Set();
  for (const t of remote) {
    if (!t?.name || !t?.language) continue;
    seen.add(`${t.name}\u0000${t.language}`);
    stmts.push(upsertStatement(env, sender, t, ts));
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

// Why this app cannot send a template, or null when it can.
// Rows synced before migration 0002 have header_format NULL and keep the old rule until re-synced.
export function unsupportedReason(t) {
  if (!t) return "Template not found.";
  if (t.header_format === null || t.header_format === undefined) {
    return t.has_header_media ? "Refresh templates from Meta to check this template's media header." : null;
  }
  return t.unsupported_reason || null;
}

export function isUsable(t) {
  return Boolean(t) && t.status === "APPROVED" && !unsupportedReason(t);
}

export function needsImage(t) {
  return Boolean(t) && t.header_format === "IMAGE";
}

function parseButtons(json) {
  try {
    const b = JSON.parse(json || "[]");
    return Array.isArray(b) ? b : [];
  } catch {
    return [];
  }
}

export function presentTemplate(t) {
  const reason = unsupportedReason(t);
  return {
    id: t.id,
    name: t.name,
    language: t.language,
    category: t.category,
    status: t.status,
    bodyText: t.body_text,
    paramCount: t.body_param_count,
    headerFormat: t.header_format ?? (t.has_header_media ? "MEDIA" : "NONE"),
    headerText: t.header_text || "",
    footerText: t.footer_text || "",
    hasHeaderMedia: Boolean(t.has_header_media),
    needsImage: needsImage(t),
    buttons: parseButtons(t.buttons_json).map((b) => ({ type: b.type, text: b.text, url: b.url ?? null, phoneNumber: b.phone_number ?? null })),
    usable: isUsable(t),
    unsupportedReason: t.status !== "APPROVED" ? `Not approved by Meta (status ${t.status}).` : reason,
    syncedAt: t.synced_at,
  };
    }
