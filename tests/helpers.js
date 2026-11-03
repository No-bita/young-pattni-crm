// Test harness: the real Hono app + a D1-compatible shim over node:sqlite with the real migration,
// a fake Meta Graph API, and a manual queue. No network is ever used.
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { app, queue, scheduled } from "../src/index.js";
import { hashPassword } from "../src/lib/password.js";
import { computeSignature } from "../src/whatsapp/signature.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

class Stmt {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }
  bind(...args) {
    return new Stmt(this.db, this.sql, args.map((a) => (a === undefined ? null : typeof a === "boolean" ? Number(a) : a)));
  }
  async first(col) {
    const row = this.db.prepare(this.sql).get(...this.args);
    if (!row) return null;
    return col ? row[col] : { ...row };
  }
  async all() {
    return { results: this.db.prepare(this.sql).all(...this.args).map((r) => ({ ...r })), success: true };
  }
  async run() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  runSync() {
    const r = this.db.prepare(this.sql).run(...this.args);
    return { success: true, meta: { changes: Number(r.changes) } };
  }
}

export class D1Shim {
  constructor() {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    for (const f of readdirSync(join(root, "migrations")).sort()) {
      this.raw.exec(readFileSync(join(root, "migrations", f), "utf8"));
    }
  }
  prepare(sql) {
    return new Stmt(this.raw, sql);
  }
  async batch(stmts) {
    this.raw.exec("BEGIN");
    try {
      const out = stmts.map((s) => (/^\s*select/i.test(s.sql) ? { results: s.db.prepare(s.sql).all(...s.args) } : s.runSync()));
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }
  q(sql, ...args) {
    return this.raw.prepare(sql).all(...args);
  }
}

// Fake Graph API. Configure per test via graph.* fields.
export function makeGraph() {
  const g = {
    calls: [],
    sent: [],
    phoneNumbers: {},   // phone_number_id -> { display_phone_number, verified_name, waba }
    templates: {},      // waba_id -> [template]
    failSendTo: new Set(),
    tokenOk: (token) => token.startsWith("tok_"),
  };
  g.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const parts = u.pathname.split("/").filter(Boolean).slice(1); // drop version
    const token = String(init.headers?.Authorization || "").replace("Bearer ", "");
    g.calls.push({ method: init.method || "GET", path: parts.join("/"), token });
    const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
    if (u.hostname !== "graph.facebook.com") throw new Error(`unexpected network call to ${u.hostname}`);
    if (!g.tokenOk(token)) return json(401, { error: { message: "Invalid OAuth access token.", code: 190 } });

    const [id, edge] = parts;
    if (!edge && (init.method || "GET") === "GET") {
      const p = g.phoneNumbers[id];
      return p ? json(200, { id, display_phone_number: p.display_phone_number, verified_name: p.verified_name }) : json(404, { error: { message: "Unsupported get request.", code: 100 } });
    }
    if (edge === "phone_numbers") {
      return json(200, { data: Object.entries(g.phoneNumbers).filter(([, p]) => p.waba === id).map(([pid, p]) => ({ id: pid, display_phone_number: p.display_phone_number })) });
    }
    if (edge === "message_templates") return json(200, { data: g.templates[id] || [] });
    if (edge === "messages" && init.method === "POST") {
      const body = JSON.parse(init.body);
      if (!g.phoneNumbers[id]) return json(400, { error: { message: "Invalid phone number id", code: 100 } });
      if (g.failSendTo.has(body.to)) return json(400, { error: { message: "Recipient not valid", code: 131026 } });
      const wamid = `wamid.${g.sent.length + 1}_${Math.random().toString(36).slice(2, 8)}`;
      g.sent.push({ phoneNumberId: id, token, body, wamid });
      return json(200, { messaging_product: "whatsapp", messages: [{ id: wamid }] });
    }
    return json(404, { error: { message: "not mocked" } });
  };
  return g;
}

export function template(name, { status = "APPROVED", language = "en", body = "Hello {{1}}", header } = {}) {
  const components = [{ type: "BODY", text: body }];
  if (header) components.unshift({ type: "HEADER", format: header });
  return { id: `mt_${name}`, name, language, status, category: "MARKETING", components };
}

export function makeEnv(extra = {}) {
  const sentToQueue = [];
  const env = {
    DB: new D1Shim(),
    META_APP_SECRET: "app_secret_test",
    META_VERIFY_TOKEN: "verify_test",
    GRAPH_API_VERSION: "v23.0",
    MAX_CAMPAIGN_AUDIENCE: "1000",
    SEND_INTERVAL_MS: "0",
    CAMPAIGN_QUEUE: {
      sent: sentToQueue,
      async send(body) { sentToQueue.push(body); },
      async sendBatch(msgs) { for (const m of msgs) sentToQueue.push(m.body); },
    },
    ...extra,
  };
  return env;
}

export class Client {
  constructor(env) {
    this.env = env;
    this.cookie = null;
  }
  async req(method, path, body, headers = {}) {
    const init = { method, headers: { ...headers } };
    if (this.cookie) init.headers.Cookie = this.cookie;
    if (body !== undefined) {
      init.headers["Content-Type"] = "application/json";
      init.body = typeof body === "string" ? body : JSON.stringify(body);
    }
    const res = await app.fetch(new Request(`https://sb.test${path}`, init), this.env, { waitUntil() {}, passThroughOnException() {} });
    const set = res.headers.get("Set-Cookie");
    if (set) {
      const m = /sb_session=([^;]*)/.exec(set);
      if (m) this.cookie = m[1] ? `sb_session=${m[1]}` : null;
    }
    const text = await res.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { status: res.status, data, headers: res.headers };
  }
  get(p) { return this.req("GET", p); }
  post(p, b = {}) { return this.req("POST", p, b); }
  put(p, b = {}) { return this.req("PUT", p, b); }
  patch(p, b = {}) { return this.req("PATCH", p, b); }
}

export async function createAccount(env, { login, name = login, password = "correct horse battery", admin = false }) {
  const id = `acc_${login.replace(/\W/g, "")}`;
  await env.DB.prepare("INSERT INTO accounts (id, name, login, password_hash, is_admin) VALUES (?, ?, ?, ?, ?)")
    .bind(id, name, login, await hashPassword(password), admin ? 1 : 0).run();
  return id;
}

export async function login(env, loginName, password = "correct horse battery") {
  const c = new Client(env);
  const res = await c.post("/api/auth/login", { login: loginName, password });
  if (res.status !== 200) throw new Error(`login failed: ${JSON.stringify(res.data)}`);
  return c;
}

// Adds, tests and activates a sender for a logged-in client.
export async function setupSender(client, graph, env, { ref, phoneNumberId, wabaId, display, templates = [template("promo")] }) {
  graph.phoneNumbers[phoneNumberId] = { display_phone_number: display, verified_name: `Biz ${ref}`, waba: wabaId };
  graph.templates[wabaId] = templates;
  env[`WA_TOKEN_${ref}`] = `tok_${ref}`;
  const add = await client.post("/api/senders", { tokenRef: ref, phoneNumberId, wabaId });
  if (add.status !== 201) throw new Error(`add sender failed: ${JSON.stringify(add.data)}`);
  const id = add.data.sender.id;
  const t = await client.post(`/api/senders/${id}/test`, {});
  if (!t.data.ok) throw new Error(`test failed: ${JSON.stringify(t.data)}`);
  const a = await client.post(`/api/senders/${id}/activate`, {});
  if (a.status !== 200) throw new Error(`activate failed: ${JSON.stringify(a.data)}`);
  return id;
}

export async function drainQueue(env) {
  while (env.CAMPAIGN_QUEUE.sent.length) {
    const items = env.CAMPAIGN_QUEUE.sent.splice(0);
    await queue({ messages: items.map((body) => ({ body, ack() {}, retry() {} })) }, env);
  }
}

export async function signedWebhook(env, payload, { secret = env.META_APP_SECRET, signature } = {}) {
  const raw = JSON.stringify(payload);
  const sig = signature ?? `sha256=${await computeSignature(secret, new TextEncoder().encode(raw))}`;
  const res = await app.fetch(new Request("https://sb.test/api/webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(sig ? { "X-Hub-Signature-256": sig } : {}) },
    body: raw,
  }), env, {});
  return { status: res.status, text: await res.text() };
}

export function waPayload(phoneNumberId, value) {
  return {
    object: "whatsapp_business_account",
    entry: [{ id: "WABA", changes: [{ field: value.user_preferences ? "user_preferences" : "messages", value: { messaging_product: "whatsapp", metadata: { display_phone_number: "x", phone_number_id: phoneNumberId }, ...value } }] }],
  };
}

export { scheduled, queue, app };
