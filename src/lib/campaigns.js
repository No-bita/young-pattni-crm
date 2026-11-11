// Campaign engine. The audience is the stored list of contact ids on the campaign (audience_json).
// Preview and launch both use audienceSummary(), so the confirmed count is the count that is sent.
import { all, one, run, newId, nowIso } from "./db.js";
import { getActiveSender, sendToContact } from "./send.js";
import { isUsable, needsImage, lookupTemplate, parseContent } from "./templates.js";
import { contentDifferences } from "../whatsapp/graph.js";
import { intEnv } from "./http.js";
import { getOwnedAsset, assetBlocker, usableUntil, fmtUtc, QUEUE_BOUND_MS } from "./media.js";

export const FRESHNESS_TIMEOUT_MS = 5 * 1000; // approved: how long to wait for Meta before using the local copy

export function parseAudience(campaign) {
  if (campaign.audience_json === null || campaign.audience_json === undefined) return null;
  try {
    const ids = JSON.parse(campaign.audience_json);
    return Array.isArray(ids) ? ids : null;
  } catch {
    return null;
  }
}

export async function audienceSummary(db, campaign) {
  const ids = parseAudience(campaign);
  if (!ids) return { chosen: false, selected: 0, suppressed: 0, sendable: 0 };
  const row = await one(
    db,
    `SELECT COUNT(*) AS selected, COALESCE(SUM(suppressed), 0) AS suppressed
       FROM contacts WHERE account_id = ? AND id IN (SELECT value FROM json_each(?))`,
    campaign.account_id, campaign.audience_json,
  );
  const selected = row?.selected ?? 0;
  const suppressed = row?.suppressed ?? 0;
  return { chosen: true, selected, suppressed, sendable: selected - suppressed };
}

export async function campaignTemplate(db, campaign, senderId) {
  return one(
    db,
    "SELECT * FROM templates WHERE account_id = ? AND sender_id = ? AND name = ? AND language = ?",
    campaign.account_id, senderId, campaign.template_name, campaign.template_language,
  );
}

export function buildParams(paramsJson, contact) {
  const params = JSON.parse(paramsJson || "[]");
  return params.map((p) => (p.type === "contact_name" ? (contact.name?.trim() || p.fallback) : p.value));
}

// Content frozen when a campaign is scheduled or launched. If Meta's copy of the template changes
// afterwards (header type, body text or variable count), sends stop instead of going out altered.
export function frozenShape(tpl) {
  return { header: tpl.header_format ?? (tpl.has_header_media ? "MEDIA" : "NONE"), body: tpl.body_text ?? "", params: tpl.body_param_count ?? 0 };
}

export function shapeChanged(campaign, tpl) {
  if (campaign.frozen_header_format === null || campaign.frozen_header_format === undefined) return false;
  const now = frozenShape(tpl);
  return now.header !== campaign.frozen_header_format || now.body !== (campaign.frozen_body_text ?? "") || now.params !== campaign.frozen_body_param_count;
}

// Compares the content frozen when the template was picked with the current local copy.
// Returns the names of the parts that differ, [] when unchanged, or null when there is nothing
// frozen to compare against (campaigns created before content freezing existed).
export function contentChange(campaign, tpl) {
  const frozen = parseContent(campaign.frozen_content_json);
  if (!frozen) return shapeChanged(campaign, tpl) ? ["header type or body"] : null;
  const current = parseContent(tpl?.content_json);
  if (!current) return ["template (local copy predates content checks; refresh from Meta)"];
  return contentDifferences(frozen, current);
}

// Freshness check before launch, scheduling and a scheduled start: asks Meta for this one
// template (5 s deadline) and updates the local copy. If Meta can't be reached, the local copy is
// used and that is recorded; it is never reported as freshly checked.
export async function refreshCampaignTemplate(env, campaign, sender) {
  const at = nowIso();
  try {
    const row = await lookupTemplate(env, sender, { name: campaign.template_name, language: campaign.template_language }, { timeoutMs: FRESHNESS_TIMEOUT_MS });
    if (!row) {
      await run(env.DB, "UPDATE templates SET status = 'MISSING', synced_at = ? WHERE account_id = ? AND sender_id = ? AND name = ? AND language = ?",
        at, campaign.account_id, sender.id, campaign.template_name, campaign.template_language);
      return { source: "meta", at, note: "Meta no longer has this template." };
    }
    return { source: "meta", at, note: null };
  } catch (e) {
    return { source: "local_fallback", at, note: `Meta could not be asked (${e?.message || "error"}); used the copy last refreshed in the CRM.` };
  }
}

export async function recordContentCheck(db, campaign, check) {
  if (!check) return;
  await run(db, "UPDATE campaigns SET content_checked_at = ?, content_check_source = ?, content_check_note = ? WHERE id = ? AND account_id = ?",
    check.at, check.source, check.note, campaign.id, campaign.account_id);
}

// Media check: the image must belong to this account, have been uploaded through `senderId`,
// and stay usable until the whole audience has been worked through (start + queue bound).
export async function mediaBlocker(env, campaign, tpl, senderId, startAt) {
  if (!needsImage(tpl)) return null;
  const asset = await getOwnedAsset(env.DB, campaign.account_id, campaign.media_asset_id);
  return assetBlocker(asset, { senderId, mustLastUntil: new Date(startAt.getTime() + QUEUE_BOUND_MS) });
}

// Checks shared by "launch now", "schedule" and "scheduled time reached".
// startAt is when sending would begin (now, or the scheduled time).
export async function launchBlockers(env, campaign, { startAt = new Date(), fresh = false } = {}) {
  const sender = await getActiveSender(env.DB, campaign.account_id);
  if (!sender) return { error: "Activate a WhatsApp number first.", code: "NO_ACTIVE_SENDER" };
  if (campaign.sender_id && campaign.sender_id !== sender.id) {
    return { error: "The WhatsApp number changed after this campaign was scheduled.", code: "SENDER_CHANGED" };
  }
  const contentCheck = fresh ? await refreshCampaignTemplate(env, campaign, sender) : null;
  const withCheck = (r) => ({ ...r, contentCheck });
  const tpl = await campaignTemplate(env.DB, campaign, sender.id);
  if (!isUsable(tpl)) {
    return withCheck({ error: `Template "${campaign.template_name}" is not approved in the active number's Messaging account, or can't be sent by this app.${contentCheck?.note ? ` ${contentCheck.note}` : ""}`, code: "TEMPLATE_NOT_APPROVED" });
  }
  const diffs = contentChange(campaign, tpl);
  if (diffs === null && campaign.status === "draft") {
    return withCheck({ error: "This draft was created before template content checks. Pick its template again to review the current version.", code: "TEMPLATE_RECHECK_NEEDED" });
  }
  if (diffs && diffs.length) {
    const where = contentCheck?.source === "meta" ? "in Meta" : "in the CRM's copy";
    return withCheck({ error: `Template "${campaign.template_name}" changed ${where} since it was picked (${diffs.join(", ")}). Pick it again to review the new version.`, code: "TEMPLATE_CHANGED", changed: diffs });
  }
  const media = await mediaBlocker(env, campaign, tpl, sender.id, startAt);
  if (media) return media;
  const summary = await audienceSummary(env.DB, campaign);
  if (!summary.chosen || summary.selected === 0) return { error: "Choose the audience first. An empty audience never means everyone.", code: "AUDIENCE_EMPTY" };
  if (summary.sendable === 0) return { error: "Every selected contact has opted out.", code: "AUDIENCE_EMPTY" };
  const cap = intEnv(env, "MAX_CAMPAIGN_AUDIENCE", 1000);
  if (summary.sendable > cap) return { error: `A campaign can reach at most ${cap} contacts.`, code: "OVER_CAP" };
  return { sender, summary, tpl, contentCheck };
}

// The point after which queued recipients are no longer sent: start + queue bound, and never
// later than the image's usable-until time. Reaching it does not mean everyone was sent to.
export async function sendDeadline(env, campaign, tpl, start) {
  let deadline = start.getTime() + QUEUE_BOUND_MS;
  if (needsImage(tpl)) {
    const asset = await getOwnedAsset(env.DB, campaign.account_id, campaign.media_asset_id);
    if (asset) deadline = Math.min(deadline, usableUntil(asset).getTime());
  }
  return new Date(deadline).toISOString();
}

// Moves a campaign to 'sending': writes recipient rows from the stored audience and queues them.
export async function startCampaign(env, campaign) {
  const start = new Date();
  const check = await launchBlockers(env, campaign, { startAt: start, fresh: true });
  await recordContentCheck(env.DB, campaign, check.contentCheck);
  if (check.error) return check;
  const { sender, tpl } = check;
  const ts = start.toISOString();
  const shape = frozenShape(tpl);
  const deadline = await sendDeadline(env, campaign, tpl, start);

  // Freezes the content (kept from scheduling time when already frozen) and pins the sender.
  const claimed = await run(
    env.DB,
    `UPDATE campaigns SET status = 'sending', sender_id = ?, launched_at = ?, updated_at = ?, error = NULL, send_deadline = ?,
            frozen_header_format = COALESCE(frozen_header_format, ?), frozen_body_text = COALESCE(frozen_body_text, ?),
            frozen_body_param_count = COALESCE(frozen_body_param_count, ?)
      WHERE id = ? AND account_id = ? AND status IN ('draft', 'scheduled')
        AND EXISTS (SELECT 1 FROM senders WHERE id = ? AND account_id = ? AND status = 'active')`,
    sender.id, ts, ts, deadline, shape.header, shape.body, shape.params, campaign.id, campaign.account_id, sender.id, campaign.account_id,
  );
  if (!claimed) return { error: "This campaign was already launched or cancelled.", code: "NOT_LAUNCHABLE" };

  await run(
    env.DB,
    `INSERT INTO campaign_recipients (id, account_id, campaign_id, contact_id, status, updated_at)
       SELECT 'rcp_' || lower(hex(randomblob(16))), ?, ?, c.id, CASE WHEN c.suppressed = 1 THEN 'skipped_suppressed' ELSE 'queued' END, ?
         FROM contacts c WHERE c.account_id = ? AND c.id IN (SELECT value FROM json_each(?))
       ON CONFLICT(campaign_id, contact_id) DO NOTHING`,
    campaign.account_id, campaign.id, ts, campaign.account_id, campaign.audience_json,
  );
  const queued = await all(env.DB, "SELECT id FROM campaign_recipients WHERE account_id = ? AND campaign_id = ? AND status = 'queued'", campaign.account_id, campaign.id);
  for (let i = 0; i < queued.length; i += 100) {
    await env.CAMPAIGN_QUEUE.sendBatch(queued.slice(i, i + 100).map((r) => ({ body: { recipientId: r.id, accountId: campaign.account_id } })));
  }
  await finalizeIfDone(env.DB, campaign.account_id, campaign.id);
  return { ok: true, queued: queued.length };
}

// Queue consumer step for one recipient. Never re-sends: a recipient is claimed queued -> sending once.
export async function processRecipient(env, { recipientId, accountId }) {
  const db = env.DB;
  // Deadline first: a delayed worker must not send after the campaign's sending window.
  const pre = await one(db, `SELECT r.status, c.status AS campaign_status, c.send_deadline FROM campaign_recipients r
                               JOIN campaigns c ON c.id = r.campaign_id AND c.account_id = r.account_id
                              WHERE r.id = ? AND r.account_id = ?`, recipientId, accountId);
  if (pre && pre.status === "queued" && pre.campaign_status === "sending" && pre.send_deadline && Date.now() >= Date.parse(pre.send_deadline)) {
    const late = await run(db, "UPDATE campaign_recipients SET status = 'failed', failure_code = 'DEADLINE', error = ?, updated_at = ? WHERE id = ? AND account_id = ? AND status = 'queued'",
      `Not sent: the campaign's sending window ended at ${fmtUtc(pre.send_deadline)}.`, nowIso(), recipientId, accountId);
    return late ? "deadline" : "skipped";
  }
  const claimed = await run(db, "UPDATE campaign_recipients SET status = 'sending', updated_at = ? WHERE id = ? AND account_id = ? AND status = 'queued'", nowIso(), recipientId, accountId);
  if (!claimed) return "skipped";
  const r = await one(db, "SELECT * FROM campaign_recipients WHERE id = ? AND account_id = ?", recipientId, accountId);
  const campaign = await one(db, "SELECT * FROM campaigns WHERE id = ? AND account_id = ?", r.campaign_id, accountId);

  const settle = (status, error = null, messageId = null) =>
    run(db, "UPDATE campaign_recipients SET status = ?, error = ?, message_id = ?, updated_at = ? WHERE id = ? AND account_id = ?", status, error, messageId, nowIso(), recipientId, accountId);

  if (!campaign || campaign.status !== "sending") {
    await settle("cancelled");
    return "cancelled";
  }
  const contact = await one(db, "SELECT * FROM contacts WHERE id = ? AND account_id = ?", r.contact_id, accountId);
  const tpl = await campaignTemplate(db, campaign, campaign.sender_id);
  if (!isUsable(tpl)) {
    await settle("failed", "Template is no longer approved in this number's Messaging account.");
    return "failed";
  }
  const diffs = contentChange(campaign, tpl);
  if (diffs && diffs.length) {
    await settle("failed", `Template changed after launch (${diffs.join(", ")}). Not sent.`);
    return "failed";
  }
  let headerImageId = null;
  let mediaAssetId = null;
  if (needsImage(tpl)) {
    const asset = await getOwnedAsset(db, accountId, campaign.media_asset_id);
    const blocked = assetBlocker(asset, { senderId: campaign.sender_id, mustLastUntil: new Date() });
    if (blocked) {
      await settle("failed", blocked.error);
      return "failed";
    }
    headerImageId = asset.meta_media_id;
    mediaAssetId = asset.id;
  }
  const res = await sendToContact(env, {
    accountId,
    contactId: r.contact_id,
    kind: "template",
    template: {
      name: tpl.name,
      language: tpl.language,
      bodyText: campaign.frozen_body_text ?? tpl.body_text,
      bodyParams: contact ? buildParams(campaign.params_json, contact) : [],
      headerImageId,
      mediaAssetId,
    },
    campaignId: campaign.id,
    senderId: campaign.sender_id,
  });
  if (res.ok) await settle("sent", null, res.messageId);
  else if (res.code === "SUPPRESSED") await settle("skipped_suppressed");
  else await settle("failed", res.error, res.messageId || null);
  return res.ok ? "sent" : res.code;
}

export async function finalizeIfDone(db, accountId, campaignId) {
  const open = await one(db, "SELECT COUNT(*) AS n FROM campaign_recipients WHERE account_id = ? AND campaign_id = ? AND status IN ('pending', 'queued', 'sending')", accountId, campaignId);
  if ((open?.n ?? 0) === 0) {
    await run(db, "UPDATE campaigns SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND account_id = ? AND status = 'sending'", nowIso(), nowIso(), campaignId, accountId);
  }
}

// Cron: start due scheduled campaigns, settle stuck sends (never re-sent), close finished campaigns.
export async function runScheduler(env, now = new Date()) {
  const db = env.DB;
  const due = await all(db, "SELECT * FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= ? LIMIT 20", now.toISOString());
  for (const campaign of due) {
    const res = await startCampaign(env, campaign);
    if (res.error) {
      await run(db, "UPDATE campaigns SET status = 'cancelled', error = ?, updated_at = ? WHERE id = ? AND account_id = ? AND status = 'scheduled'", `Not sent at the scheduled time: ${res.error}`, nowIso(), campaign.id, campaign.account_id);
    }
  }
  const staleBefore = new Date(now.getTime() - 10 * 60 * 1000).toISOString();
  await run(db, "UPDATE campaign_recipients SET status = 'failed', error = 'Send outcome unknown (interrupted). Not retried to avoid a duplicate message.', updated_at = ? WHERE status = 'sending' AND updated_at < ?", nowIso(), staleBefore);
  const queueStaleBefore = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  await run(db, "UPDATE campaign_recipients SET status = 'failed', failure_code = 'DEADLINE', error = 'Not sent: the send queue did not deliver this message within an hour.', updated_at = ? WHERE status = 'queued' AND updated_at < ?", nowIso(), queueStaleBefore);
  const sending = await all(db, "SELECT id, account_id FROM campaigns WHERE status = 'sending'");
  for (const c of sending) await finalizeIfDone(db, c.account_id, c.id);
}

export { newId };
