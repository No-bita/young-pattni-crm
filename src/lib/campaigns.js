// Campaign engine. The audience is the stored list of contact ids on the campaign (audience_json).
// Preview and launch both use audienceSummary(), so the confirmed count is the count that is sent.
import { all, one, run, newId, nowIso } from "./db.js";
import { getActiveSender, sendToContact } from "./send.js";
import { isUsable } from "./templates.js";
import { intEnv } from "./http.js";

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

// Checks shared by "launch now", "schedule" and "scheduled time reached".
export async function launchBlockers(env, campaign) {
  const sender = await getActiveSender(env.DB, campaign.account_id);
  if (!sender) return { error: "Activate a WhatsApp number first.", code: "NO_ACTIVE_SENDER" };
  if (campaign.sender_id && campaign.sender_id !== sender.id) {
    return { error: "The WhatsApp number changed after this campaign was scheduled.", code: "SENDER_CHANGED" };
  }
  const tpl = await campaignTemplate(env.DB, campaign, sender.id);
  if (!isUsable(tpl)) {
    return { error: `Template "${campaign.template_name}" is not approved on the active number.`, code: "TEMPLATE_NOT_APPROVED" };
  }
  const summary = await audienceSummary(env.DB, campaign);
  if (!summary.chosen || summary.selected === 0) return { error: "Choose the audience first. An empty audience never means everyone.", code: "AUDIENCE_EMPTY" };
  if (summary.sendable === 0) return { error: "Every selected contact has opted out.", code: "AUDIENCE_EMPTY" };
  const cap = intEnv(env, "MAX_CAMPAIGN_AUDIENCE", 1000);
  if (summary.sendable > cap) return { error: `A campaign can reach at most ${cap} contacts.`, code: "OVER_CAP" };
  return { sender, summary };
}

// Moves a campaign to 'sending': writes recipient rows from the stored audience and queues them.
export async function startCampaign(env, campaign) {
  const check = await launchBlockers(env, campaign);
  if (check.error) return check;
  const { sender } = check;
  const ts = nowIso();

  const claimed = await run(
    env.DB,
    `UPDATE campaigns SET status = 'sending', sender_id = ?, launched_at = ?, updated_at = ?, error = NULL
      WHERE id = ? AND account_id = ? AND status IN ('draft', 'scheduled')
        AND EXISTS (SELECT 1 FROM senders WHERE id = ? AND account_id = ? AND status = 'active')`,
    sender.id, ts, ts, campaign.id, campaign.account_id, sender.id, campaign.account_id,
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
    await settle("failed", "Template is no longer approved on this number.");
    return "failed";
  }
  const res = await sendToContact(env, {
    accountId,
    contactId: r.contact_id,
    kind: "template",
    template: { name: tpl.name, language: tpl.language, bodyText: tpl.body_text, bodyParams: contact ? buildParams(campaign.params_json, contact) : [] },
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
  await run(db, "UPDATE campaign_recipients SET status = 'failed', error = 'Not sent: the send queue did not deliver this message within an hour.', updated_at = ? WHERE status = 'queued' AND updated_at < ?", nowIso(), queueStaleBefore);
  const sending = await all(db, "SELECT id, account_id FROM campaigns WHERE status = 'sending'");
  for (const c of sending) await finalizeIfDone(db, c.account_id, c.id);
}

export { newId };
