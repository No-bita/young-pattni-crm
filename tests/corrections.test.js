// Tests for the corrections to the image bundle (review findings 1, 2, 4, 5, 6, 9).
// All Meta traffic is a local fake; nothing here proves live Meta behaviour.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeGraph, createAccount, login, setupSender, drainQueue, scheduled, template, app } from "./helpers.js";
import { png } from "./fixtures.js";
import { fetchMediaBytes } from "../src/whatsapp/graph.js";
import { acceptUpload, assetStillValid } from "../web/src/lib/uploadGuard.js";

const PA = "100000000001";
const WABA = "900000001";
let env, graph, a;

const fullTemplate = () => ({
  id: "mt_camp", name: "camp_poster", language: "en", status: "APPROVED", category: "MARKETING",
  components: [
    { type: "HEADER", format: "IMAGE", example: { header_handle: ["https://scontent.whatsapp.net/v/t61/secret?oe=6A00"] } },
    { type: "BODY", text: "Hi {{1}}, camp registrations are open.", example: { body_text: [["Riya"]] } },
    { type: "FOOTER", text: "Reply STOP to opt out" },
    { type: "BUTTONS", buttons: [
      { type: "QUICK_REPLY", text: "Stop promotions" },
      { type: "URL", text: "Register", url: "https://example.org/camp" },
      { type: "PHONE_NUMBER", text: "Call us", phone_number: "+919800000000" },
    ] },
  ],
});
const metaTpl = () => graph.templates[WABA].find((t) => t.name === "camp_poster");

beforeEach(async () => {
  env = makeEnv();
  graph = makeGraph();
  globalThis.fetch = graph.fetch;
  await createAccount(env, { login: "a@test.in" });
  a = await login(env, "a@test.in");
  await setupSender(a, graph, env, { ref: "A1", phoneNumberId: PA, wabaId: WABA, display: "+91 90000 00001", templates: [fullTemplate(), template("plain_text", { body: "Hello {{1}}" })] });
});

async function draftWithImage(n = 1) {
  const t = (await a.get("/api/templates")).data.templates.find((x) => x.name === "camp_poster");
  const asset = (await a.upload("/api/media", png())).data.asset;
  const cmp = await a.post("/api/campaigns", { name: "Camp", templateId: t.id, params: [{ type: "contact_name", fallback: "there" }], mediaAssetId: asset.id });
  assert.equal(cmp.status, 201, JSON.stringify(cmp.data));
  await a.post("/api/contacts/import", { rows: Array.from({ length: n }, (_, i) => ({ phone: `98300000${String(i).padStart(2, "0")}`, name: `N${i}` })) });
  const ids = (await a.get("/api/contacts?limit=200")).data.contacts.map((c) => c.id);
  await a.put(`/api/campaigns/${cmp.data.campaign.id}/audience`, { contactIds: ids });
  return { id: cmp.data.campaign.id, n: ids.length, t };
}

// ---------- 1. bounded uploads ----------

function multipart(parts, boundary = "----sbtest") {
  const enc = new TextEncoder();
  const chunks = [];
  for (const p of parts) {
    chunks.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"${p.filename ? `; filename="${p.filename}"` : ""}\r\n${p.type ? `Content-Type: ${p.type}\r\n` : ""}\r\n`));
    chunks.push(typeof p.data === "string" ? enc.encode(p.data) : p.data);
    chunks.push(enc.encode("\r\n"));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return { bytes: out, contentType: `multipart/form-data; boundary=${boundary}` };
}

function streamOf(bytes, { chunk = 65536, failAfter = null } = {}) {
  let o = 0;
  return new ReadableStream({
    pull(controller) {
      if (failAfter !== null && o >= failAfter) { controller.error(new Error("connection reset")); return; }
      if (o >= bytes.length) { controller.close(); return; }
      controller.enqueue(bytes.subarray(o, o + chunk));
      o += chunk;
    },
  });
}

async function rawUpload({ bytes, contentType }, { contentLength, failAfter } = {}) {
  const headers = { Cookie: a.cookie, "Content-Type": contentType };
  if (contentLength !== undefined) headers["Content-Length"] = String(contentLength);
  const res = await app.fetch(new Request("https://sb.test/api/media", { method: "POST", headers, body: streamOf(bytes, { failAfter }), duplex: "half" }), env, {});
  return { status: res.status, data: await res.json() };
}

test("uploads: total request is capped while reading, with or without an honest Content-Length", async () => {
  const big = multipart([{ name: "file", filename: "x.png", type: "image/png", data: new Uint8Array(6 * 1024 * 1024) }]);
  const noLen = await rawUpload(big);
  assert.equal(noLen.status, 413);
  assert.equal(noLen.data.code, "TOO_LARGE");
  const lying = await rawUpload(big, { contentLength: 1000 });
  assert.equal(lying.status, 413);
  const honest = await rawUpload(big, { contentLength: big.bytes.length });
  assert.equal(honest.status, 413);
  assert.equal(graph.uploads.length, 0);
});

test("uploads: extra form fields count toward the cap and are refused; the separate file cap still applies", async () => {
  const padded = multipart([{ name: "file", filename: "x.png", type: "image/png", data: png() }, { name: "junk", data: "z".repeat(6 * 1024 * 1024) }]);
  assert.equal((await rawUpload(padded)).status, 413);
  const extra = multipart([{ name: "file", filename: "x.png", type: "image/png", data: png() }, { name: "note", data: "hi" }]);
  const r = await rawUpload(extra);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /exactly one image file/);
  const twoFiles = multipart([{ name: "file", filename: "a.png", type: "image/png", data: png() }, { name: "file", filename: "b.png", type: "image/png", data: png() }]);
  assert.equal((await rawUpload(twoFiles)).status, 400);
  // a file just over 5 MB fits inside the request cap (5 MB + 64 KB) but fails the file cap
  const overFile = multipart([{ name: "file", filename: "x.png", type: "image/png", data: new Uint8Array(5 * 1024 * 1024 + 10) }]);
  const f = await rawUpload(overFile);
  assert.equal(f.status, 413);
  assert.match(f.data.error, /5,242,890 bytes/);
  assert.equal(graph.uploads.length, 0);
});

test("uploads: an interrupted upload is reported and nothing reaches Meta", async () => {
  const body = multipart([{ name: "file", filename: "x.png", type: "image/png", data: new Uint8Array(1024 * 1024) }]);
  const r = await rawUpload(body, { failAfter: 300 * 1024 });
  assert.equal(r.status, 400);
  assert.equal(r.data.code, "INTERRUPTED");
  assert.equal(graph.uploads.length, 0);
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM media_assets")[0].n, 0);
});

test("uploads: a non-multipart body is refused without reading it", async () => {
  const res = await app.fetch(new Request("https://sb.test/api/media", { method: "POST", headers: { Cookie: a.cookie, "Content-Type": "application/octet-stream" }, body: png() }), env, {});
  assert.equal(res.status, 400);
});

// ---------- 2. bounded retrieval ----------

async function senderAndMedia() {
  const asset = (await a.upload("/api/media", png())).data.asset;
  const sender = env.DB.q("SELECT * FROM senders WHERE account_id = 'acc_atestin'")[0];
  const mediaId = env.DB.q("SELECT meta_media_id FROM media_assets WHERE id = ?", asset.id)[0].meta_media_id;
  return { asset, sender, mediaId };
}

test("preview fetch never follows redirects, so the token is never sent elsewhere", async () => {
  const { asset, sender, mediaId } = await senderAndMedia();
  graph.downloadMode = "redirect";
  await assert.rejects(fetchMediaBytes(env, sender, mediaId, { timeoutMs: 1000, maxBytes: 1024 * 1024 }), (e) => e.code === "REDIRECT");
  assert.ok(graph.downloads.every((d) => d.redirect === "manual"));
  assert.ok(!graph.calls.some((c) => /evil/.test(c.path)));
  assert.equal((await a.raw(asset.previewUrl)).status, 502);
});

test("preview fetch has a deadline", async () => {
  const { sender, mediaId } = await senderAndMedia();
  graph.downloadMode = "hang";
  const t0 = Date.now();
  await assert.rejects(fetchMediaBytes(env, sender, mediaId, { timeoutMs: 150, maxBytes: 1024 }), (e) => e.code === "TIMEOUT");
  assert.ok(Date.now() - t0 < 3000);
});

test("preview fetch stops reading at the byte cap", async () => {
  const { sender, mediaId } = await senderAndMedia();
  graph.downloadMode = "huge";
  await assert.rejects(fetchMediaBytes(env, sender, mediaId, { timeoutMs: 5000, maxBytes: 1024 * 1024 }), (e) => e.code === "TOO_LARGE");
  assert.ok(graph.hugeBytesServed <= 1024 * 1024 + 4 * 65536, `served ${graph.hugeBytesServed}`);
});

// ---------- 4 & 9. structure kept, preview complete, content frozen, fresh check ----------

test("sync keeps footer and button destinations, but not examples, sample media or raw responses", async () => {
  const t = (await a.get("/api/templates")).data.templates.find((x) => x.name === "camp_poster");
  assert.equal(t.footerText, "Reply STOP to opt out");
  assert.deepEqual(t.buttons, [
    { type: "QUICK_REPLY", text: "Stop promotions", url: null, phoneNumber: null },
    { type: "URL", text: "Register", url: "https://example.org/camp", phoneNumber: null },
    { type: "PHONE_NUMBER", text: "Call us", url: null, phoneNumber: "+919800000000" },
  ]);
  const row = env.DB.q("SELECT * FROM templates WHERE name = 'camp_poster'")[0];
  const stored = JSON.stringify(row);
  assert.ok(!stored.includes("scontent"), "approval sample URL not stored");
  assert.ok(!stored.includes("header_handle"));
  assert.ok(!stored.includes("Riya"), "example values not stored");
});

test("the frozen campaign content is shown in full (header, body, footer, buttons with destinations)", async () => {
  const { id } = await draftWithImage();
  const c = (await a.get(`/api/campaigns/${id}`)).data.campaign;
  assert.equal(c.content.header.format, "IMAGE");
  assert.equal(c.content.footer.text, "Reply STOP to opt out");
  assert.equal(c.content.buttons[1].url, "https://example.org/camp");
  assert.equal(c.content.buttons[2].phoneNumber, "+919800000000");
});

const edits = {
  "body": (t) => { t.components[1].text = "Hi {{1}}, camp is FULL."; },
  "footer": (t) => { t.components[2].text = "Different footer"; },
  "buttons (label)": (t) => { t.components[3].buttons[0].text = "Unsubscribe"; },
  "buttons (URL)": (t) => { t.components[3].buttons[1].url = "https://example.org/other"; },
  "buttons (phone)": (t) => { t.components[3].buttons[2].phone_number = "+919811111111"; },
  "buttons (added)": (t) => { t.components[3].buttons.push({ type: "QUICK_REPLY", text: "More" }); },
  "header type": (t) => { t.components[0] = { type: "HEADER", format: "TEXT", text: "Camp" }; },
};

for (const [label, edit] of Object.entries(edits)) {
  test(`a change to the ${label} in Meta blocks launch without any manual CRM sync`, async () => {
    const { id } = await draftWithImage();
    edit(metaTpl());
    const r = await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.ok(["TEMPLATE_CHANGED", "TEMPLATE_NOT_APPROVED"].includes(r.data.code), r.data.code);
    if (r.data.code === "TEMPLATE_CHANGED") assert.match(r.data.error, /in Meta since it was picked/);
    await drainQueue(env);
    assert.equal(graph.sent.length, 0);
    const c = (await a.get(`/api/campaigns/${id}`)).data.campaign;
    assert.equal(c.contentCheck.source, "meta");
  });
}

test("a change in Meta after scheduling cancels the campaign at its start time, without manual sync", async () => {
  const { id } = await draftWithImage();
  const when = new Date(Date.now() + 3600e3).toISOString();
  assert.equal((await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1, scheduledAt: when })).status, 200);
  edits.footer(metaTpl());
  env.DB.raw.exec("UPDATE campaigns SET scheduled_at = '2000-01-01T00:00:00.000Z'");
  await scheduled({}, env);
  await drainQueue(env);
  const c = (await a.get(`/api/campaigns/${id}`)).data.campaign;
  assert.equal(c.status, "cancelled");
  assert.match(c.error, /footer/);
  assert.equal(graph.sent.length, 0);
});

test("re-picking the template after a Meta change freezes the new version and allows launch", async () => {
  const { id, t } = await draftWithImage();
  edits.footer(metaTpl());
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
  const asset = (await a.get(`/api/campaigns/${id}`)).data.campaign.media;
  const p = await a.patch(`/api/campaigns/${id}`, { templateId: t.id, params: [{ type: "contact_name", fallback: "there" }], mediaAssetId: asset.id });
  assert.equal(p.status, 200);
  assert.equal((await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 })).status, 200);
  await drainQueue(env);
  assert.equal(graph.sent.length, 1);
});

test("if Meta can't be reached, launch proceeds on the frozen copy and says it was NOT freshly checked", async () => {
  const { id } = await draftWithImage();
  graph.failTemplates = true;
  assert.equal((await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 })).status, 200);
  graph.failTemplates = false;
  await drainQueue(env);
  assert.equal(graph.sent.length, 1);
  const c = (await a.get(`/api/campaigns/${id}`)).data.campaign;
  assert.equal(c.contentCheck.source, "local_fallback");
  assert.match(c.contentCheck.note, /could not be asked/);
});

test("a slow Meta answer falls back after the freshness deadline instead of hanging", { timeout: 15000 }, async () => {
  const { id } = await draftWithImage();
  graph.hangTemplates = true;
  const t0 = Date.now();
  assert.equal((await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 })).status, 200);
  assert.ok(Date.now() - t0 < 8000);
  graph.hangTemplates = false;
  assert.equal((await a.get(`/api/campaigns/${id}`)).data.campaign.contentCheck.source, "local_fallback");
});

test("a template deleted in Meta blocks launch and is marked missing", async () => {
  const { id } = await draftWithImage();
  graph.templates[WABA] = graph.templates[WABA].filter((t) => t.name !== "camp_poster");
  const r = await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
  assert.equal(r.status, 409);
  assert.match(r.data.error, /no longer has this template/);
  assert.equal(env.DB.q("SELECT status FROM templates WHERE name = 'camp_poster'")[0].status, "MISSING");
});

test("after launch, queued sends stop if the local copy changes (e.g. a later refresh)", async () => {
  const { id } = await draftWithImage(2);
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 2 });
  edits.body(metaTpl());
  await a.post("/api/templates/sync");
  await drainQueue(env);
  assert.equal(graph.sent.length, 0);
  const rec = (await a.get(`/api/campaigns/${id}/recipients`)).data.recipients;
  assert.ok(rec.every((r) => r.status === "failed" && /changed after launch \(body\)/.test(r.error)));
});

test("drafts created before content freezing must re-pick their template", async () => {
  const { id } = await draftWithImage();
  env.DB.raw.exec(`UPDATE campaigns SET frozen_content_json = NULL WHERE id = '${id}'`);
  const r = await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
  assert.equal(r.data.code, "TEMPLATE_RECHECK_NEEDED");
});

// ---------- 5. deadline enforced by the consumer ----------

test("a delayed worker does not send after the sending window; counts are reported honestly", async () => {
  const { id, n } = await draftWithImage(3);
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: n });
  const c0 = (await a.get(`/api/campaigns/${id}`)).data.campaign;
  const expectedMs = Date.parse(c0.launchedAt) + 3600e3;
  assert.ok(Math.abs(Date.parse(c0.sendDeadline) - expectedMs) < 2000, "deadline = start + 1 h (image valid longer)");
  env.DB.raw.exec(`UPDATE campaigns SET send_deadline = '${new Date(Date.now() - 1000).toISOString()}' WHERE id = '${id}'`);
  await drainQueue(env);
  assert.equal(graph.sent.length, 0);
  const c = (await a.get(`/api/campaigns/${id}`)).data.campaign;
  assert.equal(c.status, "completed");
  assert.equal(c.notSentDeadline, 3);
  assert.equal(c.recipients.failed, 3);
  const rec = (await a.get(`/api/campaigns/${id}/recipients`)).data.recipients;
  assert.ok(rec.every((r) => /sending window ended/.test(r.error)));
});

test("the sending window never extends past the image's usable-until time", async () => {
  const { id } = await draftWithImage(1);
  const assetId = env.DB.q(`SELECT media_asset_id FROM campaigns WHERE id = '${id}'`)[0].media_asset_id;
  const up = new Date(Date.now() - 27.9 * 86400e3);
  env.DB.raw.prepare("UPDATE media_assets SET uploaded_at = ?, expires_at = ? WHERE id = ?").run(up.toISOString(), new Date(up.getTime() + 30 * 86400e3).toISOString(), assetId);
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
  const c = (await a.get(`/api/campaigns/${id}`)).data.campaign;
  assert.ok(Date.parse(c.sendDeadline) <= Date.parse(c.media.usableUntil));
});

test("text-only campaigns also get the 1-hour consumer deadline", async () => {
  const t = (await a.get("/api/templates")).data.templates.find((x) => x.name === "plain_text");
  const cmp = (await a.post("/api/campaigns", { name: "t", templateId: t.id, params: [{ type: "text", value: "v" }] })).data.campaign.id;
  const c1 = (await a.post("/api/contacts", { phone: "9812345678", name: "X" })).data.contact;
  await a.put(`/api/campaigns/${cmp}/audience`, { contactIds: [c1.id] });
  await a.post(`/api/campaigns/${cmp}/launch`, { confirmCount: 1 });
  env.DB.raw.exec(`UPDATE campaigns SET send_deadline = '2000-01-01T00:00:00.000Z' WHERE id = '${cmp}'`);
  await drainQueue(env);
  assert.equal(graph.sent.length, 0);
});

// ---------- 6. upload/template races (pure decision logic used by the screen) ----------

test("upload guard: stale, superseded, wrong-template and wrong-number uploads are not attached", () => {
  const base = { seq: 2, currentSeq: 2, forTemplateId: "T1", currentTemplateId: "T1", assetSenderId: "S1", activeSenderId: "S1" };
  assert.deepEqual(acceptUpload(base), { ok: true });
  assert.equal(acceptUpload({ ...base, currentSeq: 3 }).reason, "superseded");
  assert.equal(acceptUpload({ ...base, currentTemplateId: "T2" }).reason, "template_changed");
  assert.equal(acceptUpload({ ...base, forTemplateId: null }).reason, "template_changed");
  assert.equal(acceptUpload({ ...base, activeSenderId: "S2" }).reason, "sender_changed");
  assert.equal(assetStillValid({ senderId: "S1" }, "S1"), true);
  assert.equal(assetStillValid({ senderId: "S1" }, "S2"), false);
  assert.equal(assetStillValid(null, "S1"), false);
});
