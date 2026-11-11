// The single gate every outbound WhatsApp message passes through
// (campaign sends, scheduled campaign sends, inbox replies, sender test sends).
// Order of checks: contact belongs to the account -> not suppressed -> sender is the
// account's active sender -> (text only) 24-hour window open -> send with that sender only.
import { one, run, newId, nowIso } from "./db.js";
import { sendTemplate, sendText, GraphError } from "../whatsapp/graph.js";

export const WINDOW_MS = 24 * 60 * 60 * 1000;

export async function getActiveSender(db, accountId) {
  return one(db, "SELECT * FROM senders WHERE account_id = ? AND status = 'active'", accountId);
}

export function isWindowOpen(lastInboundAt, now = Date.now()) {
  if (!lastInboundAt) return false;
  const t = Date.parse(lastInboundAt);
  return Number.isFinite(t) && now - t < WINDOW_MS;
}

export function renderBody(bodyText, params) {
  return String(bodyText || "").replace(/\{\{\s*(\d+)\s*\}\}/g, (m, n) => {
    const v = params[Number(n) - 1];
    return v === undefined ? m : String(v);
  });
}

/**
 * @returns {Promise<{ok: true, messageId: string, wamid: string} | {ok: false, code: string, error: string, messageId?: string}>}
 */
export async function sendToContact(env, {
  accountId,
  contactId,
  kind,                 // 'template' | 'text'
  template,             // { name, language, bodyParams, bodyText, headerImageId?, mediaAssetId? }
  text,
  campaignId = null,
  senderId = null,      // campaigns pin the sender chosen at launch
}) {
  const db = env.DB;
  const contact = await one(db, "SELECT * FROM contacts WHERE id = ? AND account_id = ?", contactId, accountId);
  if (!contact) return { ok: false, code: "CONTACT_NOT_FOUND", error: "Contact not found." };
  if (contact.suppressed) return { ok: false, code: "SUPPRESSED", error: "This contact has opted out of messages." };

  const sender = await getActiveSender(db, accountId);
  if (!sender) return { ok: false, code: "NO_ACTIVE_SENDER", error: "No active WhatsApp number." };
  if (senderId && sender.id !== senderId) {
    return { ok: false, code: "SENDER_CHANGED", error: "The WhatsApp number used by this campaign is no longer active." };
  }

  if (kind === "text") {
    if (!text || !String(text).trim()) return { ok: false, code: "EMPTY", error: "Message is empty." };
    if (!isWindowOpen(contact.last_inbound_at)) {
      return { ok: false, code: "WINDOW_CLOSED", error: "The contact has not messaged in the last 24 hours, so only a template can be sent." };
    }
  } else if (kind !== "template" || !template?.name || !template?.language) {
    return { ok: false, code: "BAD_REQUEST", error: "Template is required." };
  }

  const body = kind === "text" ? String(text) : renderBody(template.bodyText, template.bodyParams || []);
  const messageId = newId("msg");
  const ts = nowIso();
  // Record the attempt before calling Meta, so a crash never leaves a send unrecorded.
  await run(
    db,
    `INSERT INTO messages (id, account_id, contact_id, sender_id, direction, kind, body, template_name, campaign_id, media_asset_id, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'outbound', ?, ?, ?, ?, ?, 'sending', ?, ?)`,
    messageId, accountId, contactId, sender.id, kind, body, kind === "template" ? template.name : null, campaignId,
    kind === "template" ? (template.mediaAssetId || null) : null, ts, ts,
  );

  try {
    const wamid = kind === "text"
      ? await sendText(env, sender, { to: contact.phone_e164, text: body })
      : await sendTemplate(env, sender, {
        to: contact.phone_e164,
        name: template.name,
        language: template.language,
        bodyParams: template.bodyParams || [],
        headerImageId: template.headerImageId || null,
      });
    await run(
      db,
      "UPDATE messages SET wamid = ?, status = 'sent', updated_at = ? WHERE id = ? AND account_id = ?",
      wamid, nowIso(), messageId, accountId,
    );
    await run(db, "UPDATE contacts SET last_message_at = ?, updated_at = ? WHERE id = ? AND account_id = ?", nowIso(), nowIso(), contactId, accountId);
    return { ok: true, messageId, wamid };
  } catch (err) {
    const error = err instanceof GraphError ? err.message : `Send failed: ${err?.message || "unknown error"}`;
    await run(
      db,
      "UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND account_id = ?",
      error, nowIso(), messageId, accountId,
    );
    return { ok: false, code: "SEND_FAILED", error, messageId };
  }
}
