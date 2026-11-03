// Two synthetic accounts. Account B must never read or write anything of account A's.
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeGraph, createAccount, login, setupSender, signedWebhook, waPayload, drainQueue, template } from "./helpers.js";

let env, graph, a, b, A = {};
const PA = "100000000001";
const PB = "200000000002";

before(async () => {
  env = makeEnv();
  graph = makeGraph();
  globalThis.fetch = graph.fetch;
  await createAccount(env, { login: "a@test.in" });
  await createAccount(env, { login: "b@test.in" });
  a = await login(env, "a@test.in");
  b = await login(env, "b@test.in");
  A.sender = await setupSender(a, graph, env, { ref: "A1", phoneNumberId: PA, wabaId: "900000001", display: "+91 1", templates: [template("plain", { body: "Hello" })] });
  await setupSender(b, graph, env, { ref: "B1", phoneNumberId: PB, wabaId: "900000002", display: "+91 2", templates: [template("plain", { body: "Hello" })] });

  A.contact = (await a.post("/api/contacts", { phone: "9811111111", name: "A's customer" })).data.contact.id;
  await signedWebhook(env, waPayload(PA, { contacts: [{ wa_id: "919811111111" }], messages: [{ id: "wamid.a", from: "919811111111", type: "text", text: { body: "private to A" } }] }));
  A.template = (await a.get("/api/templates")).data.templates[0].id;
  A.campaign = (await a.post("/api/campaigns", { name: "A campaign", templateId: A.template, params: [] })).data.campaign.id;
  await a.put(`/api/campaigns/${A.campaign}/audience`, { contactIds: [A.contact] });
});

test("B's lists never include A's data", async () => {
  for (const path of ["/api/contacts", "/api/campaigns", "/api/senders", "/api/inbox", "/api/templates", "/api/contacts/ids"]) {
    const res = await b.get(path);
    assert.equal(res.status, 200, path);
    const s = JSON.stringify(res.data);
    for (const secret of [A.contact, A.campaign, A.sender, A.template, "private to A", "A's customer", PA]) {
      assert.ok(!s.includes(secret), `${path} leaked ${secret}`);
    }
  }
});

test("B cannot read A's records by id", async () => {
  for (const path of [
    `/api/campaigns/${A.campaign}`, `/api/campaigns/${A.campaign}/preview`, `/api/campaigns/${A.campaign}/recipients`,
    `/api/inbox/${A.contact}`, `/api/senders/${A.sender}/messages`, `/api/senders/${A.sender}/activation-check`, `/api/senders/${A.sender}/test-templates`,
  ]) {
    assert.equal((await b.get(path)).status, 404, path);
  }
});

test("B cannot write to A's records", async () => {
  const snap = () => JSON.stringify(env.DB.q("SELECT * FROM contacts WHERE account_id = 'acc_atestin'")) + JSON.stringify(env.DB.q("SELECT * FROM campaigns WHERE account_id = 'acc_atestin'")) + JSON.stringify(env.DB.q("SELECT * FROM senders WHERE account_id = 'acc_atestin'"));
  const before = snap();
  const sentBefore = graph.sent.length;
  const attempts = [
    b.patch(`/api/contacts/${A.contact}`, { name: "hacked" }),
    b.patch(`/api/campaigns/${A.campaign}`, { name: "hacked" }),
    b.put(`/api/campaigns/${A.campaign}/audience`, { contactIds: [A.contact] }),
    b.post(`/api/campaigns/${A.campaign}/launch`, { confirmCount: 1 }),
    b.post(`/api/campaigns/${A.campaign}/cancel`),
    b.post(`/api/inbox/${A.contact}/reply`, { text: "hi" }),
    b.post(`/api/senders/${A.sender}/test`, {}),
    b.post(`/api/senders/${A.sender}/activate`, {}),
  ];
  for (const res of await Promise.all(attempts)) assert.equal(res.status, 404, JSON.stringify(res.data));
  assert.equal(snap(), before);
  assert.equal(graph.sent.length, sentBefore);
});

test("B cannot put A's contacts into B's own campaign", async () => {
  const tpl = (await b.get("/api/templates")).data.templates[0].id;
  const cmp = (await b.post("/api/campaigns", { name: "B", templateId: tpl, params: [] })).data.campaign.id;
  const res = await b.put(`/api/campaigns/${cmp}/audience`, { contactIds: [A.contact] });
  assert.equal(res.status, 400);
});

test("B cannot use A's template in a campaign", async () => {
  const res = await b.post("/api/campaigns", { name: "B", templateId: A.template, params: [] });
  assert.equal(res.status, 400);
});

test("B cannot register A's phone number id", async () => {
  env.WA_TOKEN_B9 = "tok_B9";
  const res = await b.post("/api/senders", { tokenRef: "B9", phoneNumberId: PA, wabaId: "900000001" });
  assert.equal(res.status, 409);
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM senders WHERE phone_number_id = ?", PA)[0].n, 1);
});

test("a campaign from A sends only with A's number and token, only to A's audience", async () => {
  graph.sent.length = 0;
  await a.post(`/api/campaigns/${A.campaign}/launch`, { confirmCount: 1 });
  await drainQueue(env);
  assert.equal(graph.sent.length, 1);
  assert.equal(graph.sent[0].phoneNumberId, PA);
  assert.equal(graph.sent[0].token, "tok_A1");
  assert.equal(graph.sent[0].body.to, "919811111111");
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM messages WHERE account_id = 'acc_btestin'")[0].n, 0);
});

test("the same phone number in both accounts stays two separate contacts", async () => {
  await b.post("/api/contacts", { phone: "9811111111", name: "B's customer" });
  const rows = env.DB.q("SELECT account_id, name FROM contacts WHERE phone_e164 = '919811111111' ORDER BY account_id");
  assert.deepEqual(rows.map((r) => r.name), ["A's customer", "B's customer"]);
});

test("every account-data table carries account_id (schema audit)", () => {
  const tables = env.DB.q("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").map((r) => r.name);
  for (const t of tables) {
    if (t === "accounts") continue;
    const cols = env.DB.q(`PRAGMA table_info(${t})`).map((c) => c.name);
    assert.ok(cols.includes("account_id"), `${t} has no account_id`);
  }
});
