import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeGraph, createAccount, login, setupSender, signedWebhook, waPayload, app, template } from "./helpers.js";

let env, graph, a, b;
const PA = "100000000001";
const PB = "200000000002";

beforeEach(async () => {
  env = makeEnv();
  graph = makeGraph();
  globalThis.fetch = graph.fetch;
  await createAccount(env, { login: "a@test.in" });
  await createAccount(env, { login: "b@test.in" });
  a = await login(env, "a@test.in");
  b = await login(env, "b@test.in");
  await setupSender(a, graph, env, { ref: "A1", phoneNumberId: PA, wabaId: "900000001", display: "+91 90000 00001" });
  await setupSender(b, graph, env, { ref: "B1", phoneNumberId: PB, wabaId: "900000002", display: "+91 90000 00002" });
});

const counts = () => env.DB.q("SELECT (SELECT COUNT(*) FROM messages) AS m, (SELECT COUNT(*) FROM contacts) AS c")[0];
const inbound = (pid, from, id, text = "hi") => waPayload(pid, { contacts: [{ wa_id: from, profile: { name: "Ravi" } }], messages: [{ id, from, type: "text", text: { body: text }, timestamp: String(Math.floor(Date.now() / 1000)) }] });

test("GET verify handshake: correct token returns the challenge, wrong token 403", async () => {
  const ok = await app.fetch(new Request("https://sb.test/api/webhook?hub.mode=subscribe&hub.verify_token=verify_test&hub.challenge=12345"), env);
  assert.equal(ok.status, 200);
  assert.equal(await ok.text(), "12345");
  const bad = await app.fetch(new Request("https://sb.test/api/webhook?hub.mode=subscribe&hub.verify_token=nope&hub.challenge=1"), env);
  assert.equal(bad.status, 403);
});

test("a signed payload is processed", async () => {
  const res = await signedWebhook(env, inbound(PA, "919811111111", "wamid.in1"));
  assert.equal(res.status, 200);
  assert.equal(counts().m, 1);
});

test("unsigned or wrongly signed payloads write nothing", async () => {
  const before = counts();
  assert.equal((await signedWebhook(env, inbound(PA, "919811111111", "wamid.x"), { signature: "" })).status, 401);
  assert.equal((await signedWebhook(env, inbound(PA, "919811111111", "wamid.x"), { secret: "wrong_secret" })).status, 401);
  assert.equal((await signedWebhook(env, inbound(PA, "919811111111", "wamid.x"), { signature: "sha256=zz" })).status, 401);
  assert.deepEqual(counts(), before);
});

test("a signature over different bytes is rejected (raw body is what is checked)", async () => {
  const p = inbound(PA, "919811111111", "wamid.y");
  const { computeSignature } = await import("../src/whatsapp/signature.js");
  const sig = `sha256=${await computeSignature(env.META_APP_SECRET, new TextEncoder().encode(JSON.stringify(p, null, 2)))}`;
  assert.equal((await signedWebhook(env, p, { signature: sig })).status, 401);
});

test("inbound messages land only in the account that owns the phone number id", async () => {
  await signedWebhook(env, inbound(PB, "919811111111", "wamid.b1"));
  const rows = env.DB.q("SELECT account_id FROM messages");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].account_id, "acc_btestin");
  assert.equal((await a.get("/api/inbox")).data.conversations.length, 0);
  assert.equal((await b.get("/api/inbox")).data.conversations.length, 1);
});

test("an unknown phone number id writes nothing", async () => {
  const before = counts();
  const res = await signedWebhook(env, inbound("999999999999", "919811111111", "wamid.u"));
  assert.equal(res.status, 200);
  assert.deepEqual(counts(), before);
});

test("Meta's retries of the same message are stored once", async () => {
  const p = inbound(PA, "919811111111", "wamid.dup");
  await signedWebhook(env, p);
  await signedWebhook(env, p);
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM messages WHERE direction='inbound'")[0].n, 1);
});

async function sendOne(client) {
  await signedWebhook(env, inbound(client === a ? PA : PB, "919822222222", `wamid.open_${client === a ? "a" : "b"}`));
  const conv = (await client.get("/api/inbox")).data.conversations[0];
  const r = await client.post(`/api/inbox/${conv.contactId}/reply`, { text: "thanks" });
  assert.equal(r.status, 200);
  return env.DB.q("SELECT wamid, id FROM messages WHERE id = ?", r.data.messageId)[0];
}

test("status updates move a message forward and never backwards", async () => {
  const m = await sendOne(a);
  const status = (s) => waPayload(PA, { statuses: [{ id: m.wamid, status: s, timestamp: "1", recipient_id: "919822222222" }] });
  await signedWebhook(env, status("delivered"));
  await signedWebhook(env, status("read"));
  await signedWebhook(env, status("delivered"));
  assert.equal(env.DB.q("SELECT status FROM messages WHERE id = ?", m.id)[0].status, "read");
});

test("a failed status is recorded with Meta's error", async () => {
  const m = await sendOne(a);
  await signedWebhook(env, waPayload(PA, { statuses: [{ id: m.wamid, status: "failed", errors: [{ code: 131049, title: "Not delivered" }] }] }));
  const row = env.DB.q("SELECT status, error FROM messages WHERE id = ?", m.id)[0];
  assert.equal(row.status, "failed");
  assert.match(row.error, /131049/);
});

test("a status update arriving on another account's number cannot change this account's message", async () => {
  const m = await sendOne(a);
  await signedWebhook(env, waPayload(PB, { statuses: [{ id: m.wamid, status: "failed", errors: [{ code: 1 }] }] }));
  assert.equal(env.DB.q("SELECT status FROM messages WHERE id = ?", m.id)[0].status, "sent");
});

test("opt-out 'stop' suppresses, 'resume' lifts it, scoped to the receiving number's account", async () => {
  // Both accounts know the same person.
  await a.post("/api/contacts", { phone: "9833333333", name: "Same Person" });
  await b.post("/api/contacts", { phone: "9833333333", name: "Same Person" });
  const pref = (value) => waPayload(PA, { user_preferences: [{ wa_id: "919833333333", category: "marketing_messages", value, timestamp: 1 }] });
  await signedWebhook(env, pref("stop"));
  const sup = () => env.DB.q("SELECT account_id, suppressed FROM contacts WHERE phone_e164 = '919833333333' ORDER BY account_id");
  assert.deepEqual(sup().map((r) => r.suppressed), [1, 0]);
  await signedWebhook(env, pref("resume"));
  assert.deepEqual(sup().map((r) => r.suppressed), [0, 0]);
});

test("a 'stop' for an unknown number creates a suppressed contact, so a later import cannot unsuppress it", async () => {
  await signedWebhook(env, waPayload(PA, { user_preferences: [{ wa_id: "919844444444", category: "marketing_messages", value: "stop" }] }));
  await a.post("/api/contacts/import", { rows: [{ phone: "9844444444", name: "Imported" }] });
  const row = env.DB.q("SELECT suppressed FROM contacts WHERE phone_e164 = '919844444444' AND account_id = 'acc_atestin'")[0];
  assert.equal(row.suppressed, 1);
});

test("suppression survives a number switch", async () => {
  await signedWebhook(env, waPayload(PA, { user_preferences: [{ wa_id: "919855555555", category: "marketing_messages", value: "stop" }] }));
  graph.phoneNumbers["100000000009"] = { display_phone_number: "+91 90000 00009", verified_name: "New", waba: "900000009" };
  graph.templates["900000009"] = [template("promo")];
  env.WA_TOKEN_A2 = "tok_A2";
  const add = await a.post("/api/senders", { tokenRef: "A2", phoneNumberId: "100000000009", wabaId: "900000009" });
  await a.post(`/api/senders/${add.data.sender.id}/test`, {});
  assert.equal((await a.post(`/api/senders/${add.data.sender.id}/activate`, {})).status, 200);
  const row = env.DB.q("SELECT suppressed FROM contacts WHERE phone_e164 = '919855555555'")[0];
  assert.equal(row.suppressed, 1);
});
