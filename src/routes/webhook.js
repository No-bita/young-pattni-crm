// Meta WhatsApp webhook. POST bodies are processed only after the X-Hub-Signature-256 check passes.
// Events are routed strictly by metadata.phone_number_id -> senders row -> that sender's account.
// Unknown phone number ids are logged and ignored (nothing is written).
import { Hono } from "hono";
import { one, run, newId, nowIso } from "../lib/db.js";
import { isValidSignature } from "../whatsapp/signature.js";
import { parseWebhook } from "../whatsapp/parse.js";
import { timingSafeEqualStr } from "../lib/password.js";
import { recordInboundMedia } from "../lib/inbound-media.js";

const webhook = new Hono();

const RANK = { sending: 0, sent: 1, delivered: 2, read: 3 };
const RECIPIENT_FOR = { sent: "sent", delivered: "delivered", read: "read", failed: "failed" };

webhook.get("/", (c) => {
  const mode = c.req.query("hub.mode");
  const token = c.req.query("hub.verify_token");
  const challenge = c.req.query("hub.challenge");
  const expected = c.env.META_VERIFY_TOKEN;
  if (mode === "subscribe" && expected && token && timingSafeEqualStr(token, expected)) {
    return c.text(String(challenge ?? ""), 200);
  }
  return c.text("Forbidden", 403);
});

async function senderFor(db, phoneNumberId, cache) {
  if (!phoneNumberId) return null;
  if (!cache.has(phoneNumberId)) {
    cache.set(phoneNumberId, await one(db, "SELECT id, account_id FROM senders WHERE phone_number_id = ?", phoneNumberId));
  }
  return cache.get(phoneNumberId);
}

async function applyStatus(db, sender, ev) {
  const msg = await one(db, "SELECT id, status FROM messages WHERE account_id = ? AND sender_id = ? AND wamid = ?", sender.account_id, sender.id, ev.wamid);
  if (!msg) return; // not one of this account's messages: write nothing
  let next = null;
  if (ev.status === "failed") {
    if (msg.status === "sending" || msg.status === "sent") next = "failed";
  } else if (ev.status in RANK) {
    if (msg.status !== "failed" && RANK[ev.status] > (RANK[msg.status] ?? -1)) next = ev.status;
  }
  if (!next) return;
  await run(db, "UPDATE messages SET status = ?, error = ?, updated_at = ? WHERE id = ? AND account_id = ?", next, next === "failed" ? ev.error : null, nowIso(), msg.id, sender.account_id);
  await run(
    db,
    "UPDATE campaign_recipients SET status = ?, error = COALESCE(?, error), updated_at = ? WHERE account_id = ? AND message_id = ? AND status IN ('sent', 'delivered', 'read')",
    RECIPIENT_FOR[next], next === "failed" ? ev.error : null, nowIso(), sender.account_id, msg.id,
  );
}

async function contactFor(db, accountId, phone, name = "") {
  const ts = nowIso();
  await run(
    db,
    "INSERT INTO contacts (id, account_id, phone_e164, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, phone_e164) DO NOTHING",
    newId("cnt"), accountId, phone, name, ts, ts,
  );
  return one(db, "SELECT * FROM contacts WHERE account_id = ? AND phone_e164 = ?", accountId, phone);
}

async function applyInbound(env, sender, ev) {
  const db = env.DB;
  if (!/^\d{8,15}$/.test(ev.from)) return;
  const contact = await contactFor(db, sender.account_id, ev.from, ev.profileName);
  const at = ev.timestamp || nowIso();
  const messageId = newId("msg");
  const inserted = await run(
    db,
    `INSERT INTO messages (id, account_id, contact_id, sender_id, direction, kind, body, wamid, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'inbound', 'inbound', ?, ?, 'received', ?, ?) ON CONFLICT(sender_id, wamid) WHERE wamid IS NOT NULL DO NOTHING`,
    messageId, sender.account_id, contact.id, sender.id, ev.text, ev.wamid, at, nowIso(),
  );
  if (!inserted) return; // duplicate delivery from Meta's retries
  if (ev.media) await recordInboundMedia(env, sender, messageId, ev.media, at);
  await run(
    db,
    `UPDATE contacts SET last_inbound_at = MAX(COALESCE(last_inbound_at, ''), ?), last_message_at = MAX(COALESCE(last_message_at, ''), ?),
            name = CASE WHEN name = '' THEN ? ELSE name END, updated_at = ?
      WHERE id = ? AND account_id = ?`,
    at, at, ev.profileName || "", nowIso(), contact.id, sender.account_id,
  );
}

async function applyPreference(db, sender, ev) {
  if (!ev.waId || !/^\d{8,15}$/.test(ev.waId)) {
    console.warn("[webhook] user_preferences event without a usable wa_id; cannot match a contact");
    return;
  }
  if (ev.value === "stop") {
    const contact = await contactFor(db, sender.account_id, ev.waId);
    await run(db, "UPDATE contacts SET suppressed = 1, suppressed_at = ?, suppressed_source = 'meta_stop', updated_at = ? WHERE id = ? AND account_id = ? AND suppressed = 0", nowIso(), nowIso(), contact.id, sender.account_id);
  } else if (ev.value === "resume") {
    await run(db, "UPDATE contacts SET suppressed = 0, suppressed_at = NULL, suppressed_source = NULL, updated_at = ? WHERE account_id = ? AND phone_e164 = ? AND suppressed = 1", nowIso(), sender.account_id, ev.waId);
  }
}

webhook.post("/", async (c) => {
  const raw = await c.req.arrayBuffer();
  const ok = await isValidSignature(c.env.META_APP_SECRET, raw, c.req.header("X-Hub-Signature-256"));
  if (!ok) {
    console.warn("[webhook] rejected: missing or invalid signature");
    return c.text("Invalid signature", 401);
  }
  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.text("Bad JSON", 400);
  }

  const events = parseWebhook(body);
  const cache = new Map();
  const db = c.env.DB;
  const route = async (ev) => {
    const sender = await senderFor(db, ev.phoneNumberId, cache);
    if (!sender) console.warn(`[webhook] ignored event for unknown phone_number_id ${ev.phoneNumberId}`);
    return sender;
  };

  // A thrown error returns 500, so Meta retries; every write above is idempotent.
  for (const ev of events.messages) {
    const s = await route(ev);
    if (s) await applyInbound(c.env, s, ev);
  }
  for (const ev of events.statuses) {
    const s = await route(ev);
    if (s) await applyStatus(db, s, ev);
  }
  for (const ev of events.preferences) {
    const s = await route(ev);
    if (s) await applyPreference(db, s, ev);
  }
  return c.text("ok", 200);
});

export default webhook;
