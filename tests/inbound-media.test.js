// Incoming photos and voice notes: caption fix, background download, private storage, serving.
// Meta and R2 are local fakes; nothing here proves live behaviour.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { makeEnv, makeGraph, createAccount, login, setupSender, signedWebhook, waPayload, drainQueue, scheduled, app } from "./helpers.js";
import { makeR2 } from "./fake-r2.js";
import { png, jpeg, textFile } from "./fixtures.js";
import { parseWebhook } from "../src/whatsapp/parse.js";
import { processInboundMedia, shaMatches, sniffInbound } from "../src/lib/inbound-media.js";

const PA = "100000000001";
const PB = "200000000002";
let env, graph, r2, a, b;

const ogg = () => new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, ...new Array(200).fill(7)]);
const hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

beforeEach(async () => {
  r2 = makeR2();
  env = makeEnv({ MEDIA_BUCKET: r2 });
  graph = makeGraph();
  globalThis.fetch = graph.fetch;
  await createAccount(env, { login: "a@test.in" });
  await createAccount(env, { login: "b@test.in" });
  a = await login(env, "a@test.in");
  b = await login(env, "b@test.in");
  await setupSender(a, graph, env, { ref: "A1", phoneNumberId: PA, wabaId: "900000001", display: "+91 1" });
  await setupSender(b, graph, env, { ref: "B1", phoneNumberId: PB, wabaId: "900000002", display: "+91 2" });
});

// Puts a file "on Meta" as if received through phone number `pid`, and returns the webhook message.
function received(pid, { type, bytes, mime, caption, voice, from = "919811111111", wamid = `wamid.in_${Math.random().toString(36).slice(2)}`, sha } = {}) {
  const mediaId = `in_${Math.random().toString(36).slice(2)}`;
  const token = pid === PA ? "tok_A1" : "tok_B1";
  graph.media[mediaId] = { phoneNumberId: pid, type: mime, bytes, token };
  const obj = { id: mediaId, mime_type: mime, sha256: sha ?? hex(bytes), url: "https://lookaside.fbsbx.com/IGNORED" };
  if (caption !== undefined) obj.caption = caption;
  if (voice !== undefined) obj.voice = voice;
  return { mediaId, payload: waPayload(pid, { contacts: [{ wa_id: from, profile: { name: "Riya" } }], messages: [{ id: wamid, from, timestamp: String(Math.floor(Date.now() / 1000)), type, [type]: obj }] }) };
}

const thread = async (client, phone = "919811111111") => {
  const cid = env.DB.q("SELECT id FROM contacts WHERE phone_e164 = ? AND account_id = ?", phone, client === a ? "acc_atestin" : "acc_btestin")[0].id;
  return (await client.get(`/api/inbox/${cid}`)).data.messages;
};

// ---------- caption fix and parsing ----------

test("image captions are read from message.image.caption (they were lost before)", () => {
  const ev = parseWebhook(waPayload(PA, { messages: [{ id: "w1", from: "919800000001", type: "image", image: { id: "m1", mime_type: "image/jpeg", sha256: "x", caption: "Is this the venue?" } }] }));
  assert.equal(ev.messages[0].text, "Is this the venue?");
  assert.deepEqual(ev.messages[0].media, { kind: "image", metaMediaId: "m1", mimeType: "image/jpeg", sha256: "x", voice: false });
  const noCap = parseWebhook(waPayload(PA, { messages: [{ id: "w2", from: "919800000001", type: "image", image: { id: "m2" } }] }));
  assert.equal(noCap.messages[0].text, "[image]");
  const legacy = parseWebhook(waPayload(PA, { messages: [{ id: "w3", from: "919800000001", type: "image", caption: "top-level", image: { id: "m3" } }] }));
  assert.equal(legacy.messages[0].text, "[image]", "a top-level caption is not where Meta puts it");
});

test("audio: voice notes and audio files are told apart; the url field is ignored", () => {
  const v = parseWebhook(waPayload(PA, { messages: [{ id: "w4", from: "919800000001", type: "audio", audio: { id: "m4", mime_type: "audio/ogg; codecs=opus", voice: true, url: "https://x" } }] }));
  assert.equal(v.messages[0].text, "[voice note]");
  assert.equal(v.messages[0].media.voice, true);
  assert.ok(!JSON.stringify(v.messages[0].media).includes("https://x"));
  const f = parseWebhook(waPayload(PA, { messages: [{ id: "w5", from: "919800000001", type: "audio", audio: { id: "m5", voice: false } }] }));
  assert.equal(f.messages[0].text, "[audio]");
  assert.equal(f.messages[0].media.voice, false);
  const vid = parseWebhook(waPayload(PA, { messages: [{ id: "w6", from: "919800000001", type: "video", video: { id: "m6", caption: "clip" } }] }));
  assert.equal(vid.messages[0].text, "clip");
  assert.equal(vid.messages[0].media, null, "only images and audio are stored");
});

// ---------- download and storage ----------

test("a photo is recorded by the webhook, downloaded in the background, stored privately and shown", async () => {
  const bytes = jpeg();
  const { mediaId, payload } = received(PA, { type: "image", bytes, mime: "image/jpeg", caption: "Venue?" });
  const callsBefore = graph.calls.length;
  assert.equal((await signedWebhook(env, payload)).status, 200);
  assert.ok(!graph.calls.slice(callsBefore).some((c) => c.path.startsWith(mediaId)), "the webhook itself never downloads");
  assert.deepEqual(env.CAMPAIGN_QUEUE.sent.map((m) => m.type), ["inbound_media"]);

  await drainQueue(env);
  const row = env.DB.q("SELECT * FROM inbound_media")[0];
  assert.equal(row.status, "stored");
  assert.equal(row.r2_key, `inbound/acc_atestin/${row.id}`);
  assert.equal(row.stored_mime_type, "image/jpeg");
  assert.equal(row.sha256_matches_meta, 1);
  assert.deepEqual(r2.objects.get(row.r2_key).bytes, bytes);

  const msgs = await thread(a);
  assert.equal(msgs[0].body, "Venue?");
  assert.deepEqual(msgs[0].inboundMedia, { id: row.id, kind: "image", voice: false, status: "stored", mimeType: "image/jpeg", byteSize: bytes.length, error: null, url: `/api/inbound-media/${row.id}` });
  assert.ok(!JSON.stringify(msgs).includes(mediaId), "Meta's media id is not exposed");

  const res = await a.raw(msgs[0].inboundMedia.url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/jpeg");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
});

test("a voice note is stored with its voice flag and can be played with byte ranges (iPhone Safari)", async () => {
  const bytes = ogg();
  const { payload } = received(PA, { type: "audio", bytes, mime: "audio/ogg; codecs=opus", voice: true });
  await signedWebhook(env, payload);
  await drainQueue(env);
  const m = (await thread(a))[0];
  assert.equal(m.inboundMedia.kind, "audio");
  assert.equal(m.inboundMedia.voice, true);
  assert.equal(m.inboundMedia.mimeType, "audio/ogg");
  const ranged = await app.fetch(new Request(`https://sb.test${m.inboundMedia.url}`, { headers: { Cookie: a.cookie, Range: "bytes=0-9" } }), env, {});
  assert.equal(ranged.status, 206);
  assert.equal(ranged.headers.get("Content-Range"), `bytes 0-9/${bytes.length}`);
  assert.deepEqual(new Uint8Array(await ranged.arrayBuffer()), bytes.subarray(0, 10));
  const suffix = await app.fetch(new Request(`https://sb.test${m.inboundMedia.url}`, { headers: { Cookie: a.cookie, Range: "bytes=-5" } }), env, {});
  assert.deepEqual(new Uint8Array(await suffix.arrayBuffer()), bytes.subarray(bytes.length - 5));
  const bad = await app.fetch(new Request(`https://sb.test${m.inboundMedia.url}`, { headers: { Cookie: a.cookie, Range: "bytes=999999-" } }), env, {});
  assert.equal(bad.status, 416);
});

test("stored media is account-scoped: another account can't read it, and it isn't public", async () => {
  const { payload } = received(PA, { type: "image", bytes: jpeg(), mime: "image/jpeg" });
  await signedWebhook(env, payload);
  await drainQueue(env);
  const id = env.DB.q("SELECT id FROM inbound_media")[0].id;
  assert.equal((await b.raw(`/api/inbound-media/${id}`)).status, 404);
  const anon = new (a.constructor)(env);
  assert.equal((await anon.raw(`/api/inbound-media/${id}`)).status, 401);
});

test("media received on B's number is downloaded with B's token and stored under B", async () => {
  const { payload } = received(PB, { type: "image", bytes: png(), mime: "image/png" });
  await signedWebhook(env, payload);
  await drainQueue(env);
  const row = env.DB.q("SELECT * FROM inbound_media")[0];
  assert.equal(row.account_id, "acc_btestin");
  assert.equal(row.status, "stored");
  assert.ok(row.r2_key.startsWith("inbound/acc_btestin/"));
});

test("Meta's retries of the same message create one media row and one download", async () => {
  const { payload } = received(PA, { type: "image", bytes: jpeg(), mime: "image/jpeg" });
  await signedWebhook(env, payload);
  await signedWebhook(env, payload);
  await drainQueue(env);
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM inbound_media")[0].n, 1);
  assert.equal(r2.puts, 1);
});

test("files whose bytes aren't a supported image/audio format are not stored", async () => {
  const { payload } = received(PA, { type: "image", bytes: textFile(), mime: "image/jpeg" });
  await signedWebhook(env, payload);
  await drainQueue(env);
  const row = env.DB.q("SELECT * FROM inbound_media")[0];
  assert.equal(row.status, "failed");
  assert.match(row.error, /not a supported image format/);
  assert.equal(r2.puts, 0);
  const m = (await thread(a))[0];
  assert.equal(m.inboundMedia.url, null);
  assert.match(m.inboundMedia.error, /not a supported/);
  assert.equal((await a.raw(`/api/inbound-media/${row.id}`)).status, 409);
});

test("oversize downloads stop at the cap and are not stored", async () => {
  const { payload } = received(PA, { type: "image", bytes: jpeg(), mime: "image/jpeg" });
  graph.downloadMode = "huge";
  await signedWebhook(env, payload);
  await drainQueue(env);
  const row = env.DB.q("SELECT * FROM inbound_media")[0];
  assert.equal(row.status, "failed");
  assert.match(row.error, /5 MB limit/);
  assert.ok(graph.hugeBytesServed <= 5 * 1024 * 1024 + 4 * 65536);
});

test("transient failures retry up to 3 attempts, then fail; a later success stores it", async () => {
  const { payload } = received(PA, { type: "image", bytes: jpeg(), mime: "image/jpeg" });
  await signedWebhook(env, payload);
  const [msg] = env.CAMPAIGN_QUEUE.sent.splice(0);
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("network down"); };
  assert.equal(await processInboundMedia(env, msg), "retry");
  assert.equal(await processInboundMedia(env, msg), "retry");
  assert.equal(await processInboundMedia(env, msg), "failed");
  globalThis.fetch = real;
  assert.equal(env.DB.q("SELECT status, attempts FROM inbound_media")[0].status, "failed");

  const second = received(PA, { type: "image", bytes: jpeg(), mime: "image/jpeg" });
  await signedWebhook(env, second.payload);
  const [m2] = env.CAMPAIGN_QUEUE.sent.splice(0);
  globalThis.fetch = async () => { throw new TypeError("blip"); };
  assert.equal(await processInboundMedia(env, m2), "retry");
  globalThis.fetch = real;
  assert.equal(await processInboundMedia(env, m2), "stored");
});

test("without MEDIA_BUCKET configured nothing is downloaded and the reason is shown", async () => {
  delete env.MEDIA_BUCKET;
  const { payload } = received(PA, { type: "image", bytes: jpeg(), mime: "image/jpeg" });
  await signedWebhook(env, payload);
  await drainQueue(env);
  const row = env.DB.q("SELECT * FROM inbound_media")[0];
  assert.equal(row.status, "failed");
  assert.match(row.error, /MEDIA_BUCKET/);
  assert.equal(graph.downloads.length, 0);
});

test("the scheduler re-queues lost downloads, recovers stuck ones, and marks >7-day-old media unavailable", async () => {
  const one = received(PA, { type: "image", bytes: jpeg(), mime: "image/jpeg" });
  await signedWebhook(env, one.payload);
  env.CAMPAIGN_QUEUE.sent.splice(0); // queue message lost
  env.DB.raw.exec(`UPDATE inbound_media SET updated_at = '${new Date(Date.now() - 5 * 60e3).toISOString()}'`);
  await scheduled({}, env);
  assert.equal(env.CAMPAIGN_QUEUE.sent.length, 1);
  await drainQueue(env);
  assert.equal(env.DB.q("SELECT status FROM inbound_media")[0].status, "stored");

  const old = received(PA, { type: "image", bytes: jpeg(), mime: "image/jpeg" });
  await signedWebhook(env, old.payload);
  env.CAMPAIGN_QUEUE.sent.splice(0);
  env.DB.raw.exec(`UPDATE inbound_media SET received_at = '${new Date(Date.now() - 8 * 86400e3).toISOString()}' WHERE status = 'pending'`);
  await scheduled({}, env);
  assert.equal(env.DB.q("SELECT status FROM inbound_media WHERE r2_key IS NULL")[0].status, "unavailable");

  const stuck = received(PA, { type: "image", bytes: jpeg(), mime: "image/jpeg" });
  await signedWebhook(env, stuck.payload);
  env.CAMPAIGN_QUEUE.sent.splice(0);
  env.DB.raw.exec(`UPDATE inbound_media SET status = 'downloading', attempts = 1, updated_at = '${new Date(Date.now() - 20 * 60e3).toISOString()}' WHERE status = 'pending'`);
  await scheduled({}, env);
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM inbound_media WHERE status = 'pending'")[0].n, 1);
});

test("a Meta checksum that doesn't match is recorded, and either hex or base64 formats are understood", async () => {
  const { payload } = received(PA, { type: "image", bytes: jpeg(), mime: "image/jpeg", sha: "deadbeef" });
  await signedWebhook(env, payload);
  await drainQueue(env);
  assert.equal(env.DB.q("SELECT sha256_matches_meta AS m FROM inbound_media")[0].m, 0);
  const h = hex(png());
  assert.equal(shaMatches(h, h.toUpperCase()), 1);
  assert.equal(shaMatches(h, Buffer.from(h, "hex").toString("base64")), 1);
  assert.equal(shaMatches(h, null), null);
});

test("byte sniffing allowlist", () => {
  assert.equal(sniffInbound("image", jpeg()), "image/jpeg");
  assert.equal(sniffInbound("image", png()), "image/png");
  assert.equal(sniffInbound("image", ogg()), null);
  assert.equal(sniffInbound("audio", ogg()), "audio/ogg");
  assert.equal(sniffInbound("audio", new Uint8Array([0x23, 0x21, 0x41, 0x4d, 0x52, 0x0a, ...new Array(20).fill(0)])), "audio/amr");
  assert.equal(sniffInbound("audio", new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, ...new Array(20).fill(0)])), "audio/mp4");
  assert.equal(sniffInbound("audio", new Uint8Array([0x49, 0x44, 0x33, ...new Array(20).fill(0)])), "audio/mpeg");
  assert.equal(sniffInbound("audio", textFile()), null);
});
