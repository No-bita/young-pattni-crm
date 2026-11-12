import { Hono } from "hono";
import { all, one, run, newId, nowIso } from "../lib/db.js";
import { accountId, readJson, str, intEnv } from "../lib/http.js";
import { getActiveSender } from "../lib/send.js";
import { isUsable, needsImage, presentTemplate, unsupportedReason, parseContent } from "../lib/templates.js";
import { audienceSummary, launchBlockers, startCampaign, parseAudience, frozenShape, recordContentCheck } from "../lib/campaigns.js";
import { getOwnedAsset, assetBlocker, presentAsset, latestStart, isStored } from "../lib/media.js";
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
    media: await presentCampaignMedia(db, cmp),
    frozen: cmp.frozen_header_format ? { headerFormat: cmp.frozen_header_format, bodyText: cmp.frozen_body_text } : null,
    content: presentContent(parseContent(cmp.frozen_content_json)),
    contentCheck: cmp.content_checked_at ? { at: cmp.content_checked_at, source: cmp.content_check_source, note: cmp.content_check_note } : null,
    sendDeadline: cmp.send_deadline,
    notSentDeadline: await deadlineCount(db, cmp),
  };
}

function presentContent(c) {
  if (!c) return null;
  return {
    header: c.header,
    body: c.body,
    footer: c.footer,
    buttons: (c.buttons || []).map((b) => ({ type: b.type, text: b.text, url: b.url ?? null, phoneNumber: b.phone_number ?? null })),
  };
}

async function deadlineCount(db, cmp) {
  const r = await one(db, "SELECT COUNT(*) AS n FROM campaign_recipients WHERE account_id = ? AND campaign_id = ? AND failure_code = 'DEADLINE'", cmp.account_id, cmp.id);
  return r?.n ?? 0;
}

async function presentCampaignMedia(db, cmp) {
  if (!cmp.media_asset_id) return null;
  const asset = await getOwnedAsset(db, cmp.account_id, cmp.media_asset_id);
  if (!asset) return null;
  const s = await one(db, "SELECT display_number FROM senders WHERE id = ? AND account_id = ?", asset.sender_id, cmp.account_id);
  return presentAsset(asset, s?.display_number);
}

// Validates the image for a template: required for image-header templates, refused otherwise.
// The id must be one of this account's assets, uploaded through the active number, and still usable.
async function resolveMedia(c, tpl, mediaAssetId, sender) {
  if (!needsImage(tpl)) {
    if (mediaAssetId) return { error: "This template has no image header, so no image can be attached." };
    return { mediaAssetId: null };
  }
  const asset = await getOwnedAsset(c.env.DB, accountId(c), str(mediaAssetId, 60));
  const blocked = assetBlocker(asset, { senderId: sender.id, mustLastUntil: new Date() });
  if (blocked) return { error: blocked.code === "MEDIA_MISSING" && mediaAssetId ? "Image not found. Upload it again." : blocked.error, code: blocked.code };
  return { mediaAssetId: asset.id };
}

// Validates a template choice and its variable mapping against the ACTIVE sender's synced templates.
async function resolveTemplate(c, body) {
  const sender = await getActiveSender(c.env.DB, accountId(c));
  if (!sender) return { error: "Activate a WhatsApp number first." };
  const tpl = await one(c.env.DB, "SELECT * FROM templates WHERE id = ? AND account_id = ? AND sender_id = ?", str(body.templateId, 60), accountId(c), sender.id);
  if (!tpl) return { error: "Choose a template from the active number's Messaging account." };
  if (tpl.status !== "APPROVED") return { error: "This template is not approved by Meta yet." };
  if (!isUsable(tpl)) return { error: `This template can't be sent by this app: ${unsupportedReason(tpl)}` };
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
  const media = await resolveMedia(c, tpl, body.mediaAssetId, sender);
  if (media.error) return { error: media.error, code: media.code };
  return { tpl, params: clean, mediaAssetId: media.mediaAssetId };
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
  if (t.error) return c.json({ error: t.error, code: t.code }, 400);
  const id = newId("cmp");
  const ts = nowIso();
  await run(
    c.env.DB,
    "INSERT INTO campaigns (id, account_id, name, template_name, template_language, params_json, media_asset_id, frozen_content_json, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)",
    id, accountId(c), name, t.tpl.name, t.tpl.language, JSON.stringify(t.params), t.mediaAssetId, t.tpl.content_json ?? null, ts, ts,
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
  let mediaAssetId = cmp.media_asset_id;
  let frozenContent = cmp.frozen_content_json;
  if (body.templateId !== undefined) {
    const t = await resolveTemplate(c, body);
    if (t.error) return c.json({ error: t.error, code: t.code }, 400);
    templateName = t.tpl.name;
    templateLanguage = t.tpl.language;
    paramsJson = JSON.stringify(t.params);
    mediaAssetId = t.mediaAssetId;
    frozenContent = t.tpl.content_json ?? null; // picking (or re-picking) a template freezes its current content
  } else if (body.mediaAssetId !== undefined) {
    // Replace only the image, checked against the campaign's current template on the active number.
    const sender = await getActiveSender(c.env.DB, accountId(c));
    if (!sender) return c.json({ error: "Activate a WhatsApp number first." }, 409);
    const tpl = await one(c.env.DB, "SELECT * FROM templates WHERE account_id = ? AND sender_id = ? AND name = ? AND language = ?", accountId(c), sender.id, cmp.template_name, cmp.template_language);
    if (!tpl) return c.json({ error: "This campaign's template is not in the active number's Messaging account." }, 409);
    const m = await resolveMedia(c, tpl, body.mediaAssetId, sender);
    if (m.error) return c.json({ error: m.error, code: m.code }, 400);
    mediaAssetId = m.mediaAssetId;
  }
  await run(
    c.env.DB,
    "UPDATE campaigns SET name = ?, template_name = ?, template_language = ?, params_json = ?, media_asset_id = ?, frozen_content_json = ?, updated_at = ? WHERE id = ? AND account_id = ? AND status = 'draft'",
    name, templateName, templateLanguage, paramsJson, mediaAssetId, frozenContent, nowIso(), cmp.id, accountId(c),
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
  const asset = cmp.media_asset_id ? await getOwnedAsset(c.env.DB, accountId(c), cmp.media_asset_id) : null;
  return c.json({
    audience: summary,
    blocker: check.error ? { code: check.code, message: check.error } : null,
    latestStart: asset && !isStored(asset) ? latestStart(asset).toISOString() : null, // Meta-only images must start by this time; stored images have no CRM-side limit
  });
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

  let when = null;
  if (body.scheduledAt) {
    when = new Date(body.scheduledAt);
    const now = Date.now();
    if (Number.isNaN(when.getTime()) || when.getTime() < now + 60 * 1000) return c.json({ error: "Pick a time at least a minute from now." }, 400);
    if (when.getTime() > now + MAX_SCHEDULE_DAYS * 86400 * 1000) return c.json({ error: `Schedule within ${MAX_SCHEDULE_DAYS} days.` }, 400);
  }
  // For media campaigns this also checks the image stays usable from the start time through the queue.
  // Scheduling asks Meta for the template now (fresh); a launch-now does so inside startCampaign.
  let check;
  if (when) {
    check = await launchBlockers(c.env, cmp, { startAt: when, fresh: true });
    await recordContentCheck(c.env.DB, cmp, check.contentCheck);
  } else {
    check = await launchBlockers(c.env, cmp, { startAt: new Date() });
  }
  if (check.error) return c.json({ error: check.error, code: check.code, changed: check.changed }, 409);
  if (Number(body.confirmCount) !== check.summary.sendable) {
    return c.json({ error: "The audience changed since you confirmed it. Review the count and confirm again.", code: "AUDIENCE_CHANGED", audience: check.summary }, 409);
  }

  if (when) {
    const shape = frozenShape(check.tpl);
    const changed = await run(
      c.env.DB,
      `UPDATE campaigns SET status = 'scheduled', scheduled_at = ?, sender_id = ?, confirmed_count = ?, updated_at = ?,
              frozen_header_format = ?, frozen_body_text = ?, frozen_body_param_count = ?
        WHERE id = ? AND account_id = ? AND status = 'draft'
          AND EXISTS (SELECT 1 FROM senders WHERE id = ? AND account_id = ? AND status = 'active')`,
      when.toISOString(), check.sender.id, check.summary.sendable, nowIso(), shape.header, shape.body, shape.params,
      cmp.id, accountId(c), check.sender.id, accountId(c),
    );
    if (!changed) return c.json({ error: "This campaign was already launched." }, 409);
    return c.json({ campaign: await present(c.env.DB, await getOwned(c)) });
  }

  await run(c.env.DB, "UPDATE campaigns SET confirmed_count = ? WHERE id = ? AND account_id = ?", check.summary.sendable, cmp.id, accountId(c));
  const res = await startCampaign(c.env, { ...cmp, confirmed_count: check.summary.sendable });
  if (res.error) return c.json({ error: res.error, code: res.code, changed: res.changed }, 409);
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
