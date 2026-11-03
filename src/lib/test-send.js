// Test message from a not-yet-active number, used only by the Number screen's test step.
// It still respects suppression, and records the message against the number that sent it.
import { one, run, newId, nowIso } from "./db.js";
import { sendTemplate, GraphError } from "../whatsapp/graph.js";

export async function sendToContactWithSender(env, { accountId, sender, phone, template }) {
  const db = env.DB;
  const ts = nowIso();
  await run(
    db,
    "INSERT INTO contacts (id, account_id, phone_e164, name, created_at, updated_at) VALUES (?, ?, ?, '', ?, ?) ON CONFLICT(account_id, phone_e164) DO NOTHING",
    newId("cnt"), accountId, phone, ts, ts,
  );
  const contact = await one(db, "SELECT * FROM contacts WHERE account_id = ? AND phone_e164 = ?", accountId, phone);
  if (contact.suppressed) return { ok: false, code: "SUPPRESSED", error: "This number has opted out of messages." };

  const messageId = newId("msg");
  await run(
    db,
    `INSERT INTO messages (id, account_id, contact_id, sender_id, direction, kind, body, template_name, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'outbound', 'template', ?, ?, 'sending', ?, ?)`,
    messageId, accountId, contact.id, sender.id, template.body_text, template.name, ts, ts,
  );
  try {
    const wamid = await sendTemplate(env, sender, { to: phone, name: template.name, language: template.language, bodyParams: [] });
    await run(db, "UPDATE messages SET wamid = ?, status = 'sent', updated_at = ? WHERE id = ? AND account_id = ?", wamid, nowIso(), messageId, accountId);
    await run(db, "UPDATE contacts SET last_message_at = ? WHERE id = ? AND account_id = ?", nowIso(), contact.id, accountId);
    return { ok: true, messageId };
  } catch (e) {
    const error = e instanceof GraphError ? e.message : `Send failed: ${e.message}`;
    await run(db, "UPDATE messages SET status = 'failed', error = ?, updated_at = ? WHERE id = ? AND account_id = ?", error, nowIso(), messageId, accountId);
    return { ok: false, code: "SEND_FAILED", error };
  }
}
