import { Hono } from "hono";
import { all, one, run, newId, nowIso } from "../lib/db.js";
import { normalizePhone, PhoneError, formatPhone } from "../lib/phone.js";
import { accountId, readJson, str, intEnv } from "../lib/http.js";

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

function filterSql(q, filter) {
  const where = ["account_id = ?"];
  const args = [];
  if (filter === "suppressed") where.push("suppressed = 1");
  if (filter === "active") where.push("suppressed = 0");
  if (q) {
    where.push("(LOWER(name) LIKE ? OR phone_e164 LIKE ?)");
    const like = `%${q.toLowerCase().replace(/[%_]/g, "")}%`;
    args.push(like, `%${q.replace(/\D/g, "") || "\u0000"}%`);
  }
  return { where: where.join(" AND "), args };
}

contacts.get("/", async (c) => {
  const q = str(c.req.query("q"), 100);
  const filter = c.req.query("filter") || "all";
  const limit = Math.min(Math.max(Number(c.req.query("limit")) || 50, 1), 200);
  const offset = Math.max(Number(c.req.query("offset")) || 0, 0);
  const { where, args } = filterSql(q, filter);
  const id = accountId(c);
  const rows = await all(c.env.DB, `SELECT * FROM contacts WHERE ${where} ORDER BY created_at DESC, id LIMIT ? OFFSET ?`, id, ...args, limit, offset);
  const total = await one(c.env.DB, `SELECT COUNT(*) AS n FROM contacts WHERE ${where}`, id, ...args);
  return c.json({ contacts: rows.map(presentContact), total: total?.n ?? 0 });
});

// Ids of every non-suppressed contact matching a search, for an explicit "select all" in campaign setup.
contacts.get("/ids", async (c) => {
  const q = str(c.req.query("q"), 100);
  const cap = intEnv(c.env, "MAX_CAMPAIGN_AUDIENCE", 1000);
  const { where, args } = filterSql(q, "active");
  const rows = await all(c.env.DB, `SELECT id FROM contacts WHERE ${where} ORDER BY created_at DESC, id LIMIT ?`, accountId(c), ...args, cap + 1);
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
contacts.post("/import", async (c) => {
  const body = await readJson(c);
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || rows.length === 0) return c.json({ error: "No rows to import." }, 400);
  if (rows.length > MAX_IMPORT_ROWS) return c.json({ error: `Import at most ${MAX_IMPORT_ROWS} rows at a time.` }, 400);

  const id = accountId(c);
  const invalid = [];
  const seen = new Map();
  rows.forEach((row, i) => {
    try {
      const phone = normalizePhone(row?.phone);
      seen.set(phone, { phone, name: str(row?.name, 120), row: i + 1 });
    } catch (e) {
      invalid.push({ row: i + 1, phone: str(row?.phone, 40), error: e instanceof PhoneError ? e.message : "Invalid row." });
    }
  });

  let created = 0;
  let updated = 0;
  const ts = nowIso();
  const list = [...seen.values()];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const stmts = [];
    for (const r of chunk) {
      stmts.push(c.env.DB.prepare(
        "INSERT INTO contacts (id, account_id, phone_e164, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, phone_e164) DO NOTHING",
      ).bind(newId("cnt"), id, r.phone, r.name, ts, ts));
      if (r.name) {
        stmts.push(c.env.DB.prepare(
          "UPDATE contacts SET name = ?, updated_at = ? WHERE account_id = ? AND phone_e164 = ? AND name <> ?",
        ).bind(r.name, ts, id, r.phone, r.name));
      }
    }
    const results = await c.env.DB.batch(stmts);
    let k = 0;
    for (const r of chunk) {
      const ins = results[k++]?.meta?.changes ?? 0;
      const upd = r.name ? (results[k++]?.meta?.changes ?? 0) : 0;
      if (ins) created++;
      else if (upd) updated++;
    }
  }
  return c.json({ created, updated, unchanged: list.length - created - updated, duplicatesInFile: rows.length - invalid.length - list.length, invalid });
});

export default contacts;
