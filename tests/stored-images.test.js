// Header images kept privately in R2 (policy B) and uploaded to Meta again when needed.
// Meta and R2 are local fakes; nothing here proves live behaviour.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeGraph, createAccount, login, setupSender, drainQueue, scheduled, template } from "./helpers.js";
import { makeR2 } from "./fake-r2.js";
import { png } from "./fixtures.js";

const PA = "100000000001";
const WABA = "900000001";
let env, graph, r2, a, b;

const imgTpl = () => ({ id: "mt_img", name: "promo_image", language: "en", status: "APPROVED", category: "MARKETING", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hi {{1}}" }] });

beforeEach(async () => {
  r2 = makeR2();
  env = makeEnv({ MEDIA_BUCKET: r2 });
  graph = makeGraph();
  globalThis.fetch = graph.fetch;
  await createAccount(env, { login: "a@test.in" });
  await createAccount(env, { login: "b@test.in" });
  a = await login(env, "a@test.in");
  b = await login(env, "b@test.in");
  await setupSender(a, graph, env, { ref: "A1", phoneNumberId: PA, wabaId: WABA, display: "+91 1", templates: [imgTpl(), template("plain", { body: "Hello" })] });
  await setupSender(b, graph, env, { ref: "B1", phoneNumberId: "200000000002", wabaId: "900000002", display: "+91 2", templates: [imgTpl()] });
});

async function draft(assetId, n = 1) {
  const t = (await a.get("/api/templates")).data.templates.find((x) => x.name === "promo_image");
  const cmp = await a.post("/api/campaigns", { name: "Img", templateId: t.id, params: [{ type: "contact_name", fallback: "there" }], mediaAssetId: assetId });
  assert.equal(cmp.status, 201, JSON.stringify(cmp.data));
  await a.post("/api/contacts/import", { rows: Array.from({ length: n }, (_, i) => ({ phone: `98400000${String(i).padStart(2, "0")}`, name: `N${i}` })) });
  const ids = (await a.get("/api/contacts?limit=200")).data.contacts.map((c) => c.id);
  await a.put(`/api/campaigns/${cmp.data.campaign.id}/audience`, { contactIds: ids });
  return { id: cmp.data.campaign.id, n: ids.length };
}
const ageUploads = (days) => {
  const up = new Date(Date.now() - days * 86400e3);
  env.DB.raw.prepare("UPDATE media_meta_uploads SET uploaded_at = ?, expires_at = ?").run(up.toISOString(), new Date(up.getTime() + 30 * 86400e3).toISOString());
  env.DB.raw.prepare("UPDATE media_assets SET uploaded_at = ?, expires_at = ?").run(up.toISOString(), new Date(up.getTime() + 30 * 86400e3).toISOString());
};

test("an upload is kept privately in R2 with a Meta upload record; no CRM-side expiry is shown", async () => {
  const res = await a.upload("/api/media", png());
  assert.equal(res.status, 201);
  const asset = res.data.asset;
  assert.equal(asset.stored, true);
  assert.equal(asset.usableUntil, null);
  assert.equal(asset.latestStart, null);
  const row = env.DB.q("SELECT * FROM media_assets WHERE id = ?", asset.id)[0];
  assert.equal(row.r2_key, `assets/acc_atestin/${asset.id}`);
  assert.deepEqual(r2.objects.get(row.r2_key).bytes, png());
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM media_meta_uploads WHERE asset_id = ?", asset.id)[0].n, 1);
});

test("if storage fails, the upload is refused and no image record is created", async () => {
  r2.failPut = true;
  const res = await a.upload("/api/media", png());
  assert.equal(res.status, 502);
  assert.equal(res.data.code, "STORAGE_FAILED");
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM media_assets")[0].n, 0);
});

test("saved images can be reused: listed per account only, and attachable to another campaign", async () => {
  const asset = (await a.upload("/api/media", png())).data.asset;
  assert.deepEqual((await a.get("/api/media")).data.assets.map((x) => x.id), [asset.id]);
  assert.deepEqual((await b.get("/api/media")).data.assets, []);
  await draft(asset.id);
  const second = await draft(asset.id);
  assert.ok(second.id);
  const bt = (await b.get("/api/templates")).data.templates[0];
  assert.equal((await b.post("/api/campaigns", { name: "x", templateId: bt.id, params: [{ type: "text", value: "v" }], mediaAssetId: asset.id })).status, 400);
});

test("a fresh Meta upload is reused at launch (no second upload)", async () => {
  const asset = (await a.upload("/api/media", png())).data.asset;
  const { id } = await draft(asset.id);
  const before = graph.uploads.length;
  assert.equal((await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 })).status, 200);
  await drainQueue(env);
  assert.equal(graph.uploads.length, before);
  assert.equal(graph.sent[0].body.template.components[0].parameters[0].image.id, graph.uploads[0].id);
});

test("stored images can be scheduled far ahead; at the start, an old Meta upload is replaced automatically", async () => {
  const asset = (await a.upload("/api/media", png())).data.asset;
  const { id } = await draft(asset.id);
  const when = new Date(Date.now() + 80 * 86400e3).toISOString();
  const s = await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1, scheduledAt: when });
  assert.equal(s.status, 200, JSON.stringify(s.data));
  ageUploads(29); // the first Meta upload is now too old for the 2-day margin
  env.DB.raw.exec("UPDATE campaigns SET scheduled_at = '2000-01-01T00:00:00.000Z'");
  await scheduled({}, env);
  await drainQueue(env);
  assert.equal(graph.uploads.length, 2, "the saved original was uploaded to Meta again");
  assert.equal(graph.uploads[1].phoneNumberId, PA);
  assert.deepEqual(graph.media[graph.uploads[1].id].bytes, png());
  assert.equal(graph.sent[0].body.template.components[0].parameters[0].image.id, graph.uploads[1].id);
  const c = env.DB.q("SELECT meta_upload_id FROM campaigns WHERE id = ?", id)[0];
  assert.equal(env.DB.q("SELECT meta_media_id FROM media_meta_uploads WHERE id = ?", c.meta_upload_id)[0].meta_media_id, graph.uploads[1].id);
});

test("after a number switch, the saved image is uploaded through the new number and sent with its token", async () => {
  const asset = (await a.upload("/api/media", png())).data.asset;
  const { id } = await draft(asset.id);
  graph.phoneNumbers["100000000005"] = { display_phone_number: "+91 5", verified_name: "n", waba: WABA };
  env.WA_TOKEN_A5 = "tok_A5";
  const s5 = (await a.post("/api/senders", { tokenRef: "A5", phoneNumberId: "100000000005", wabaId: WABA })).data.sender.id;
  await a.post(`/api/senders/${s5}/test`, {});
  assert.equal((await a.post(`/api/senders/${s5}/activate`, {})).status, 200);
  const r = await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await drainQueue(env);
  assert.equal(graph.uploads.at(-1).phoneNumberId, "100000000005");
  assert.equal(graph.sent[0].phoneNumberId, "100000000005");
  assert.equal(graph.sent[0].token, "tok_A5");
  assert.equal(graph.sent[0].body.template.components[0].parameters[0].image.id, graph.uploads.at(-1).id);
});

test("if Meta rejects the re-upload: launch is refused, and a scheduled campaign is cancelled with the reason", async () => {
  const asset = (await a.upload("/api/media", png())).data.asset;
  const { id } = await draft(asset.id);
  ageUploads(29);
  graph.failUpload = true;
  const r = await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
  assert.equal(r.status, 409);
  assert.equal(r.data.code, "MEDIA_REUPLOAD_FAILED");
  const s = await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1, scheduledAt: new Date(Date.now() + 3600e3).toISOString() });
  assert.equal(s.status, 200);
  env.DB.raw.exec("UPDATE campaigns SET scheduled_at = '2000-01-01T00:00:00.000Z'");
  await scheduled({}, env);
  const c = (await a.get(`/api/campaigns/${id}`)).data.campaign;
  assert.equal(c.status, "cancelled");
  assert.match(c.error, /did not accept the saved image/);
  assert.equal(graph.sent.length, 0);
});

test("if storage is missing at start, the campaign isn't sent and says why", async () => {
  const asset = (await a.upload("/api/media", png())).data.asset;
  const { id } = await draft(asset.id);
  ageUploads(29);
  r2.objects.clear();
  const r = await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1 });
  assert.equal(r.data.code, "MEDIA_STORAGE_MISSING");
});

test("the send window never outlives the Meta upload used; a lapsed upload fails queued sends", async () => {
  const asset = (await a.upload("/api/media", png())).data.asset;
  const { id, n } = await draft(asset.id, 2);
  await a.post(`/api/campaigns/${id}/launch`, { confirmCount: n });
  ageUploads(29);
  await drainQueue(env);
  assert.equal(graph.sent.length, 0);
  const rec = (await a.get(`/api/campaigns/${id}/recipients`)).data.recipients;
  assert.ok(rec.every((r) => r.status === "failed"));
});

test("preview of a stored image streams from R2 without asking Meta", async () => {
  const asset = (await a.upload("/api/media", png())).data.asset;
  ageUploads(40); // long past Meta's 30 days
  const before = graph.calls.length;
  const res = await a.raw(asset.previewUrl);
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), png());
  assert.equal(graph.calls.length, before);
});

test("without MEDIA_BUCKET, uploads stay Meta-only with the 30-day rules (unchanged behaviour)", async () => {
  delete env.MEDIA_BUCKET;
  const asset = (await a.upload("/api/media", png())).data.asset;
  assert.equal(asset.stored, false);
  assert.ok(asset.latestStart);
  const { id } = await draft(asset.id);
  const late = new Date(Date.now() + 40 * 86400e3).toISOString();
  assert.equal((await a.post(`/api/campaigns/${id}/launch`, { confirmCount: 1, scheduledAt: late })).data.code, "MEDIA_EXPIRED");
});
