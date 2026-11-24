import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeGraph, createAccount, login, setupSender, signedWebhook, waPayload, drainQueue, scheduled } from "./helpers.js";
import { makeR2 } from "./fake-r2.js";
import { jpeg } from "./fixtures.js";

const PA = "100000000001";
const FROM = "919811111111";
let env, graph, client, r2;
beforeEach(async () => {
  r2 = makeR2();
  env = makeEnv({ MEDIA_BUCKET: r2 });
  graph = makeGraph();
  globalThis.fetch = graph.fetch;
  await createAccount(env, { login: "a@test.in" });
  client = await login(env, "a@test.in");
  await setupSender(client, graph, env, { ref: "A1", phoneNumberId: PA, wabaId: "900000001", display: "+91 1" });
});

// One transient DB failure after the incoming message has already been saved.
function failNextWrite(fragment) {
  const prepare = env.DB.prepare.bind(env.DB);
  let failed = false;
  env.DB.prepare = (sql) => {
    const stmt = prepare(sql);
    if (sql.includes(fragment)) {
      const bind = stmt.bind.bind(stmt);
      stmt.bind = (...args) => {
        const bound = bind(...args);
        const run = bound.run.bind(bound);
        bound.run = async () => {
          if (!failed) { failed = true; throw new Error("Simulated transient DB failure"); }
          return run();
        };
        return bound;
      };
    }
    return stmt;
  };
}
function incoming({ media = false, id = "wamid.recover", seconds = Math.floor(Date.now() / 1000) } = {}) {
  const msg = { id, from: FROM, timestamp: String(seconds), type: "text", text: { body: "hello" } };
  if (media) {
    graph.media.incoming_photo = { phoneNumberId: PA, type: "image/jpeg", bytes: jpeg(), token: "tok_A1" };
    Object.assign(msg, { type: "image", image: { id: "incoming_photo", mime_type: "image/jpeg", caption: "hello" } });
  }
  return waPayload(PA, { contacts: [{ wa_id: FROM, profile: { name: "Ravi" } }], messages: [msg] });
}
async function expectRecovered() {
  const list = (await client.get("/api/inbox")).data.conversations;
  assert.equal(list.length, 1);
  assert.equal(list[0].windowOpen, true);
  const contact = env.DB.q("SELECT * FROM contacts WHERE phone_e164 = ?", FROM)[0];
  assert.ok(contact.last_inbound_at);
  assert.ok(contact.last_message_at);
  const msgs = env.DB.q("SELECT * FROM messages WHERE direction = 'inbound'");
  assert.equal(msgs.length, 1);
  assert.equal(contact.last_inbound_at, msgs[0].created_at);
  assert.equal((await client.post(`/api/inbox/${contact.id}/reply`, { text: "thanks" })).status, 200);
}

test("a duplicate webhook repairs contact state after its first timestamp write failed", async () => {
  failNextWrite("UPDATE contacts SET last_inbound_at");
  const payload = incoming();
  assert.equal((await signedWebhook(env, payload)).status, 500);
  assert.equal(env.DB.q("SELECT COUNT(*) n FROM messages")[0].n, 1);
  assert.equal((await client.get("/api/inbox")).data.conversations.length, 0);
  assert.equal((await signedWebhook(env, payload)).status, 200);
  await expectRecovered();
});

for (const point of ["INSERT INTO inbound_media", "UPDATE contacts SET last_inbound_at"]) {
  test(`a photo retry repairs bookkeeping after failure at ${point}`, async () => {
    failNextWrite(point);
    const payload = incoming({ media: true });
    assert.equal((await signedWebhook(env, payload)).status, 500);
    assert.equal((await signedWebhook(env, payload)).status, 200);
    assert.equal((await signedWebhook(env, payload)).status, 200);
    await expectRecovered();
    assert.equal(env.DB.q("SELECT COUNT(*) n FROM inbound_media")[0].n, 1);
    assert.equal(env.CAMPAIGN_QUEUE.sent.filter((m) => m.type === "inbound_media").length, 1);
    await drainQueue(env);
    const row = env.DB.q("SELECT * FROM inbound_media")[0];
    assert.equal(row.status, "stored");
    assert.equal(r2.puts, 1);
    assert.equal((await signedWebhook(env, payload)).status, 200);
    assert.equal(env.CAMPAIGN_QUEUE.sent.length, 0);
    assert.equal(env.DB.q("SELECT status FROM inbound_media")[0].status, "stored");
  });
}

test("a retry cannot move newer contact timestamps backwards", async () => {
  const older = incoming({ seconds: Math.floor(Date.now() / 1000) - 120 });
  await signedWebhook(env, older);
  await signedWebhook(env, incoming({ id: "wamid.newer" }));
  const before = env.DB.q("SELECT last_inbound_at, last_message_at FROM contacts")[0];
  await signedWebhook(env, older);
  assert.deepEqual(env.DB.q("SELECT last_inbound_at, last_message_at FROM contacts")[0], before);
});

test("a lost media queue send is recovered by the scheduler without duplicate media rows", async () => {
  const send = env.CAMPAIGN_QUEUE.send;
  env.CAMPAIGN_QUEUE.send = async () => { throw new Error("Queue unavailable"); };
  const payload = incoming({ media: true });
  assert.equal((await signedWebhook(env, payload)).status, 200);
  assert.equal((await signedWebhook(env, payload)).status, 200);
  env.CAMPAIGN_QUEUE.send = send;
  await scheduled(null, env);
  assert.equal(env.CAMPAIGN_QUEUE.sent.length, 0);
  env.DB.raw.prepare("UPDATE inbound_media SET updated_at = ?").run(new Date(Date.now() - 180000).toISOString());
  await scheduled(null, env);
  await drainQueue(env);
  assert.equal(env.DB.q("SELECT COUNT(*) n FROM inbound_media")[0].n, 1);
  assert.equal(env.DB.q("SELECT status FROM inbound_media")[0].status, "stored");
  assert.equal(r2.puts, 1);
});
