import { Hono } from "hono";
import { accountId } from "../lib/http.js";
import { one } from "../lib/db.js";
import { getActiveSender } from "../lib/send.js";
import { inspectionGate, claimInspection } from "../lib/template-inspection-gate.js";
import { inspectMetaTemplate, InspectionError } from "../lib/template-inspection.js";

const inspection = new Hono();
const messages = {
  INVALID_CONFIGURATION: "This inspection isn't configured yet. Nothing was sent",
  CREDENTIAL_UNAVAILABLE: "The server couldn't use its saved credential. Nothing was sent",
  META_TIMEOUT: "Meta took too long for this peek. Nothing was sent",
  RESPONSE_TOO_LARGE: "Meta's reply was larger than this inspection allows. Nothing was sent",
  INVALID_RESPONSE: "Meta's reply wasn't the expected template. Nothing was sent",
  META_REQUEST_FAILED: "Meta declined this read. Nothing was sent",
  META_UNAVAILABLE: "Couldn't finish this peek at Meta. Nothing was sent",
  REDIRECT_REFUSED: "Meta pointed this read elsewhere, so we stopped. Nothing was sent",
};
async function scopedTemplate(c) {
  const account = accountId(c);
  const gate = inspectionGate(c.env, account);
  if (!gate) return null;
  const sender = await getActiveSender(c.env.DB, account);
  if (!sender) return null;
  const template = await one(c.env.DB,
    "SELECT id, name, language, meta_template_id FROM templates WHERE id = ? AND account_id = ? AND sender_id = ? AND waba_id = ?",
    gate.templateId, account, sender.id, sender.waba_id);
  if (!template) return null;
  return { gate, sender, template };
}

// Mounted under the existing exact + wildcard /api/templates authentication guards.
inspection.get("/inspection", async (c) => {
  try {
    const scoped = await scopedTemplate(c);
    if (!scoped) return c.json({ enabled: false });
    return c.json({ enabled: true, expiresAt: scoped.gate.expiresAt,
      template: { id: scoped.template.id, name: scoped.template.name, language: scoped.template.language } });
  } catch { return c.json({ enabled: false }); }
});

inspection.post("/:id/inspect", async (c) => {
  // SameSite=Strict session cookies PLUS exact Origin and non-simple custom header.
  // Do not allow a cross-origin form or a credentialed cross-origin fetch to spend a read.
  if (c.req.header("Origin") !== new URL(c.req.url).origin || c.req.header("X-Template-Inspection") !== "1" ||
      (c.req.header("Sec-Fetch-Site") && c.req.header("Sec-Fetch-Site") !== "same-origin")) {
    return c.json({ error: "This peek must start in your CRM tab", code: "ORIGIN_REQUIRED" }, 403);
  }
  let release;
  try {
    const scoped = await scopedTemplate(c);
    if (!scoped || c.req.param("id") !== scoped.template.id) return c.json({ error: "Inspection not available", code: "NOT_AVAILABLE" }, 404);
    release = claimInspection(scoped.gate);
    if (!release) {
      c.header("Retry-After", "60");
      return c.json({ error: "One peek at a time. Give it a minute", code: "INSPECTION_LIMIT" }, 429);
    }
    const result = await inspectMetaTemplate(c.env, scoped.sender, scoped.template.meta_template_id);
    return c.json({ ...result, inspectedAt: new Date().toISOString() });
  } catch (e) {
    const safe = e instanceof InspectionError ? e : new InspectionError("META_UNAVAILABLE");
    return c.json({ error: messages[safe.code] || messages.META_UNAVAILABLE, code: safe.code,
      metaCode: safe.metaCode, metaSubcode: safe.metaSubcode }, safe.status);
  } finally { if (release) release(); }
});

export default inspection;
