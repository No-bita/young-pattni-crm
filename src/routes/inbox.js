import { Hono } from "hono";
import { all, one } from "../lib/db.js";
import { accountId, readJson } from "../lib/http.js";
import { sendToContact, isWindowOpen } from "../lib/send.js";
import { formatPhone } from "../lib/phone.js";

const inbox = new Hono();

inbox.get("/", async (c) => {
  const rows = await all(
    c.env.DB,
    `SELECT ct.*, (SELECT m.body FROM messages m WHERE m.account_id = ct.account_id AND m.contact_id = ct.id ORDER BY m.created_at DESC LIMIT 1) AS last_body,
            (SELECT m.direction FROM messages m WHERE m.account_id = ct.account_id AND m.contact_id = ct.id ORDER BY m.created_at DESC LIMIT 1) AS last_direction,
            (SELECT m.status FROM messages m WHERE m.account_id = ct.account_id AND m.contact_id = ct.id ORDER BY m.created_at DESC LIMIT 1) AS last_status
       FROM contacts ct WHERE ct.account_id = ? AND ct.last_message_at IS NOT NULL
      ORDER BY ct.last_message_at DESC LIMIT 200`,
    accountId(c),
  );
  return c.json({
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
    `SELECT m.*, s.display_number FROM messages m JOIN senders s ON s.id = m.sender_id AND s.account_id = m.account_id
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
