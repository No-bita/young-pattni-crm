import inspection from "./template-inspection.js";
import { Hono } from "hono";
import { all } from "../lib/db.js";
import { accountId, readJson, str } from "../lib/http.js";
import { getActiveSender } from "../lib/send.js";
import { syncTemplates, presentTemplate, lookupTemplate } from "../lib/templates.js";

const templates = new Hono();
templates.route("/", inspection);

// Templates of the ACTIVE sender's WABA only.
templates.get("/", async (c) => {
  const sender = await getActiveSender(c.env.DB, accountId(c));
  if (!sender) return c.json({ templates: [], sender: null });
  const rows = await all(c.env.DB, "SELECT * FROM templates WHERE account_id = ? AND sender_id = ? ORDER BY name, language", accountId(c), sender.id);
  return c.json({ templates: rows.map(presentTemplate), sender: { id: sender.id, displayNumber: sender.display_number } });
});

templates.post("/sync", async (c) => {
  const sender = await getActiveSender(c.env.DB, accountId(c));
  if (!sender) return c.json({ error: "Activate a WhatsApp number first." }, 409);
  try {
    const count = await syncTemplates(c.env, sender);
    return c.json({ ok: true, count });
  } catch (e) {
    return c.json({ error: `Could not fetch templates from Meta: ${e.message}` }, 502);
  }
});

// Manual entry: the user types an approved template's exact name and language, and the CRM asks Meta
// for just that template in the active number's Messaging account. It is saved only if Meta has it,
// and the response says plainly whether it can be used and, if not, why.
templates.post("/lookup", async (c) => {
  const sender = await getActiveSender(c.env.DB, accountId(c));
  if (!sender) return c.json({ error: "Activate a WhatsApp number first." }, 409);
  const body = await readJson(c);
  const name = str(body.name, 512);
  const language = str(body.language, 20);
  if (!/^[a-z0-9_]{1,512}$/.test(name)) {
    return c.json({ error: "Enter the template name exactly as in WhatsApp Manager: lowercase letters, numbers and underscores.", code: "BAD_NAME" }, 400);
  }
  if (!/^[a-z]{2,3}(_[A-Z]{2})?$/.test(language)) {
    return c.json({ error: "Enter the language code exactly as in WhatsApp Manager, e.g. en, en_US or hi.", code: "BAD_LANGUAGE" }, 400);
  }
  let row;
  try {
    row = await lookupTemplate(c.env, sender, { name, language });
  } catch (e) {
    return c.json({ error: `Could not look up the template in Meta: ${e.message}` }, 502);
  }
  if (!row) {
    return c.json({
      error: `Meta has no template named "${name}" in language "${language}" in the Messaging account that ${sender.display_number || "the active number"} belongs to. Check the spelling and language code.`,
      code: "NOT_FOUND",
    }, 404);
  }
  return c.json({ template: presentTemplate(row) });
});

export default templates;
