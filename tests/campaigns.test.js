import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeGraph, createAccount, login, setupSender, drainQueue, signedWebhook, waPayload, template, scheduled } from "./helpers.js";

let env, graph, a;
const PA = "100000000001";

beforeEach(async () => {
  env = makeEnv();
  graph = makeGraph();
  globalThis.fetch = graph.fetch;
  await createAccount(env, { login: "a@test.in" });
  a = await login(env, "a@test.in");
  await setupSender(a, graph, env, {
    ref: "A1", phoneNumberId: PA, wabaId: "900000001", display: "+91 90000 00001",
    templates: [template("promo", { body: "Hi {{1}}, {{2}}" }), template("plain", { body: "Hello there" }), template("pending_one", { status: "PENDING" }), template("media", { header: "IMAGE", body: "x" })],
  });
});

async function contacts(n, prefix = "98100000") {
  const rows = Array.from({ length: n }, (_, i) => ({ phone: `${prefix}${String(i).padStart(2, "0")}`, name: i % 2 ? `Name ${i}` : "" }));
  const r = await a.post("/api/contacts/import", { rows });
  assert.equal(r.status, 200);
  return (await a.get("/api/contacts?limit=200")).data.contacts;
}

async function tplId(name) {
  return (await a.get("/api/templates")).data.templates.find((t) => t.name === name).id;
}

async function draft(name = "promo", params = [{ type: "contact_name", fallback: "there" }, { type: "text", value: "sale today" }]) {
  const r = await a.post("/api/campaigns", { name: "Diwali", templateId: await tplId(name), params });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.campaign.id;
}

test("only approved, text-only templates can be used, with exactly the right number of variables", async () => {
  assert.equal((await a.post("/api/campaigns", { name: "x", templateId: await tplId("pending_one"), params: [{ type: "text", value: "v" }] })).status, 400);
  assert.equal((await a.post("/api/campaigns", { name: "x", templateId: await tplId("media"), params: [] })).status, 400);
  assert.equal((await a.post("/api/campaigns", { name: "x", templateId: await tplId("promo"), params: [{ type: "text", value: "v" }] })).status, 400);
  assert.equal((await a.post("/api/campaigns", { name: "x", templateId: await tplId("plain"), params: [] })).status, 201);
});

test("a campaign with no audience cannot launch, and an empty audience is rejected: no path means 'everyone'", async () => {
  await contacts(3);
  const id = await draft();
  const pre = await a.get(`/api/campaigns/${id}/preview`);
  assert.equal(pre.data.audience.chosen, false);
  assert.equal(pre.data.blocker.code, "AUDIENCE_EMPTY");
  assert.equal((await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 3 })).status, 409);
  assert.equal((await a.put(`/api/campaigns/${id}/audience`, { contactIds: [] })).status, 400);
  assert.equal((await a.put(`/api/campaigns/${id}/audience`, {})).status, 400);
  assert.equal(graph.sent.length, 0);
});

test("preview count equals launch count, suppressed contacts are excluded from both and skipped", async () => {
  const list = await contacts(5);
  await signedWebhook(env, waPayload(PA, { user_preferences: [{ wa_id: list[0].phone.slice(1), category: "marketing_messages", value: "stop" }] }));
  const id = await draft();
  await a.put(`/api/campaigns/${id}/audience`, { contactIds: list.map((c) => c.id) });
  const pre = (await a.get(`/api/campaigns/${id}/preview`)).data.audience;
  assert.deepEqual(pre, { chosen: true, selected: 5, suppressed: 1, sendable: 4 });

  assert.equal((await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 5 })).data.code, "AUDIENCE_CHANGED");
  const launch = await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 4 });
  assert.equal(launch.status, 200);
  await drainQueue(env);
  assert.equal(graph.sent.length, 4);
  assert.ok(!graph.sent.some((s) => `+${s.body.to}` === list[0].phone));
  const detail = (await a.get(`/api/campaigns/${id}`)).data.campaign;
  assert.equal(detail.status, "completed");
  assert.deepEqual(detail.recipients, { sent: 4, skipped_suppressed: 1 });
});

test("variables are filled per contact, with the fallback for contacts without a name", async () => {
  const list = await contacts(2);
  const id = await draft();
  await a.put(`/api/campaigns/${id}/audience`, { contactIds: list.map((c) => c.id) });
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 2 });
  await drainQueue(env);
  const texts = graph.sent.map((s) => s.body.template.components[0].parameters.map((p) => p.text)).sort();
  assert.deepEqual(texts, [["Name 1", "sale today"], ["there", "sale today"]]);
});

test("a contact who opts out after launch but before their send is skipped", async () => {
  const list = await contacts(2);
  const id = await draft();
  await a.put(`/api/campaigns/${id}/audience`, { contactIds: list.map((c) => c.id) });
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 2 });
  await signedWebhook(env, waPayload(PA, { user_preferences: [{ wa_id: list[1].phone.slice(1), category: "marketing_messages", value: "stop" }] }));
  await drainQueue(env);
  assert.equal(graph.sent.length, 1);
});

test("the audience cap is enforced", async () => {
  env.MAX_CAMPAIGN_AUDIENCE = "3";
  const list = await contacts(4);
  const id = await draft();
  assert.equal((await a.put(`/api/campaigns/${id}/audience`, { contactIds: list.map((c) => c.id) })).data.code, "OVER_CAP");
});

test("a failed send is reported as failed and no other number is tried", async () => {
  const list = await contacts(1);
  graph.failSendTo.add(list[0].phone.slice(1));
  const id = await draft();
  await a.put(`/api/campaigns/${id}/audience`, { contactIds: [list[0].id] });
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
  await drainQueue(env);
  const sendCalls = graph.calls.filter((c) => c.method === "POST" && c.path.endsWith("/messages"));
  assert.equal(sendCalls.length, 1);
  assert.equal(sendCalls[0].path, `${PA}/messages`);
  const r = (await a.get(`/api/campaigns/${id}/recipients`)).data.recipients[0];
  assert.equal(r.status, "failed");
  assert.match(r.error, /Recipient not valid/);
});

test("a queued recipient is never sent twice (duplicate queue delivery)", async () => {
  const list = await contacts(1);
  const id = await draft();
  await a.put(`/api/campaigns/${id}/audience`, { contactIds: [list[0].id] });
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
  env.CAMPAIGN_QUEUE.sent.push(...env.CAMPAIGN_QUEUE.sent.map((x) => ({ ...x })));
  await drainQueue(env);
  assert.equal(graph.sent.length, 1);
});

test("scheduled campaigns start when due, and cancelling a scheduled campaign sends nothing", async () => {
  const list = await contacts(2);
  const id = await draft();
  await a.put(`/api/campaigns/${id}/audience`, { contactIds: list.map((c) => c.id) });
  const when = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  assert.equal((await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 2, scheduledAt: when })).data.campaign.status, "scheduled");
  await scheduled({}, env);
  assert.equal(env.CAMPAIGN_QUEUE.sent.length, 0);
  env.DB.raw.exec("UPDATE campaigns SET scheduled_at = '2000-01-01T00:00:00.000Z'");
  await scheduled({}, env);
  await drainQueue(env);
  assert.equal(graph.sent.length, 2);

  const id2 = await draft();
  await a.put(`/api/campaigns/${id2}/audience`, { contactIds: [list[0].id] });
  await a.post(`/api/campaigns/${id2}/launch`, { confirmCount: 1, scheduledAt: when });
  await a.post(`/api/campaigns/${id2}/cancel`);
  env.DB.raw.exec(`UPDATE campaigns SET scheduled_at = '2000-01-01T00:00:00.000Z' WHERE id = '${id2}'`);
  await scheduled({}, env);
  await drainQueue(env);
  assert.equal(graph.sent.length, 2);
});

test("a send interrupted mid-flight is settled as failed by the scheduler and never re-sent", async () => {
  const list = await contacts(1);
  const id = await draft();
  await a.put(`/api/campaigns/${id}/audience`, { contactIds: [list[0].id] });
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
  env.CAMPAIGN_QUEUE.sent.splice(0);
  env.DB.raw.exec("UPDATE campaign_recipients SET status = 'sending', updated_at = '2000-01-01T00:00:00.000Z'");
  await scheduled({}, env);
  assert.equal((await a.get(`/api/campaigns/${id}`)).data.campaign.status, "completed");
  assert.equal(graph.sent.length, 0);
});

test("number switch: blocked while a campaign is scheduled or sending", async () => {
  const list = await contacts(1);
  const id = await draft();
  await a.put(`/api/campaigns/${id}/audience`, { contactIds: [list[0].id] });
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1, scheduledAt: new Date(Date.now() + 3600e3).toISOString() });

  graph.phoneNumbers["100000000002"] = { display_phone_number: "+91 2", verified_name: "n", waba: "900000001" };
  env.WA_TOKEN_A2 = "tok_A2";
  const s2 = (await a.post("/api/senders", { tokenRef: "A2", phoneNumberId: "100000000002", wabaId: "900000001" })).data.sender.id;
  await a.post(`/api/senders/${s2}/test`, {});
  const act = await a.post(`/api/senders/${s2}/activate`, {});
  assert.equal(act.status, 409);
  assert.ok(act.data.blockers.some((b) => b.code === "CAMPAIGNS_ACTIVE"));
  await a.post(`/api/campaigns/${id}/cancel`);
  assert.equal((await a.post(`/api/senders/${s2}/activate`, {})).status, 200);
});

test("number switch: refused until tested, and refused when draft templates are missing on the new WABA", async () => {
  await draft("promo");
  graph.phoneNumbers["300000000003"] = { display_phone_number: "+91 3", verified_name: "n", waba: "900000003" };
  graph.templates["900000003"] = [template("other")];
  env.WA_TOKEN_A3 = "tok_A3";
  const s3 = (await a.post("/api/senders", { tokenRef: "A3", phoneNumberId: "300000000003", wabaId: "900000003" })).data.sender.id;
  const untested = await a.post(`/api/senders/${s3}/activate`, {});
  assert.ok(untested.data.blockers.some((b) => b.code === "NOT_TESTED"));
  await a.post(`/api/senders/${s3}/test`, {});
  const res = await a.post(`/api/senders/${s3}/activate`, {});
  assert.equal(res.status, 409);
  const missing = res.data.blockers.find((b) => b.code === "TEMPLATES_MISSING");
  assert.deepEqual(missing.templates.map((t) => t.name), ["promo"]);

  graph.templates["900000003"].push(template("promo", { body: "Hi {{1}}, {{2}}" }));
  assert.equal((await a.post(`/api/senders/${s3}/activate`, {})).status, 200);
});

test("number switch keeps contacts and history; the old number is kept; new sends use only the new number", async () => {
  const list = await contacts(1);
  await signedWebhook(env, waPayload(PA, { contacts: [{ wa_id: list[0].phone.slice(1) }], messages: [{ id: "wamid.in", from: list[0].phone.slice(1), type: "text", text: { body: "hello" } }] }));
  await a.post(`/api/inbox/${list[0].id}/reply`, { text: "via old" });

  graph.phoneNumbers["100000000005"] = { display_phone_number: "+91 5", verified_name: "n", waba: "900000001" };
  env.WA_TOKEN_A5 = "tok_A5";
  const s5 = (await a.post("/api/senders", { tokenRef: "A5", phoneNumberId: "100000000005", wabaId: "900000001" })).data.sender.id;
  await a.post(`/api/senders/${s5}/test`, {});
  await a.post(`/api/senders/${s5}/activate`, {});

  const senders = (await a.get("/api/senders")).data.senders;
  assert.deepEqual(senders.map((s) => s.status).sort(), ["active", "inactive"]);
  assert.equal((await a.get("/api/contacts")).data.total, 1);
  const thread = (await a.get(`/api/inbox/${list[0].id}`)).data.messages;
  assert.equal(thread.length, 2);

  await a.post(`/api/inbox/${list[0].id}/reply`, { text: "via new" });
  const last = graph.sent.at(-1);
  assert.equal(last.phoneNumberId, "100000000005");
  assert.equal(last.token, "tok_A5");
});

test("a sender cannot be added when its token secret is missing at test time, and the test reports it", async () => {
  graph.phoneNumbers["100000000006"] = { display_phone_number: "+91 6", verified_name: "n", waba: "900000001" };
  const s = (await a.post("/api/senders", { tokenRef: "NOPE", phoneNumberId: "100000000006", wabaId: "900000001" })).data.sender.id;
  const t = await a.post(`/api/senders/${s}/test`, {});
  assert.equal(t.data.ok, false);
  assert.match(t.data.error, /WA_TOKEN_NOPE/);
});

test("a phone number id outside the given WABA fails the test", async () => {
  graph.phoneNumbers["100000000007"] = { display_phone_number: "+91 7", verified_name: "n", waba: "OTHER" };
  env.WA_TOKEN_A7 = "tok_A7";
  const s = (await a.post("/api/senders", { tokenRef: "A7", phoneNumberId: "100000000007", wabaId: "900000001" })).data.sender.id;
  const t = await a.post(`/api/senders/${s}/test`, {});
  assert.equal(t.data.ok, false);
  assert.match(t.data.error, /does not belong/);
});

test("inbox reply: only within 24h of the contact's last message; suppressed contacts cannot be messaged", async () => {
  const list = await contacts(2);
  const closed = await a.post(`/api/inbox/${list[0].id}/reply`, { text: "hi" });
  assert.equal(closed.data.code, "WINDOW_CLOSED");
  const from = list[0].phone.slice(1);
  await signedWebhook(env, waPayload(PA, { contacts: [{ wa_id: from }], messages: [{ id: "wamid.w", from, type: "text", text: { body: "yo" } }] }));
  assert.equal((await a.post(`/api/inbox/${list[0].id}/reply`, { text: "hi" })).status, 200);
  env.DB.raw.exec(`UPDATE contacts SET last_inbound_at = '${new Date(Date.now() - 25 * 3600e3).toISOString()}' WHERE id = '${list[0].id}'`);
  assert.equal((await a.post(`/api/inbox/${list[0].id}/reply`, { text: "hi" })).data.code, "WINDOW_CLOSED");

  env.DB.raw.exec(`UPDATE contacts SET suppressed = 1, last_inbound_at = '${new Date().toISOString()}' WHERE id = '${list[1].id}'`);
  assert.equal((await a.post(`/api/inbox/${list[1].id}/reply`, { text: "hi" })).data.code, "SUPPRESSED");
});

test("the sender test message respects suppression", async () => {
  const list = await contacts(1);
  env.DB.raw.exec(`UPDATE contacts SET suppressed = 1 WHERE id = '${list[0].id}'`);
  const sid = (await a.get("/api/senders")).data.senders[0].id;
  const t = await a.post(`/api/senders/${sid}/test`, { testPhone: list[0].phone, templateId: await tplId("plain") });
  assert.equal(t.data.ok, false);
  assert.match(t.data.error, /opted out/);
  assert.equal(graph.sent.length, 0);
});

test("contact import: validates numbers, de-duplicates, never changes suppression", async () => {
  const r = await a.post("/api/contacts/import", { rows: [{ phone: "9876543210", name: "A" }, { phone: "+91 98765 43210", name: "A2" }, { phone: "12", name: "bad" }, { phone: "+44 7700 900123", name: "UK" }] });
  assert.equal(r.data.created, 2);
  assert.equal(r.data.invalid.length, 1);
  assert.equal(r.data.duplicatesInFile, 1);
  const phones = (await a.get("/api/contacts")).data.contacts.map((c) => c.phone).sort();
  assert.deepEqual(phones, ["+447700900123", "+919876543210"]);
});

test("a network failure reaching Meta is reported as failed in plain words, never silently retried", async () => {
  const list = await contacts(1);
  const id = await draft();
  await a.put(`/api/campaigns/${id}/audience`, { contactIds: [list[0].id] });
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError("network down"); };
  await drainQueue(env);
  globalThis.fetch = real;
  assert.equal(calls, 1);
  const r = (await a.get(`/api/campaigns/${id}/recipients`)).data.recipients[0];
  assert.equal(r.status, "failed");
  assert.match(r.error, /Could not reach Meta/);
});
