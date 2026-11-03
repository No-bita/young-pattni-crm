import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeGraph, createAccount, login, Client } from "./helpers.js";
import { hashPassword, verifyPassword } from "../src/lib/password.js";
import { parseArgs, sqlString } from "../scripts/admin.mjs";

let env;
beforeEach(async () => {
  env = makeEnv();
  globalThis.fetch = makeGraph().fetch;
  await createAccount(env, { login: "a@test.in" });
  await createAccount(env, { login: "ops@test.in", admin: true });
});

test("login works with the right password and sets an HttpOnly, SameSite=Strict cookie", async () => {
  const c = new Client(env);
  const res = await c.post("/api/auth/login", { login: "A@test.in", password: "correct horse battery" });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("Set-Cookie");
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  const me = await c.get("/api/auth/me");
  assert.equal(me.data.account.login, "a@test.in");
});

test("wrong password and unknown login get the same 401", async () => {
  const c = new Client(env);
  const a = await c.post("/api/auth/login", { login: "a@test.in", password: "nope" });
  const b = await c.post("/api/auth/login", { login: "ghost@test.in", password: "nope" });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.equal(a.data.error, b.data.error);
});

test("there is no public signup: every signup-style route is rejected and creates nothing", async () => {
  const c = new Client(env);
  for (const path of ["/api/auth/register", "/api/auth/signup", "/api/register", "/api/signup", "/api/accounts"]) {
    const res = await c.post(path, { login: "new@test.in", password: "whatever123456" });
    assert.equal(res.status, 404, path);
  }
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM accounts")[0].n, 2);
});

test("protected routes require a session", async () => {
  const c = new Client(env);
  for (const path of ["/api/contacts", "/api/campaigns", "/api/senders", "/api/inbox", "/api/templates", "/api/admin/overview"]) {
    assert.equal((await c.get(path)).status, 401, path);
  }
});

test("logout ends the session", async () => {
  const c = await login(env, "a@test.in");
  const saved = c.cookie;
  await c.post("/api/auth/logout");
  c.cookie = saved;
  assert.equal((await c.get("/api/contacts")).status, 401);
});

test("password reset (as the admin script does it) ends every existing login", async () => {
  const c1 = await login(env, "a@test.in");
  const c2 = await login(env, "a@test.in");
  // Same SQL the script runs for reset-password.
  await env.DB.prepare("UPDATE accounts SET password_hash = ? WHERE login = ?").bind(await hashPassword("a brand new password"), "a@test.in").run();
  await env.DB.prepare("UPDATE sessions SET revoked_at = ? WHERE account_id = (SELECT id FROM accounts WHERE login = ?) AND revoked_at IS NULL").bind(new Date().toISOString(), "a@test.in").run();
  assert.equal((await c1.get("/api/contacts")).status, 401);
  assert.equal((await c2.get("/api/contacts")).status, 401);
  await login(env, "a@test.in", "a brand new password");
  await assert.rejects(login(env, "a@test.in"));
});

test("an expired session is rejected", async () => {
  const c = await login(env, "a@test.in");
  env.DB.raw.exec("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
  assert.equal((await c.get("/api/contacts")).status, 401);
});

test("admin overview: 404 for normal accounts, counts only for admins", async () => {
  const user = await login(env, "a@test.in");
  assert.equal((await user.get("/api/admin/overview")).status, 404);
  const ops = await login(env, "ops@test.in");
  const res = await ops.get("/api/admin/overview");
  assert.equal(res.status, 200);
  assert.equal(res.data.accounts.length, 2);
  assert.ok(!JSON.stringify(res.data).includes("password"));
});

test("no route lets a user make themselves admin", async () => {
  const c = await login(env, "a@test.in");
  await c.patch("/api/auth/me", { isAdmin: true });
  await c.post("/api/auth/me", { is_admin: 1 });
  assert.equal(env.DB.q("SELECT is_admin FROM accounts WHERE login = 'a@test.in'")[0].is_admin, 0);
});

test("the script's password hash verifies in the app (shared code path)", async () => {
  const h = await hashPassword("script made password");
  assert.ok(await verifyPassword("script made password", h));
  assert.ok(!(await verifyPassword("other", h)));
});

test("admin script argument parsing and SQL quoting", () => {
  assert.deepEqual(parseArgs(["create-account", "--name", "Acme", "--login", "x@y.in", "--admin"]), {
    command: "create-account", opts: { name: "Acme", login: "x@y.in", admin: true },
  });
  assert.equal(sqlString("O'Brien"), "'O''Brien'");
  assert.equal(sqlString("a'); DROP TABLE accounts; --"), "'a''); DROP TABLE accounts; --'");
});
