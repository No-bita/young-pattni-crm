// WhatsApp numbers. A switch is deliberate: add (inactive) -> test -> activate. The old number is kept.
import { Hono } from "hono";
import { all, one, run, newId, nowIso } from "../lib/db.js";
import { accountId, readJson, str } from "../lib/http.js";
import { getPhoneNumber, listWabaPhoneNumbers, GraphError } from "../whatsapp/graph.js";
import { syncTemplates, isUsable } from "../lib/templates.js";
import { normalizePhone, PhoneError } from "../lib/phone.js";
import { sendToContactWithSender } from "../lib/test-send.js";

const senders = new Hono();

function present(s, stats = {}) {
  return {
    id: s.id,
    tokenRef: s.token_ref,
    phoneNumberId: s.phone_number_id,
    wabaId: s.waba_id,
    displayNumber: s.display_number,
    verifiedName: s.verified_name,
    status: s.status,
    testedAt: s.tested_at,
    testError: s.test_error,
    activatedAt: s.activated_at,
    createdAt: s.created_at,
    messagesSent: stats.sent ?? 0,
    messagesFailed: stats.failed ?? 0,
  };
}

async function getOwned(c) {
  return one(c.env.DB, "SELECT * FROM senders WHERE id = ? AND account_id = ?", c.req.param("id"), accountId(c));
}

senders.get("/", async (c) => {
  const id = accountId(c);
  const rows = await all(c.env.DB, "SELECT * FROM senders WHERE account_id = ? ORDER BY created_at DESC", id);
  const stats = await all(
    c.env.DB,
    `SELECT sender_id, SUM(CASE WHEN status IN ('sent','delivered','read') THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM messages WHERE account_id = ? AND direction = 'outbound' GROUP BY sender_id`,
    id,
  );
  const byId = new Map(stats.map((s) => [s.sender_id, s]));
  return c.json({ senders: rows.map((s) => present(s, byId.get(s.id))) });
});

// Messages that used one number (sent or received through it).
senders.get("/:id/messages", async (c) => {
  const sender = await getOwned(c);
  if (!sender) return c.json({ error: "Number not found." }, 404);
  const rows = await all(
    c.env.DB,
    `SELECT m.id, m.direction, m.kind, m.body, m.template_name, m.status, m.error, m.created_at, ct.name, ct.phone_e164, m.contact_id
       FROM messages m JOIN contacts ct ON ct.id = m.contact_id AND ct.account_id = m.account_id
      WHERE m.account_id = ? AND m.sender_id = ? ORDER BY m.created_at DESC LIMIT 100`,
    accountId(c), sender.id,
  );
  return c.json({
    messages: rows.map((m) => ({
      id: m.id, direction: m.direction, kind: m.kind, body: m.body, templateName: m.template_name,
      status: m.status, error: m.error, createdAt: m.created_at, contactId: m.contact_id, contactName: m.name, contactPhone: `+${m.phone_e164}`,
    })),
  });
});

// Approved templates without variables on this number (for the optional test message).
senders.get("/:id/test-templates", async (c) => {
  const sender = await getOwned(c);
  if (!sender) return c.json({ error: "Number not found." }, 404);
  const rows = await all(
    c.env.DB,
    "SELECT id, name, language FROM templates WHERE account_id = ? AND sender_id = ? AND status = 'APPROVED' AND has_header_media = 0 AND body_param_count = 0 ORDER BY name",
    accountId(c), sender.id,
  );
  return c.json({ templates: rows });
});

senders.post("/", async (c) => {
  const body = await readJson(c);
  const tokenRef = str(body.tokenRef, 40).toUpperCase();
  const phoneNumberId = str(body.phoneNumberId, 40);
  const wabaId = str(body.wabaId, 40);
  if (!/^[A-Z0-9_]{1,40}$/.test(tokenRef)) return c.json({ error: "Token name may only use A-Z, 0-9 and _." }, 400);
  if (!/^\d{5,40}$/.test(phoneNumberId)) return c.json({ error: "Phone number ID must be digits." }, 400);
  if (!/^\d{5,40}$/.test(wabaId)) return c.json({ error: "WhatsApp Business Account ID must be digits." }, 400);

  const taken = await one(c.env.DB, "SELECT id FROM senders WHERE phone_number_id = ?", phoneNumberId);
  if (taken) return c.json({ error: "This phone number ID is already registered." }, 409);

  const senderId = newId("snd");
  await run(
    c.env.DB,
    "INSERT INTO senders (id, account_id, token_ref, phone_number_id, waba_id, status, created_at) VALUES (?, ?, ?, ?, ?, 'inactive', ?)",
    senderId, accountId(c), tokenRef, phoneNumberId, wabaId, nowIso(),
  );
  return c.json({ sender: present(await one(c.env.DB, "SELECT * FROM senders WHERE id = ?", senderId)) }, 201);
});

// Test: the token can read this phone number, the number belongs to the WABA, and the WABA's
// templates can be fetched. Optionally also sends one real template message to a test number.
senders.post("/:id/test", async (c) => {
  const sender = await getOwned(c);
  if (!sender) return c.json({ error: "Number not found." }, 404);
  if (sender.status === "retired") return c.json({ error: "This number is retired." }, 409);
  const body = await readJson(c);

  let testPhone = null;
  if (body.testPhone) {
    try {
      testPhone = normalizePhone(body.testPhone);
    } catch (e) {
      if (e instanceof PhoneError) return c.json({ error: e.message }, 400);
      throw e;
    }
  }

  const fail = async (message) => {
    await run(c.env.DB, "UPDATE senders SET tested_at = NULL, test_error = ? WHERE id = ? AND account_id = ?", message, sender.id, sender.account_id);
    return c.json({ ok: false, error: message }, 200);
  };

  let info;
  try {
    info = await getPhoneNumber(c.env, sender);
    const nums = await listWabaPhoneNumbers(c.env, sender);
    if (!(nums?.data || []).some((n) => String(n.id) === sender.phone_number_id)) {
      return fail("This phone number ID does not belong to the WhatsApp Business Account ID you entered.");
    }
    await syncTemplates(c.env, sender);
  } catch (e) {
    return fail(e instanceof GraphError ? `Meta rejected the check: ${e.message}` : `Check failed: ${e.message}`);
  }

  await run(
    c.env.DB,
    "UPDATE senders SET display_number = ?, verified_name = ? WHERE id = ? AND account_id = ?",
    info?.display_phone_number || null, info?.verified_name || null, sender.id, sender.account_id,
  );

  if (testPhone) {
    const tplId = str(body.templateId, 60);
    const tpl = await one(c.env.DB, "SELECT * FROM templates WHERE id = ? AND sender_id = ? AND account_id = ?", tplId, sender.id, sender.account_id);
    if (!tpl || !isUsable(tpl) || tpl.body_param_count > 0) {
      return fail("For the test message, pick an approved template on this number that has no variables.");
    }
    const res = await sendToContactWithSender(c.env, { accountId: sender.account_id, sender, phone: testPhone, template: tpl });
    if (!res.ok) return fail(`Test message failed: ${res.error}`);
  }

  await run(c.env.DB, "UPDATE senders SET tested_at = ?, test_error = NULL WHERE id = ? AND account_id = ?", nowIso(), sender.id, sender.account_id);
  return c.json({ ok: true, sender: present(await getOwned(c)) });
});

// What would stop this number from being activated right now.
async function activationBlockers(env, sender) {
  const blockers = [];
  if (!sender.tested_at || sender.test_error) blockers.push({ code: "NOT_TESTED", message: "Run a successful test first." });
  const busy = await all(env.DB, "SELECT id, name, status FROM campaigns WHERE account_id = ? AND status IN ('scheduled', 'sending')", sender.account_id);
  if (busy.length) {
    blockers.push({ code: "CAMPAIGNS_ACTIVE", message: "Wait for these campaigns to finish, or cancel them.", campaigns: busy });
  }
  const needed = await all(env.DB, "SELECT DISTINCT template_name AS name, template_language AS language FROM campaigns WHERE account_id = ? AND status = 'draft'", sender.account_id);
  const missing = [];
  for (const t of needed) {
    const tpl = await one(env.DB, "SELECT * FROM templates WHERE sender_id = ? AND account_id = ? AND name = ? AND language = ?", sender.id, sender.account_id, t.name, t.language);
    if (!isUsable(tpl)) missing.push({ name: t.name, language: t.language, status: tpl?.status || "NOT_FOUND" });
  }
  if (missing.length) {
    blockers.push({ code: "TEMPLATES_MISSING", message: "Draft campaigns use templates that are not approved on this number.", templates: missing });
  }
  return blockers;
}

senders.get("/:id/activation-check", async (c) => {
  const sender = await getOwned(c);
  if (!sender) return c.json({ error: "Number not found." }, 404);
  return c.json({ blockers: await activationBlockers(c.env, sender) });
});

senders.post("/:id/activate", async (c) => {
  const sender = await getOwned(c);
  if (!sender) return c.json({ error: "Number not found." }, 404);
  if (sender.status === "active") return c.json({ error: "This number is already active." }, 409);
  if (sender.status === "retired") return c.json({ error: "This number is retired." }, 409);
  try {
    await syncTemplates(c.env, sender); // fresh template state for the check
  } catch (e) {
    return c.json({ error: `Could not refresh templates from Meta: ${e.message}` }, 502);
  }
  const blockers = await activationBlockers(c.env, sender);
  if (blockers.length) return c.json({ error: "This number cannot be activated yet.", blockers }, 409);

  const ts = nowIso();
  // One transaction: the previous active number becomes inactive (kept, not deleted), this one becomes active.
  // Both statements re-check "no scheduled or sending campaign" inside the transaction, so a launch
  // racing with this switch can never leave a campaign pinned to a number that is no longer active.
  const idle = "NOT EXISTS (SELECT 1 FROM campaigns WHERE account_id = ? AND status IN ('scheduled', 'sending'))";
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE senders SET status = 'inactive' WHERE account_id = ? AND status = 'active' AND ${idle}`).bind(sender.account_id, sender.account_id),
    c.env.DB.prepare(`UPDATE senders SET status = 'active', activated_at = ? WHERE id = ? AND account_id = ? AND ${idle}`).bind(ts, sender.id, sender.account_id, sender.account_id),
  ]);
  const after = await getOwned(c);
  if (after.status !== "active") return c.json({ error: "A campaign started while switching. Try again when it has finished." }, 409);
  return c.json({ ok: true, sender: present(after) });
});

export default senders;
