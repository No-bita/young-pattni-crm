import { Hono } from "hono";
import { HttpError, requireAuth, requireAdmin } from "./lib/http.js";
import auth from "./routes/auth.js";
import contacts from "./routes/contacts.js";
import templates from "./routes/templates.js";
import senders from "./routes/senders.js";
import campaigns from "./routes/campaigns.js";
import inbox from "./routes/inbox.js";
import webhook from "./routes/webhook.js";
import admin from "./routes/admin.js";
import media from "./routes/media.js";
import { processRecipient, runScheduler, finalizeIfDone } from "./lib/campaigns.js";
import { one } from "./lib/db.js";

export const app = new Hono();

app.use("/api/*", async (c, next) => {
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
});

app.get("/api/health", (c) => c.json({ ok: true }));
app.route("/api/webhook", webhook);       // public, signature-checked
app.route("/api/auth", auth);             // login / logout / me. No signup route exists.

app.use("/api/contacts/*", requireAuth);
app.use("/api/templates/*", requireAuth);
app.use("/api/senders/*", requireAuth);
app.use("/api/campaigns/*", requireAuth);
app.use("/api/inbox/*", requireAuth);
app.use("/api/media/*", requireAuth);
app.use("/api/admin/*", requireAuth, requireAdmin);
for (const p of ["/api/contacts", "/api/templates", "/api/senders", "/api/campaigns", "/api/inbox", "/api/media"]) app.use(p, requireAuth);

app.route("/api/contacts", contacts);
app.route("/api/templates", templates);
app.route("/api/senders", senders);
app.route("/api/campaigns", campaigns);
app.route("/api/inbox", inbox);
app.route("/api/admin", admin);
app.route("/api/media", media);

app.all("/api/*", (c) => c.json({ error: "Not found." }, 404));
app.all("*", (c) => (c.env.ASSETS ? c.env.ASSETS.fetch(c.req.raw) : c.text("Not found", 404)));

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message, code: err.code }, err.status);
  console.error("[api] unhandled error", err);
  return c.json({ error: "Something went wrong. Nothing was sent; try again." }, 500);
});

const interval = (env) => Math.max(0, Number.parseInt(env.SEND_INTERVAL_MS, 10) || 0);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function queue(batch, env) {
  const touched = new Map();
  for (const msg of batch.messages) {
    const { recipientId, accountId } = msg.body || {};
    if (!recipientId || !accountId) {
      msg.ack();
      continue;
    }
    try {
      await processRecipient(env, { recipientId, accountId });
      msg.ack();
    } catch (err) {
      console.error("[queue] recipient processing error", err);
      msg.ack(); // claim already moved it out of 'queued'; the scheduler settles it without re-sending
    }
    const r = await one(env.DB, "SELECT campaign_id FROM campaign_recipients WHERE id = ? AND account_id = ?", recipientId, accountId);
    if (r) touched.set(r.campaign_id, accountId);
    if (interval(env)) await sleep(interval(env));
  }
  for (const [campaignId, accountId] of touched) await finalizeIfDone(env.DB, accountId, campaignId);
}

export async function scheduled(_event, env) {
  await runScheduler(env);
}

export default { fetch: app.fetch, queue, scheduled };
