import { presentInboundMedia } from "../lib/inbound-media.js";
import { Hono } from "hono";
import { all, one } from "../lib/db.js";
import { INBOX_FILTERS } from "../lib/inbox-filters.js";
import { accountId, readJson, str } from "../lib/http.js";
import { sendToContact, isWindowOpen } from "../lib/send.js";
import { formatPhone } from "../lib/phone.js";

const inbox = new Hono();

inbox.get("/", async (c) => {
  const filter = c.req.query("status") || "all";
  if (!INBOX_FILTERS.includes(filter)) return c.json({ error: "Unknown Inbox status filter." },400);
  const q = str(c.req.query("q"),100).toLowerCase();
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50,1),200);
  const offset = Math.max(Number(c.req.query("offset")) || 0,0);
  const latest = `WITH latest AS (SELECT ct.*,
    (SELECT m.body FROM messages m WHERE m.account_id=ct.account_id AND m.contact_id=ct.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_body,
    (SELECT m.direction FROM messages m WHERE m.account_id=ct.account_id AND m.contact_id=ct.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_direction,
    (SELECT m.status FROM messages m WHERE m.account_id=ct.account_id AND m.contact_id=ct.id ORDER BY m.created_at DESC,m.id DESC LIMIT 1) AS last_status
    FROM contacts ct WHERE ct.account_id=? AND ct.last_message_at IS NOT NULL AND (instr(lower(ct.name),?)>0 OR (?<>'' AND instr(ct.phone_e164,?)>0)))`;
  const digits = q.replace(/[^0-9]/g, "");
  const args = [accountId(c),q,digits,digits];
  const conditions = { all: "1=1", opted_out: "suppressed<>0", replied: "last_direction='inbound'", sent: "last_direction='outbound' AND last_status='sent'", delivered: "last_direction='outbound' AND last_status='delivered'", read: "last_direction='outbound' AND last_status='read'", failed: "last_direction='outbound' AND last_status='failed'" };
  const countColumns = INBOX_FILTERS.map((f) => `COALESCE(SUM(CASE WHEN ${conditions[f]} THEN 1 ELSE 0 END),0) AS "${f}"`).join(",");
  const counts = await one(c.env.DB, `${latest} SELECT ${countColumns} FROM latest`, ...args);
  const rows = await all(c.env.DB, `${latest} SELECT * FROM latest WHERE ${conditions[filter]} ORDER BY last_message_at DESC,id LIMIT ? OFFSET ?`, ...args,limit,offset);
  return c.json({ counts, total: counts[filter], limit, offset,
    conversations: rows.map((r) => ({
      contactId: r.id, name: r.name, phone: formatPhone(r.phone_e164), suppressed: Boolean(r.suppressed),
      lastMessageAt: r.last_message_at, lastBody: r.last_body, lastDirection: r.last_direction, lastStatus: r.last_status,
      windowOpen: isWindowOpen(r.last_inbound_at),
    })),
  });
});

inbox.get("/:contactId", async (c) => {
  const contact = await one(c.env.DB, "SELECT * FROM contacts WHERE id = ? AND account_id = ?", c.req.param("contactId"), accountId(c));
  if (!contact) return c.json({ error: "Contact not found." }, 404);
  const msgs = await all(
    c.env.DB,
    `SELECT m.*, s.display_number,
            im.id AS im_id, im.kind AS im_kind, im.voice AS im_voice, im.status AS im_status, im.stored_mime_type AS im_mime,
            im.byte_size AS im_size, im.error AS im_error
       FROM messages m JOIN senders s ON s.id = m.sender_id AND s.account_id = m.account_id
       LEFT JOIN inbound_media im ON im.message_id = m.id AND im.account_id = m.account_id
      WHERE m.account_id = ? AND m.contact_id = ? ORDER BY m.created_at ASC LIMIT 500`,
    accountId(c), contact.id,
  );
  // An outbound message counts as "replied" once an inbound message arrives after it.
  const lastInbound = msgs.filter((m) => m.direction === "inbound").map((m) => m.created_at).sort().pop() || null;
  return c.json({
    contact: {
      id: contact.id, name: contact.name, phone: formatPhone(contact.phone_e164), suppressed: Boolean(contact.suppressed),
      windowOpen: isWindowOpen(contact.last_inbound_at), lastInboundAt: contact.last_inbound_at,
    },
    messages: msgs.map((m) => ({
      id: m.id, direction: m.direction, kind: m.kind, body: m.body, templateName: m.template_name,
      status: m.status, error: m.error, createdAt: m.created_at, senderNumber: m.display_number,
      media: m.media_asset_id ? { id: m.media_asset_id, kind: "image", previewUrl: `/api/media/${m.media_asset_id}/preview` } : null,
      inboundMedia: m.im_id ? presentInboundMedia({
        id: m.im_id, kind: m.im_kind, voice: m.im_voice, status: m.im_status, stored_mime_type: m.im_mime, byte_size: m.im_size, error: m.im_error,
      }) : null,
      replied: m.direction === "outbound" && m.status !== "failed" && Boolean(lastInbound && lastInbound > m.created_at),
    })),
  });
});

inbox.post("/:contactId/reply", async (c) => {
  const body = await readJson(c);
  const text = String(body.text ?? "").slice(0, 4096);
  const res = await sendToContact(c.env, { accountId: accountId(c), contactId: c.req.param("contactId"), kind: "text", text });
  if (!res.ok) {
    const status = res.code === "CONTACT_NOT_FOUND" ? 404 : res.code === "SEND_FAILED" ? 502 : 409;
    return c.json({ error: res.error, code: res.code }, status);
  }
  return c.json({ ok: true, messageId: res.messageId });
});

export default inbox;
