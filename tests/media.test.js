// Image-header templates: shape validation, upload checks, ownership, freezing, expiry,
// sender pinning, scheduling, queue behaviour. All Meta traffic is a local fake.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { makeEnv, makeGraph, createAccount, login, setupSender, drainQueue, signedWebhook, waPayload, scheduled, template } from "./helpers.js";
import { png, jpeg, gif, textFile } from "./fixtures.js";
import { describeTemplate } from "../src/whatsapp/graph.js";

const PA = "100000000001";
const WABA = "900000001";
let env, graph, a, b;

function imageTemplate(name = "promo_image", { status = "APPROVED", body = "Hi {{1}}, see our offer", buttons } = {}) {
  const components = [{ type: "HEADER", format: "IMAGE", example: { header_handle: ["<removed>"] } }, { type: "BODY", text: body }, { type: "FOOTER", text: "Reply STOP to opt out" }];
  if (buttons) components.push({ type: "BUTTONS", buttons });
  return { id: `mt_${name}`, name, language: "en", status, category: "MARKETING", components };
}

beforeEach(async () => {
  env = makeEnv();
  graph = makeGraph();
  globalThis.fetch = graph.fetch;
  await createAccount(env, { login: "a@test.in" });
  await createAccount(env, { login: "b@test.in" });
  a = await login(env, "a@test.in");
  b = await login(env, "b@test.in");
  await setupSender(a, graph, env, {
    ref: "A1", phoneNumberId: PA, wabaId: WABA, display: "+91 90000 00001",
    templates: [imageTemplate(), imageTemplate("img_buttons", { body: "Hello", buttons: [{ type: "QUICK_REPLY", text: "Stop promotions" }, { type: "URL", text: "Shop", url: "https://example.com/shop" }, { type: "PHONE_NUMBER", text: "Call", phone_number: "15550051310" }] }), template("plain_text", { body: "Hello {{1}}" })],
  });
  await setupSender(b, graph, env, { ref: "B1", phoneNumberId: "200000000002", wabaId: "900000002", display: "+91 2", templates: [imageTemplate()] });
});

const tpl = async (client, name) => (await client.get("/api/templates")).data.templates.find((t) => t.name === name);
const contacts = async (client, n) => {
  await client.post("/api/contacts/import", { rows: Array.from({ length: n }, (_, i) => ({ phone: `98200000${String(i).padStart(2, "0")}`, name: i ? `N${i}` : "" })) });
  return (await client.get("/api/contacts?limit=200")).data.contacts;
};
const upload = (client, bytes = png(), opts) => client.upload("/api/media", bytes, opts);
async function mediaCampaign(client, assetId, n = 2, name = "promo_image") {
  const t = await tpl(client, name);
  const params = Array.from({ length: t.paramCount }, () => ({ type: "contact_name", fallback: "there" }));
  const res = await client.post("/api/campaigns", { name: "Img", templateId: t.id, params, mediaAssetId: assetId });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  const list = await contacts(client, n);
  await client.put(`/api/campaigns/${res.data.campaign.id}/audience`, { contactIds: list.map((c) => c.id) });
  return { id: res.data.campaign.id, list };
}
const sends = () => graph.sent.map((s) => s.body);
const ageAsset = (id, uploadedDaysAgo) => {
  const up = new Date(Date.now() - uploadedDaysAgo * 86400e3);
  env.DB.raw.prepare("UPDATE media_assets SET uploaded_at = ?, expires_at = ? WHERE id = ?").run(up.toISOString(), new Date(up.getTime() + 30 * 86400e3).toISOString(), id);
};

// ---------- template shape ----------

test("template shapes: image headers and button-free/static buttons are supported; everything else gets a reason", () => {
  const d = (components, extra = {}) => describeTemplate({ components, ...extra });
  assert.equal(d([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{1}}" }]).unsupportedReason, null);
  assert.equal(d([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "x" }, { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Stop" }, { type: "URL", url: "https://e.com/a" }, { type: "PHONE_NUMBER" }] }]).unsupportedReason, null);
  assert.match(d([{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "x" }]).unsupportedReason, /Video headers/);
  assert.match(d([{ type: "HEADER", format: "DOCUMENT" }, { type: "BODY", text: "x" }]).unsupportedReason, /Document headers/);
  assert.match(d([{ type: "HEADER", format: "LOCATION" }, { type: "BODY", text: "x" }]).unsupportedReason, /Location headers/);
  assert.match(d([{ type: "HEADER", format: "TEXT", text: "Hi {{1}}" }, { type: "BODY", text: "x" }]).unsupportedReason, /Text headers with a variable/);
  assert.match(d([{ type: "BODY", text: "Hi {{first_name}}" }]).unsupportedReason, /Named variables/);
  assert.match(d([{ type: "BODY", text: "Hi" }], { parameter_format: "NAMED" }).unsupportedReason, /Named variables/);
  assert.match(d([{ type: "BODY", text: "x" }, { type: "BUTTONS", buttons: [{ type: "URL", url: "https://e.com/{{1}}" }] }]).unsupportedReason, /URL buttons with a variable/);
  assert.match(d([{ type: "BODY", text: "x" }, { type: "BUTTONS", buttons: [{ type: "COPY_CODE" }] }]).unsupportedReason, /copy code buttons/);
  assert.match(d([{ type: "BODY", text: "x" }, { type: "CAROUSEL" }]).unsupportedReason, /carousel components/);
  const ok = d([{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "{{1}} {{2}} {{1}}" }]);
  assert.equal(ok.bodyParamCount, 2);
  assert.equal(ok.headerFormat, "IMAGE");
});

test("the picker lists approved image templates as needing an image, and explains unsupported ones", async () => {
  graph.templates[WABA].push(
    { id: "v", name: "video_one", language: "en", status: "APPROVED", components: [{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "x" }] },
    imageTemplate("paused_one", { status: "PAUSED" }),
  );
  await a.post("/api/templates/sync");
  const list = (await a.get("/api/templates")).data.templates;
  const img = list.find((t) => t.name === "promo_image");
  assert.equal(img.usable, true);
  assert.equal(img.needsImage, true);
  assert.equal(img.headerFormat, "IMAGE");
  assert.deepEqual(list.find((t) => t.name === "img_buttons").buttons.map((x) => x.type), ["QUICK_REPLY", "URL", "PHONE_NUMBER"]);
  const vid = list.find((t) => t.name === "video_one");
  assert.equal(vid.usable, false);
  assert.match(vid.unsupportedReason, /Video headers/);
  assert.match(list.find((t) => t.name === "paused_one").unsupportedReason, /PAUSED/);
  assert.ok(!JSON.stringify(list).includes("header_handle"));
});

test("rows synced before the migration keep the old rule until refreshed", async () => {
  env.DB.raw.exec("UPDATE templates SET header_format = NULL, unsupported_reason = NULL");
  const list = (await a.get("/api/templates")).data.templates;
  assert.equal(list.find((t) => t.name === "plain_text").usable, true);
  const img = list.find((t) => t.name === "promo_image");
  assert.equal(img.usable, false);
  assert.match(img.unsupportedReason, /Refresh templates/);
});

// ---------- upload ----------

test("upload: a valid PNG/JPEG goes to Meta through the active number; Meta's id never reaches the browser", async () => {
  const res = await upload(a, png(), { type: "image/png", name: "../../offer<script>.png" });
  assert.equal(res.status, 201, JSON.stringify(res.data));
  assert.equal(graph.uploads.length, 1);
  assert.equal(graph.uploads[0].phoneNumberId, PA);
  assert.equal(graph.uploads[0].type, "image/png");
  assert.equal(graph.media[graph.uploads[0].id].messagingProduct, "whatsapp");
  assert.ok(!JSON.stringify(res.data).includes(graph.uploads[0].id));
  assert.ok(!JSON.stringify(res.data).includes("tok_"));
  assert.equal(res.data.asset.width, 64);
  assert.doesNotMatch(res.data.asset.originalName, /[<>/]/);
  const days = (Date.parse(res.data.asset.expiresAt) - Date.parse(res.data.asset.uploadedAt)) / 86400e3;
  assert.equal(days, 30);
  assert.equal((Date.parse(res.data.asset.expiresAt) - Date.parse(res.data.asset.usableUntil)) / 86400e3, 2);
  assert.equal((await upload(a, jpeg(), { type: "image/jpeg", name: "x.jpg" })).status, 201);
});

test("upload rejects oversize, non-image, mislabelled and non-RGB files before contacting Meta", async () => {
  const big = png({ padTo: 5 * 1024 * 1024 + 10 });
  const cases = [
    [big, "image/png", 413, "TOO_LARGE"],
    [gif(), "image/gif", 415, "UNSUPPORTED_TYPE"],
    [textFile(), "image/png", 415, "UNSUPPORTED_TYPE"],
    [png(), "image/jpeg", 415, "TYPE_MISMATCH"],
    [png({ colorType: 0 }), "image/png", 415, "BAD_IMAGE"],
    [png({ colorType: 3 }), "image/png", 415, "BAD_IMAGE"],
    [png({ bitDepth: 16 }), "image/png", 415, "BAD_IMAGE"],
    [jpeg({ components: 4 }), "image/jpeg", 415, "BAD_IMAGE"],
    [new Uint8Array(0), "image/png", 400, "BAD_UPLOAD"],
  ];
  for (const [bytes, type, status, code] of cases) {
    const r = await upload(a, bytes, { type });
    assert.equal(r.status, status, `${code}: ${JSON.stringify(r.data)}`);
    assert.equal(r.data.code, code);
  }
  assert.equal((await a.upload("/api/media", png(), { field: "notfile" })).status, 400);
  assert.equal(graph.uploads.length, 0);
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM media_assets")[0].n, 0);
});

test("upload requires a session and an active number; a Meta rejection stores nothing", async () => {
  const anon = new (a.constructor)(env);
  assert.equal((await upload(anon)).status, 401);
  graph.failUpload = true;
  const r = await upload(a);
  assert.equal(r.status, 502);
  assert.match(r.data.error, /Meta did not accept/);
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM media_assets")[0].n, 0);
  graph.failUpload = false;
  env.DB.raw.exec("UPDATE senders SET status = 'inactive' WHERE account_id = 'acc_atestin'");
  assert.equal((await upload(a)).status, 409);
});

// ---------- ownership ----------

test("assets are account-scoped: no reading, previewing or attaching another account's image, and raw Meta ids are not accepted", async () => {
  const asset = (await upload(a)).data.asset;
  assert.equal((await b.get(`/api/media/${asset.id}`)).status, 404);
  assert.equal((await b.raw(`/api/media/${asset.id}/preview`)).status, 404);
  const bt = await tpl(b, "promo_image");
  const res = await b.post("/api/campaigns", { name: "steal", templateId: bt.id, params: [{ type: "text", value: "x" }], mediaAssetId: asset.id });
  assert.equal(res.status, 400);
  const metaId = env.DB.q("SELECT meta_media_id FROM media_assets")[0].meta_media_id;
  const res2 = await a.post("/api/campaigns", { name: "raw", templateId: (await tpl(a, "promo_image")).id, params: [{ type: "text", value: "x" }], mediaAssetId: metaId });
  assert.equal(res2.status, 400);
  assert.match(res2.data.error, /Image not found/);
});

test("authenticated preview streams the image with the validated type; it is never a Meta URL", async () => {
  const asset = (await upload(a)).data.asset;
  assert.equal(asset.previewUrl, `/api/media/${asset.id}/preview`);
  const res = await a.raw(asset.previewUrl);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Content-Type"), "image/png");
  assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), png());
});

// ---------- campaign create / edit ----------

test("an image template requires an image; a text template refuses one", async () => {
  const t = await tpl(a, "promo_image");
  const noImg = await a.post("/api/campaigns", { name: "x", templateId: t.id, params: [{ type: "text", value: "v" }] });
  assert.equal(noImg.status, 400);
  assert.equal(noImg.data.code, "MEDIA_MISSING");
  const asset = (await upload(a)).data.asset;
  const txt = await a.post("/api/campaigns", { name: "x", templateId: (await tpl(a, "plain_text")).id, params: [{ type: "text", value: "v" }], mediaAssetId: asset.id });
  assert.equal(txt.status, 400);
  assert.match(txt.data.error, /no image header/);
});

test("a draft's image can be replaced, and the detail shows it without exposing Meta's id", async () => {
  const one = (await upload(a)).data.asset;
  const { id } = await mediaCampaign(a, one.id, 1);
  const two = (await upload(a, jpeg(), { type: "image/jpeg" })).data.asset;
  const p = await a.patch(`/api/campaigns/${id}`, { mediaAssetId: two.id });
  assert.equal(p.status, 200);
  const detail = (await a.get(`/api/campaigns/${id}`)).data;
  assert.equal(detail.campaign.media.id, two.id);
  assert.ok(!JSON.stringify(detail).includes("mid_"));
  assert.equal(detail.template.needsImage, true);
});

// ---------- sending ----------

test("immediate send carries the HEADER image with the BODY parameters, and history records the asset", async () => {
  const asset = (await upload(a)).data.asset;
  const { id } = await mediaCampaign(a, asset.id, 2);
  assert.equal((await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 2 })).status, 200);
  await drainQueue(env);
  assert.equal(graph.sent.length, 2);
  for (const body of sends()) {
    const [header, bodyComp] = body.template.components;
    assert.deepEqual(header, { type: "header", parameters: [{ type: "image", image: { id: "mid_1" } }] });
    assert.equal(bodyComp.type, "body");
    assert.equal(bodyComp.parameters.length, 1);
    assert.equal(body.to.startsWith("9198"), true);
  }
  const msgs = env.DB.q("SELECT media_asset_id, body FROM messages WHERE campaign_id = ?", id);
  assert.ok(msgs.every((m) => m.media_asset_id === asset.id));
  const thread = (await a.get(`/api/inbox/${env.DB.q("SELECT contact_id FROM messages WHERE campaign_id = ?", id)[0].contact_id}`)).data.messages;
  assert.equal(thread[0].media.previewUrl, `/api/media/${asset.id}/preview`);
  assert.ok(!JSON.stringify(thread).includes("mid_1"));
  const c = (await a.get(`/api/campaigns/${id}`)).data.campaign;
  assert.equal(c.frozen.headerFormat, "IMAGE");
});

test("text-only campaigns send no header component and record no image", async () => {
  const t = await tpl(a, "plain_text");
  const cmp = (await a.post("/api/campaigns", { name: "t", templateId: t.id, params: [{ type: "text", value: "v" }] })).data.campaign.id;
  const list = await contacts(a, 1);
  await a.put(`/api/campaigns/${cmp}/audience`, { contactIds: [list[0].id] });
  await a.post(`/api/campaigns/${cmp}/launch`, { confirmCount: 1 });
  await drainQueue(env);
  assert.deepEqual(sends()[0].template.components.map((x) => x.type), ["body"]);
  assert.equal(env.DB.q("SELECT media_asset_id FROM messages")[0].media_asset_id, null);
});

test("expiry covers the whole queue: launch is refused when the image would lapse while sending", async () => {
  const asset = (await upload(a)).data.asset;
  const { id } = await mediaCampaign(a, asset.id, 1);
  ageAsset(asset.id, 27.97); // usable until ~28d, i.e. ~43 min from now; queue bound is 1h
  const r = await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "MEDIA_EXPIRED");
  ageAsset(asset.id, 27.9); // ~2.4h left
  assert.equal((await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 })).status, 200);
});

test("a queued media send whose image has lapsed is failed, not sent", async () => {
  const asset = (await upload(a)).data.asset;
  const { id } = await mediaCampaign(a, asset.id, 2);
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 2 });
  ageAsset(asset.id, 29);
  await drainQueue(env);
  assert.equal(graph.sent.length, 0);
  const rec = (await a.get(`/api/campaigns/${id}/recipients`)).data.recipients;
  assert.ok(rec.every((r) => r.status === "failed" && /can be used only until/.test(r.error)));
});

test("scheduling is limited by the image's validity, and a due campaign sends the frozen media", async () => {
  const asset = (await upload(a)).data.asset;
  const { id } = await mediaCampaign(a, asset.id, 1);
  const tooLate = new Date(Date.parse(asset.latestStart) + 60e3).toISOString();
  const r = await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1, scheduledAt: tooLate });
  assert.equal(r.data.code, "MEDIA_EXPIRED");
  const pre = (await a.get(`/api/campaigns/${id}/preview`)).data;
  assert.equal(pre.latestStart, asset.latestStart);
  const ok = new Date(Date.parse(asset.latestStart) - 3600e3).toISOString();
  assert.equal((await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1, scheduledAt: ok })).data.campaign.status, "scheduled");
  // a 90-day schedule is impossible for media campaigns under the approved policy
  assert.ok(Date.parse(asset.latestStart) - Date.now() < 28 * 86400e3);
  env.DB.raw.exec("UPDATE campaigns SET scheduled_at = '2000-01-01T00:00:00.000Z'");
  await scheduled({}, env);
  await drainQueue(env);
  assert.equal(graph.sent.length, 1);
  assert.equal(sends()[0].template.components[0].parameters[0].image.id, "mid_1");
});

test("approval change: a template paused after scheduling cancels the campaign with a reason; after launch, queued sends fail", async () => {
  const asset = (await upload(a)).data.asset;
  const { id } = await mediaCampaign(a, asset.id, 1);
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1, scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
  graph.templates[WABA][0].status = "PAUSED";
  await a.post("/api/templates/sync");
  env.DB.raw.exec("UPDATE campaigns SET scheduled_at = '2000-01-01T00:00:00.000Z'");
  await scheduled({}, env);
  const c = (await a.get(`/api/campaigns/${id}`)).data.campaign;
  assert.equal(c.status, "cancelled");
  assert.match(c.error, /not approved/);

  graph.templates[WABA][0].status = "APPROVED";
  await a.post("/api/templates/sync");
  const second = await mediaCampaign(a, asset.id, 1);
  await a.post(`/api/campaigns/${second.id}/launch`, { confirmCount: 1 });
  graph.templates[WABA][0].status = "REJECTED";
  await a.post("/api/templates/sync");
  await drainQueue(env);
  assert.equal(graph.sent.length, 0);
  assert.equal((await a.get(`/api/campaigns/${second.id}/recipients`)).data.recipients[0].status, "failed");
});

test("content is frozen: if Meta's template changes shape after scheduling, nothing is sent", async () => {
  const asset = (await upload(a)).data.asset;
  const { id } = await mediaCampaign(a, asset.id, 1);
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1, scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
  graph.templates[WABA][0].components[1].text = "Completely different {{1}}";
  await a.post("/api/templates/sync");
  env.DB.raw.exec("UPDATE campaigns SET scheduled_at = '2000-01-01T00:00:00.000Z'");
  await scheduled({}, env);
  const c = (await a.get(`/api/campaigns/${id}`)).data.campaign;
  assert.equal(c.status, "cancelled");
  assert.match(c.error, /changed in Meta/);
  assert.equal(graph.sent.length, 0);
});

test("sender pinning: after a number switch the old image is refused until re-uploaded on the new number", async () => {
  const asset = (await upload(a)).data.asset;
  const { id } = await mediaCampaign(a, asset.id, 1);
  graph.phoneNumbers["100000000005"] = { display_phone_number: "+91 5", verified_name: "n", waba: WABA };
  env.WA_TOKEN_A5 = "tok_A5";
  const s5 = (await a.post("/api/senders", { tokenRef: "A5", phoneNumberId: "100000000005", wabaId: WABA })).data.sender.id;
  await a.post(`/api/senders/${s5}/test`, {});
  assert.equal((await a.post(`/api/senders/${s5}/activate`, {})).status, 200);

  // Templates are per sender row; this campaign's template now resolves on the new sender.
  const blocked = await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
  assert.equal(blocked.data.code, "MEDIA_WRONG_SENDER");
  const fresh = (await upload(a)).data.asset;
  assert.equal(graph.uploads.at(-1).phoneNumberId, "100000000005");
  assert.equal((await a.patch(`/api/campaigns/${id}`, { mediaAssetId: fresh.id })).status, 200);
  assert.equal((await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 })).status, 200);
  await drainQueue(env);
  assert.equal(graph.sent[0].phoneNumberId, "100000000005");
  assert.equal(graph.sent[0].token, "tok_A5");
  assert.equal(sends()[0].template.components[0].parameters[0].image.id, graph.uploads.at(-1).id);
});

test("duplicate queue delivery sends once; suppressed contacts are skipped; unknown outcomes are not re-sent", async () => {
  const asset = (await upload(a)).data.asset;
  const { id, list } = await mediaCampaign(a, asset.id, 3);
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 3 });
  await signedWebhook(env, waPayload(PA, { user_preferences: [{ wa_id: list[0].phone.slice(1), category: "marketing_messages", value: "stop" }] }));
  env.CAMPAIGN_QUEUE.sent.push(...env.CAMPAIGN_QUEUE.sent.map((x) => ({ ...x })));
  const real = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/messages") && calls++ === 0) throw new TypeError("network down");
    return real(url, init);
  };
  await drainQueue(env);
  globalThis.fetch = real;
  const rec = (await a.get(`/api/campaigns/${id}/recipients`)).data.recipients;
  const by = Object.groupBy(rec, (r) => r.status);
  assert.equal(by.skipped_suppressed.length, 1);
  assert.equal(by.failed.length, 1);
  assert.match(by.failed[0].error, /not confirmed as sent/);
  assert.equal(by.sent.length, 1);
  assert.equal(graph.sent.length, 1);
  await scheduled({}, env);
  await drainQueue(env);
  assert.equal(graph.sent.length, 1);
});

test("the Number screen's optional test never offers or sends media templates", async () => {
  const sid = (await a.get("/api/senders")).data.senders[0].id;
  // make an inactive second sender to reach the test panel path
  graph.phoneNumbers["100000000007"] = { display_phone_number: "+91 7", verified_name: "n", waba: WABA };
  graph.templates[WABA].push(imageTemplate("img_novars", { body: "No variables" }));
  env.WA_TOKEN_A7 = "tok_A7";
  const s7 = (await a.post("/api/senders", { tokenRef: "A7", phoneNumberId: "100000000007", wabaId: WABA })).data.sender.id;
  await a.post(`/api/senders/${s7}/test`, {});
  const offered = (await a.get(`/api/senders/${s7}/test-templates`)).data.templates.map((t) => t.name);
  assert.ok(!offered.includes("img_novars"));
  const imgId = env.DB.q("SELECT id FROM templates WHERE sender_id = ? AND name = 'img_novars'", s7)[0].id;
  const r = await a.post(`/api/senders/${s7}/test`, { testPhone: "9811112222", templateId: imgId });
  assert.equal(r.data.ok, false);
  assert.match(r.data.error, /text-only/);
  assert.equal(graph.sent.length, 0);
  assert.ok(sid);
});

test("migration 0002 is additive: existing rows and text-only behaviour survive", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  db.exec("INSERT INTO accounts (id, name, login, password_hash) VALUES ('acc', 'A', 'a', 'x')");
  db.exec("INSERT INTO senders (id, account_id, token_ref, phone_number_id, waba_id) VALUES ('s', 'acc', 'R', '1', '2')");
  db.exec("INSERT INTO templates (id, account_id, sender_id, waba_id, name, language, status, body_text, synced_at) VALUES ('t', 'acc', 's', '2', 'n', 'en', 'APPROVED', 'hi', 'now')");
  db.exec("INSERT INTO contacts (id, account_id, phone_e164) VALUES ('c', 'acc', '919800000000')");
  db.exec("INSERT INTO campaigns (id, account_id, name, template_name, template_language) VALUES ('k', 'acc', 'K', 'n', 'en')");
  db.exec("INSERT INTO messages (id, account_id, contact_id, sender_id, direction, kind, status) VALUES ('m', 'acc', 'c', 's', 'outbound', 'template', 'sent')");
  db.exec(readFileSync(new URL("../migrations/0002_image_header_templates.sql", import.meta.url), "utf8"));
  for (const t of ["accounts", "senders", "templates", "contacts", "campaigns", "messages"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n, 1, t);
  }
  const row = db.prepare("SELECT header_format, header_param_count, media_asset_id FROM templates t LEFT JOIN campaigns c ON 1=1").get();
  assert.equal(row.header_format, null);
  assert.equal(row.header_param_count, 0);
  assert.equal(row.media_asset_id, null);
});

test("media_assets carries account_id and no download URL column", () => {
  const cols = env.DB.q("PRAGMA table_info(media_assets)").map((c) => c.name);
  assert.ok(cols.includes("account_id"));
  assert.ok(!cols.some((c) => /url/i.test(c)));
});
