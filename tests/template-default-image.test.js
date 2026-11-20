import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeGraph, createAccount, login, setupSender, template } from "./helpers.js";
import { makeR2 } from "./fake-r2.js";
import { png } from "./fixtures.js";
let env, graph, a, b, image, plain;
const imageTemplate = { id: "mt_default", name: "poster", language: "en", status: "APPROVED", category: "MARKETING", components: [{ type: "HEADER", format: "IMAGE" }, { type: "BODY", text: "Hello" }] };
beforeEach(async () => {
  env = makeEnv({ MEDIA_BUCKET: makeR2() });
  graph = makeGraph(); globalThis.fetch = graph.fetch;
  for (const id of ["a", "b"]) {
    await createAccount(env, { login: `${id}@test.in` });
  }
  a = await login(env, "a@test.in"); b = await login(env, "b@test.in");
  await setupSender(a, graph, env, { ref: "A", phoneNumberId: "100000000001", wabaId: "900000001", display: "+91 1", templates: [imageTemplate, template("plain", { body: "Hello" })] });
  await setupSender(b, graph, env, { ref: "B", phoneNumberId: "200000000002", wabaId: "900000002", display: "+91 2", templates: [imageTemplate] });
  const list = (await a.get("/api/templates")).data.templates;
  image = list.find((t) => t.name === "poster"); plain = list.find((t) => t.name === "plain");
});
const save = (client, id, assetId) => client.put(`/api/templates/${id}/default-image`, { mediaAssetId: assetId });
test("remember once, return preview on future visits, survive sync and lookup, create repeated campaigns without uploads", async () => {
  assert.equal(image.defaultImage, null);
  const asset = (await a.upload("/api/media", png())).data.asset;
  assert.equal((await save(a, image.id, asset.id)).status, 200);
  await a.post("/api/templates/sync");
  const selected = (await a.get("/api/templates")).data.templates.find((t) => t.id === image.id).defaultImage;
  assert.equal(selected.id, asset.id); assert.ok(selected.previewUrl);
  const lookup = await a.post("/api/templates/lookup", { name: "poster", language: "en" });
  assert.equal(lookup.data.template.defaultImage.id, asset.id);
  const uploads = graph.uploads.length;
  for (let i = 0; i < 2; i++) assert.equal((await a.post("/api/campaigns", { name: `Poster ${i}`, templateId: image.id, params: [], mediaAssetId: selected.id })).status, 201);
  assert.equal(graph.uploads.length, uploads); assert.equal(graph.sent.length, 0);
});
test("changing the default does not alter an existing campaign", async () => {
  const first = (await a.upload("/api/media", png())).data.asset;
  await save(a, image.id, first.id);
  const cmp = await a.post("/api/campaigns", { name: "Original", templateId: image.id, params: [], mediaAssetId: first.id });
  const second = (await a.upload("/api/media", png())).data.asset;
  await save(a, image.id, second.id);
  assert.equal((await a.get("/api/templates")).data.templates.find((t) => t.id === image.id).defaultImage.id, second.id);
  assert.equal(env.DB.q("SELECT media_asset_id FROM campaigns WHERE id = ?", cmp.data.campaign.id)[0].media_asset_id, first.id);
});
test("reject another account's asset and template, text templates, missing images, and Meta-only uploads", async () => {
  const foreign = (await b.upload("/api/media", png())).data.asset;
  assert.equal((await save(a, image.id, foreign.id)).status, 400);
  const own = (await a.upload("/api/media", png())).data.asset;
  assert.equal((await save(b, image.id, own.id)).status, 404);
  assert.equal((await save(a, plain.id, own.id)).status, 400);
  assert.equal((await save(a, image.id, "missing")).status, 400);
  env.DB.raw.prepare("UPDATE media_assets SET r2_key = NULL WHERE id = ?").run(own.id);
  assert.equal((await save(a, image.id, own.id)).status, 400);
});
test("storage unavailable or missing object gives an explicit failure without changing the default", async () => {
  const asset = (await a.upload("/api/media", png())).data.asset;
  env.MEDIA_BUCKET.head = async () => null;
  assert.equal((await save(a, image.id, asset.id)).status, 409);
  assert.equal((await a.get("/api/templates")).data.templates.find((t) => t.id === image.id).defaultImage, null);
  env.MEDIA_BUCKET = null;
  assert.equal((await save(a, image.id, asset.id)).status, 409);
});
