import { Hono } from "hono";
import { all, one, run, newId, nowIso } from "../lib/db.js";
import { normalizePhone, PhoneError, formatPhone } from "../lib/phone.js";
import { accountId, readJson, str, intEnv, HttpError } from "../lib/http.js";

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
// Rows are grouped by normalized number so repeats inside the file collapse into one contact.
function parseImportRows(rows) {
  const invalid = [];
  const seen = new Map();
  rows.forEach((row, i) => {
    try {
      const phone = normalizePhone(row?.phone);
      const entry = { name: str(row?.name, 120), row: i + 1 };
      const group = seen.get(phone);
      if (group) group.rows.push(entry);
      else seen.set(phone, { phone, rows: [entry] });
    } catch (e) {
      invalid.push({ row: i + 1, phone: str(row?.phone, 40), error: e instanceof PhoneError ? e.message : "Invalid row." });
    }
  });
  return { invalid, groups: [...seen.values()] };
}

// Distinct names in one number's group, in first-appearance order; "" represents a blank name row.
function distinctNames(group) {
  const seen = new Set();
  const out = [];
  for (const r of group.rows) {
    if (!seen.has(r.name)) {
      seen.add(r.name);
      out.push({ name: r.name, row: r.row });
    }
  }
  return out;
}

// The name a group imports with: the explicit repeat choice when given (possibly "" for "No name"),
// otherwise the last row's.
function resolveName(group, repeatChoices) {
  if (repeatChoices && Object.prototype.hasOwnProperty.call(repeatChoices, group.phone)) {
    const choice = str(repeatChoices[group.phone], 120);
    if (!distinctNames(group).some((n) => n.name === choice)) {
      throw new HttpError(400, "A repeated-number name choice does not match the file.", "BAD_REPEAT_CHOICE");
    }
    return choice;
  }
  return group.rows[group.rows.length - 1].name;
}

async function existingByPhone(db, id, phones) {
  const map = new Map();
  for (let i = 0; i < phones.length; i += 100) {
    const chunk = phones.slice(i, i + 100);
    const marks = chunk.map(() => "?").join(",");
    const rows = await all(db, `SELECT phone_e164, name, suppressed FROM contacts WHERE account_id = ? AND phone_e164 IN (${marks})`, id, ...chunk);
    for (const r of rows) map.set(r.phone_e164, r);
  }
  return map;
}

// Dry run of an import: lists the conflicts the user must resolve before importing, without changing anything.
// A conflict is a saved contact whose name would change; a repeat is a number repeated in the file with different names.
contacts.post("/import/check", async (c) => {
  const body = await readJson(c);
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || rows.length === 0) return c.json({ error: "No rows to check." }, 400);
  if (rows.length > MAX_IMPORT_ROWS) return c.json({ error: `Import at most ${MAX_IMPORT_ROWS} rows at a time.` }, 400);

  const { invalid, groups } = parseImportRows(rows);
  const existing = await existingByPhone(c.env.DB, accountId(c), groups.map((g) => g.phone));

  const conflicts = [];
  const repeats = [];
  for (const g of groups) {
    const names = distinctNames(g);
    if (names.length > 1) repeats.push({ phone: g.phone, phoneDisplay: formatPhone(g.phone), names });
    const saved = existing.get(g.phone);
    if (saved) {
      const incoming = names.map((n) => n.name).filter(Boolean);
      const differing = incoming.filter((n) => n && n !== saved.name);
      if (differing.length) {
        conflicts.push({ phone: g.phone, phoneDisplay: formatPhone(g.phone), savedName: saved.name, incomingNames: differing, optedOut: Boolean(saved.suppressed) });
      }
    }
  }
  return c.json({ conflicts, repeats, invalidCount: invalid.length });
});

// Rows are parsed from CSV in the browser and sent as JSON: [{ phone, name }].
// Existing contacts keep their suppression. resolutions[phone] = "update" applies the file's name,
// "discard" keeps the saved contact exactly as it is; without a resolution a non-empty differing name updates the stored name.
// repeatChoices[phone] picks which name a repeated number imports with; without a choice the last row wins.
contacts.post("/import", async (c) => {
  const body = await readJson(c);
  const rows = Array.isArray(body.rows) ? body.rows : null;
  if (!rows || rows.length === 0) return c.json({ error: "No rows to import." }, 400);
  if (rows.length > MAX_IMPORT_ROWS) return c.json({ error: `Import at most ${MAX_IMPORT_ROWS} rows at a time.` }, 400);

  const resolutions = body.resolutions && typeof body.resolutions === "object" ? body.resolutions : {};
  const repeatChoices = body.repeatChoices && typeof body.repeatChoices === "object" ? body.repeatChoices : {};
  for (const v of Object.values(resolutions)) {
    if (v !== "update" && v !== "discard") return c.json({ error: 'Resolutions must be "update" or "discard".' }, 400);
  }

  const id = accountId(c);
  const { invalid, groups } = parseImportRows(rows);
  const list = groups.map((g) => ({ phone: g.phone, name: resolveName(g, repeatChoices), row: g.rows[g.rows.length - 1].row }));
  const existing = await existingByPhone(c.env.DB, id, list.map((r) => r.phone));

  let created = 0;
  let updated = 0;
  const ts = nowIso();
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const stmts = [];
    for (const r of chunk) {
      stmts.push(c.env.DB.prepare(
        "INSERT INTO contacts (id, account_id, phone_e164, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(account_id, phone_e164) DO NOTHING",
      ).bind(newId("cnt"), id, r.phone, r.name, ts, ts));
      const discarded = existing.has(r.phone) && resolutions[r.phone] === "discard";
      if (r.name && !discarded) {
        stmts.push(c.env.DB.prepare(
          "UPDATE contacts SET name = ?, updated_at = ? WHERE account_id = ? AND phone_e164 = ? AND name <> ?",
        ).bind(r.name, ts, id, r.phone, r.name));
      }
    }
    const results = await c.env.DB.batch(stmts);
    let k = 0;
    for (const r of chunk) {
      const discarded = existing.has(r.phone) && resolutions[r.phone] === "discard";
      const ins = results[k++]?.meta?.changes ?? 0;
      const upd = r.name && !discarded ? (results[k++]?.meta?.changes ?? 0) : 0;
      if (ins) created++;
      else if (upd) updated++;
    }
  }
  return c.json({ created, updated, unchanged: list.length - created - updated, duplicatesInFile: rows.length - invalid.length - list.length, invalid });
});

export default contacts;
