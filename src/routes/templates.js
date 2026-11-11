import inspection from "./template-inspection.js";
import { Hono } from "hono";
import { all } from "../lib/db.js";
import { accountId } from "../lib/http.js";
import { getActiveSender } from "../lib/send.js";
import { syncTemplates, presentTemplate } from "../lib/templates.js";

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

export default templates;
