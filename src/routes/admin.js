// Read-only operator overview across accounts. Admin accounts are marked only by scripts/admin.mjs.
// Shows counts and health only, never message contents or contact details.
import { Hono } from "hono";
import { all } from "../lib/db.js";

const admin = new Hono();

admin.get("/overview", async (c) => {
  const since = new Date(Date.now() - 7 * 86400 * 1000).toISOString();
  const rows = await all(
    c.env.DB,
    `SELECT a.id, a.name, a.login, a.is_admin, a.created_at,
            (SELECT COUNT(*) FROM contacts ct WHERE ct.account_id = a.id) AS contacts,
            (SELECT COUNT(*) FROM contacts ct WHERE ct.account_id = a.id AND ct.suppressed = 1) AS suppressed,
            (SELECT s.display_number FROM senders s WHERE s.account_id = a.id AND s.status = 'active') AS active_number,
            (SELECT COUNT(*) FROM messages m WHERE m.account_id = a.id AND m.direction = 'outbound' AND m.status IN ('sent','delivered','read') AND m.created_at >= ?) AS sent_7d,
            (SELECT COUNT(*) FROM messages m WHERE m.account_id = a.id AND m.direction = 'outbound' AND m.status = 'failed' AND m.created_at >= ?) AS failed_7d,
            (SELECT COUNT(*) FROM campaigns cp WHERE cp.account_id = a.id AND cp.status IN ('scheduled','sending')) AS active_campaigns
       FROM accounts a ORDER BY a.created_at`,
    since, since,
  );
  return c.json({
    accounts: rows.map((r) => ({
      id: r.id, name: r.name, login: r.login, isAdmin: Boolean(r.is_admin), createdAt: r.created_at,
      contacts: r.contacts, suppressed: r.suppressed, activeNumber: r.active_number,
      sent7d: r.sent_7d, failed7d: r.failed_7d, activeCampaigns: r.active_campaigns,
    })),
  });
});

export default admin;
