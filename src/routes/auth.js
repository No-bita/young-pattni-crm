// Login and logout only. There is no signup route: accounts are created with scripts/admin.mjs.
import { Hono } from "hono";
import { one } from "../lib/db.js";
import { verifyPassword } from "../lib/password.js";
import { createSession, destroySession } from "../lib/session.js";
import { readJson, requireAuth, str } from "../lib/http.js";

const auth = new Hono();

// A fixed hash so unknown logins cost the same time as a wrong password.
const DUMMY_HASH = "pbkdf2:100000:00000000000000000000000000000000:0000000000000000000000000000000000000000000000000000000000000000";

auth.post("/login", async (c) => {
  const body = await readJson(c);
  const login = str(body.login, 254).toLowerCase();
  const password = String(body.password ?? "");
  if (!login || !password) return c.json({ error: "Enter your login and password." }, 400);

  const account = await one(c.env.DB, "SELECT id, password_hash FROM accounts WHERE login = ?", login);
  const ok = await verifyPassword(password, account?.password_hash || DUMMY_HASH);
  if (!account || !ok) return c.json({ error: "Login or password is incorrect." }, 401);

  await createSession(c, account.id);
  return c.json({ ok: true });
});

auth.post("/logout", async (c) => {
  await destroySession(c);
  return c.json({ ok: true });
});

auth.get("/me", requireAuth, (c) => {
  const a = c.get("account");
  return c.json({ account: { id: a.id, name: a.name, login: a.login, isAdmin: Boolean(a.is_admin) } });
});

export default auth;
