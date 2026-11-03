import { Hono } from "hono";
import { all, one, run, newId, nowIso } from "../lib/db.js";
import { accountId, readJson, str, intEnv } from "../lib/http.js";
import { getActiveSender } from "../lib/send.js";
import { isUsable, presentTemplate } from "../lib/templates.js";
import { audienceSummary, launchBlockers, startCampaign, parseAudience } from "../lib/campaigns.js";
import { formatPhone } from "../lib/phone.js";

const campaigns = new Hono();
const MAX_SCHEDULE_DAYS = 90;

async function getOwned(c) {
  return one(c.env.DB, "SELECT * FROM campaigns WHERE id = ? AND account_id = ?", c.req.param("id"), accountId(c));
}

async function recipientCounts(db, accountId, campaignId) {
  const rows = await all(db, "SELECT status, COUNT(*) AS n FROM campaign_recipients WHERE account_id = ? AND campaign_id = ? GROUP BY status", accountId, campaignId);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

async function present(db, cmp) {
  const sender = cmp.sender_id ? await one(db, "SELECT display_number FROM senders WHERE id = ? AND account_id = ?", cmp.sender_id, cmp.account_id) : null;
  return {
    id: cmp.id,
    name: cmp.name,
    status: cmp.status,
    templateName: cmp.template_name,
    templateLanguage: cmp.template_language,
    params: JSON.parse(cmp.params_json || "[]"),
    audience: await audienceSummary(db, cmp),
    confirmedCount: cmp.confirmed_count,
    senderNumber: sender?.display_number || null,
    scheduledAt: cmp.scheduled_at,
    launchedAt: cmp.launched_at,
    completedAt: cmp.completed_at,
    error: cmp.error,
    createdAt: cmp.created_at,
    recipients: await recipientCounts(db, cmp.account_id, cmp.id),
  };
}

// Validates a template choice and its variable mapping against the ACTIVE sender's synced templates.
async function resolveTemplate(c, body) {
  const sender = await getActiveSender(c.env.DB, accountId(c));
  if (!sender) return { error: "Activate a WhatsApp number first." };
  const tpl = await one(c.env.DB, "SELECT * FROM templates WHERE id = ? AND account_id = ? AND sender_id = ?", str(body.templateId, 60), accountId(c), sender.id);
  if (!tpl) return { error: "Choose a template from the active number." };
  if (!isUsable(tpl)) return { error: tpl.has_header_media ? "Templates with a media header are not supported in v1." : "This template is not approved by Meta yet." };
  const params = Array.isArray(body.params) ? body.params : [];
  if (params.length !== tpl.body_param_count) return { error: `This template needs ${tpl.body_param_count} variable value(s).` };
  const clean = [];
  for (const p of params) {
    if (p?.type === "contact_name") {
      const fallback = str(p.fallback, 60);
      if (!fallback) return { error: "Give a fallback for contacts without a name." };
      clean.push({ type: "contact_name", fallback });
    } else if (p?.type === "text") {
      const value = str(p.value, 500);
      if (!value) return { error: "Every variable needs a value." };
      clean.push({ type: "text", value });
    } else {
      return { error: "Unknown variable type." };
    }
  }
  return { tpl, params: clean };
}

campaigns.get("/", async (c) => {
  const rows = await all(c.env.DB, "SELECT * FROM campaigns WHERE account_id = ? ORDER BY created_at DESC LIMIT 200", accountId(c));
  const out = [];
  for (const r of rows) out.push(await present(c.env.DB, r));
  return c.json({ campaigns: out });
});

campaigns.post("/", async (c) => {
  const body = await readJson(c);
  const name = str(body.name, 120);
  if (!name) return c.json({ error: "Name the campaign." }, 400);
  const t = await resolveTemplate(c, body);
  if (t.error) return c.json({ error: t.error }, 400);
  const id = newId("cmp");
  const ts = nowIso();
  await run(
    c.env.DB,
    "INSERT INTO campaigns (id, account_id, name, template_name, template_language, params_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
    id, accountId(c), name, t.tpl.name, t.tpl.language, JSON.stringify(t.params), ts, ts,
  );
  return c.json({ campaign: await present(c.env.DB, await one(c.env.DB, "SELECT * FROM campaigns WHERE id = ?", id)) }, 201);
});

campaigns.get("/:id", async (c) => {
  const cmp = await getOwned(c);
  if (!cmp) return c.json({ error: "Campaign not found." }, 404);
  const sender = await getActiveSender(c.env.DB, accountId(c));
  const tpl = await one(
    c.env.DB,
    "SELECT * FROM templates WHERE account_id = ? AND sender_id = ? AND name = ? AND language = ?",
    accountId(c), cmp.sender_id || sender?.id || "", cmp.template_name, cmp.template_language,
  );
  return c.json({ campaign: await present(c.env.DB, cmp), template: tpl ? presentTemplate(tpl) : null, audienceIds: parseAudience(cmp) });
});

campaigns.patch("/:id", async (c) => {
  const cmp = await getOwned(c);
  if (!cmp) return c.json({ error: "Campaign not found." }, 404);
  if (cmp.status !== "draft") return c.json({ error: "Only draft campaigns can be edited." }, 409);
  const body = await readJson(c);
  const name = str(body.name ?? cmp.name, 120);
  if (!name) return c.json({ error: "Name the campaign." }, 400);
  let templateName = cmp.template_name;
  let templateLanguage = cmp.template_language;
  let paramsJson = cmp.params_json;
  if (body.templateId !== undefined) {
    const t = await resolveTemplate(c, body);
    if (t.error) return c.json({ error: t.error }, 400);
    templateName = t.tpl.name;
    templateLanguage = t.tpl.language;
    paramsJson = JSON.stringify(t.params);
  }
  await run(
    c.env.DB,
    "UPDATE campaigns SET name = ?, template_name = ?, template_language = ?, params_json = ?, updated_at = ? WHERE id = ? AND account_id = ? AND status = 'draft'",
    name, templateName, templateLanguage, paramsJson, nowIso(), cmp.id, accountId(c),
  );
  return c.json({ campaign: await present(c.env.DB, await getOwned(c)) });
});

// Saves the audience: an explicit list of contact ids from this account. Never "all".
campaigns.put("/:id/audience", async (c) => {
  const cmp = await getOwned(c);
  if (!cmp) return c.json({ error: "Campaign not found." }, 404);
  if (cmp.status !== "draft") return c.json({ error: "The audience is locked once a campaign is launched." }, 409);
  const body = await readJson(c);
  if (!Array.isArray(body.contactIds) || body.contactIds.length === 0) {
    return c.json({ error: "Choose at least one contact.", code: "AUDIENCE_EMPTY" }, 400);
  }
  const ids = [...new Set(body.contactIds.map((x) => String(x)))];
  const cap = intEnv(c.env, "MAX_CAMPAIGN_AUDIENCE", 1000);
  if (ids.length > cap) return c.json({ error: `A campaign can reach at most ${cap} contacts.`, code: "OVER_CAP" }, 400);
  const owned = await one(c.env.DB, "SELECT COUNT(*) AS n FROM contacts WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))", accountId(c), JSON.stringify(ids));
  if ((owned?.n ?? 0) !== ids.length) return c.json({ error: "Some selected contacts were not found." }, 400);
  await run(c.env.DB, "UPDATE campaigns SET audience_json = ?, updated_at = ? WHERE id = ? AND account_id = ? AND status = 'draft'", JSON.stringify(ids), nowIso(), cmp.id, accountId(c));
  return c.json({ campaign: await present(c.env.DB, await getOwned(c)) });
});

// The same function the launch uses, so the preview count is the launch count.
campaigns.get("/:id/preview", async (c) => {
  const cmp = await getOwned(c);
  if (!cmp) return c.json({ error: "Campaign not found." }, 404);
  const summary = await audienceSummary(c.env.DB, cmp);
  const check = cmp.status === "draft" ? await launchBlockers(c.env, cmp) : {};
  return c.json({ audience: summary, blocker: check.error ? { code: check.code, message: check.error } : null });
});

campaigns.get("/:id/recipients", async (c) => {
  const cmp = await getOwned(c);
  if (!cmp) return c.json({ error: "Campaign not found." }, 404);
  const status = c.req.query("status");
  const rows = await all(
    c.env.DB,
    `SELECT r.id, r.status, r.error, r.updated_at, ct.id AS contact_id, ct.name, ct.phone_e164, m.status AS message_status
       FROM campaign_recipients r
       JOIN contacts ct ON ct.id = r.contact_id AND ct.account_id = r.account_id
       LEFT JOIN messages m ON m.id = r.message_id AND m.account_id = r.account_id
      WHERE r.account_id = ? AND r.campaign_id = ? ${status ? "AND r.status = ?" : ""}
      ORDER BY r.updated_at DESC LIMIT 500`,
    ...(status ? [accountId(c), cmp.id, status] : [accountId(c), cmp.id]),
  );
  return c.json({
    recipients: rows.map((r) => ({
      id: r.id, status: r.status, error: r.error, updatedAt: r.updated_at,
      contactId: r.contact_id, name: r.name, phone: formatPhone(r.phone_e164),
    })),
  });
});

// Launch now, or schedule. confirmCount must equal the current sendable count shown to the user.
campaigns.post("/:id/launch", async (c) => {
  const cmp = await getOwned(c);
  if (!cmp) return c.json({ error: "Campaign not found." }, 404);
  if (cmp.status !== "draft") return c.json({ error: "Only draft campaigns can be launched." }, 409);
  const body = await readJson(c);

  const check = await launchBlockers(c.env, cmp);
  if (check.error) return c.json({ error: check.error, code: check.code }, 409);
  if (Number(body.confirmCount) !== check.summary.sendable) {
    return c.json({ error: "The audience changed since you confirmed it. Review the count and confirm again.", code: "AUDIENCE_CHANGED", audience: check.summary }, 409);
  }

  if (body.scheduledAt) {
    const when = new Date(body.scheduledAt);
    const now = Date.now();
    if (Number.isNaN(when.getTime()) || when.getTime() < now + 60 * 1000) return c.json({ error: "Pick a time at least a minute from now." }, 400);
    if (when.getTime() > now + MAX_SCHEDULE_DAYS * 86400 * 1000) return c.json({ error: `Schedule within ${MAX_SCHEDULE_DAYS} days.` }, 400);
    const changed = await run(
      c.env.DB,
      `UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, sender_id = ?, confirmed_count = ?, updated_at = ?
        WHERE id = ? AND account_id = ? AND status = 'draft'
          AND EXISTS (SELECT 1 FROM senders WHERE id = ? AND account_id = ? AND status = 'active')`,
      when.toISOString(), check.sender.id, check.summary.sendable, nowIso(), cmp.id, accountId(c), check.sender.id, accountId(c),
    );
    if (!changed) return c.json({ error: "This campaign was already launched." }, 409);
    return c.json({ campaign: await present(c.env.DB, await getOwned(c)) });
  }

  await run(c.env.DB, "UPDATE campaigns SET confirmed_count = ? WHERE id = ? AND account_id = ?", check.summary.sendable, cmp.id, accountId(c));
  const res = await startCampaign(c.env, { ...cmp, confirmed_count: check.summary.sendable });
  if (res.error) return c.json({ error: res.error, code: res.code }, 409);
  return c.json({ campaign: await present(c.env.DB, await getOwned(c)) });
});

campaigns.post("/:id/cancel", async (c) => {
  const cmp = await getOwned(c);
  if (!cmp) return c.json({ error: "Campaign not found." }, 404);
  if (!["draft", "scheduled", "sending"].includes(cmp.status)) return c.json({ error: "This campaign has already finished." }, 409);
  const ts = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE campaigns SET status = 'cancelled', updated_at = ? WHERE id = ? AND account_id = ? AND status IN ('draft', 'scheduled', 'sending')").bind(ts, cmp.id, accountId(c)),
    c.env.DB.prepare("UPDATE campaign_recipients SET status = 'cancelled', updated_at = ? WHERE account_id = ? AND campaign_id = ? AND status IN ('pending', 'queued')").bind(ts, accountId(c), cmp.id),
  ]);
  return c.json({ campaign: await present(c.env.DB, await getOwned(c)) });
});

export default campaigns;
