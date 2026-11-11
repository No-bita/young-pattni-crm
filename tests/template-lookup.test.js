// Manual entry: look up ONE approved template by exact name + language in the active
// number's Messaging account. All Meta traffic is a local fake.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, makeGraph, createAccount, login, setupSender, drainQueue, template } from "./helpers.js";
import { png } from "./fixtures.js";

const PA = "100000000001";
const WABA = "900000001";
let env, graph, a, b;

const imageTpl = (name, { status = "APPROVED", language = "en", body = "Hi {{1}}, camp is open", extra = [] } = {}) => ({
  id: `mt_${name}_${language}`, name, language, status, category: "MARKETING",
  components: [{ type: "HEADER", format: "IMAGE", example: { header_handle: ["https://scontent.whatsapp.net/v/x?oe=1"] } }, { type: "BODY", text: body }, ...extra],
});

beforeEach(async () => {
  env = makeEnv();
  graph = makeGraph();
  globalThis.fetch = graph.fetch;
  await createAccount(env, { login: "a@test.in" });
  await createAccount(env, { login: "b@test.in" });
  a = await login(env, "a@test.in");
  b = await login(env, "b@test.in");
  // Sync sees only the text template; the image template exists in Meta but was added afterwards.
  await setupSender(a, graph, env, { ref: "A1", phoneNumberId: PA, wabaId: WABA, display: "+91 90000 00001", templates: [template("weekly_update", { body: "Hello {{1}}" })] });
  await setupSender(b, graph, env, { ref: "B1", phoneNumberId: "200000000002", wabaId: "900000002", display: "+91 2", templates: [] });
  graph.templates[WABA].push(imageTpl("youth_camp_poster"), imageTpl("youth_camp_poster_v2"), imageTpl("youth_camp_poster", { language: "hi" }));
});

const lookup = (client, name, language) => client.post("/api/templates/lookup", { name, language });

test("finds one approved image template by exact name and language, saves it, and makes it pickable", async () => {
  const before = graph.templateQueries.length;
  const res = await lookup(a, "youth_camp_poster", "en");
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.template.name, "youth_camp_poster");
  assert.equal(res.data.template.language, "en");
  assert.equal(res.data.template.usable, true);
  assert.equal(res.data.template.needsImage, true);
  const q = graph.templateQueries.slice(before);
  assert.equal(q.length, 1);
  assert.deepEqual([q[0].waba, q[0].name, q[0].language], [WABA, "youth_camp_poster", "en"]);
  assert.equal(q[0].fields, "id,name,language,status,category,components");
  const list = (await a.get("/api/templates")).data.templates.map((t) => `${t.name}/${t.language}`);
  assert.ok(list.includes("youth_camp_poster/en"));
  assert.ok(!list.includes("youth_camp_poster_v2/en"), "near-matches from Meta's filter are not saved");
  assert.ok(!list.includes("youth_camp_poster/hi"), "other languages are not saved");
  assert.ok(!JSON.stringify(res.data).includes("scontent"), "the approval sample URL is not exposed");
});

test("a looked-up image template goes through the normal image campaign path end to end", async () => {
  const t = (await lookup(a, "youth_camp_poster", "en")).data.template;
  const asset = (await a.upload("/api/media", png())).data.asset;
  const cmp = await a.post("/api/campaigns", { name: "Camp", templateId: t.id, params: [{ type: "contact_name", fallback: "there" }], mediaAssetId: asset.id });
  assert.equal(cmp.status, 201, JSON.stringify(cmp.data));
  const c = (await a.post("/api/contacts", { phone: "9811111111", name: "Riya" })).data.contact;
  await a.put(`/api/campaigns/${cmp.data.campaign.id}/audience`, { contactIds: [c.id] });
  assert.equal((await a.post(`/api/campaigns/${cmp.data.campaign.id}/launch`, { confirmCount: 1 })).status, 200);
  await drainQueue(env);
  assert.equal(graph.sent.length, 1);
  const sent = graph.sent[0].body.template;
  assert.equal(sent.name, "youth_camp_poster");
  assert.equal(sent.language.code, "en");
  assert.equal(sent.components[0].type, "header");
});

test("a later full sync does not undo a lookup, and a lookup does not mark other templates missing", async () => {
  await lookup(a, "youth_camp_poster", "en");
  const statuses = () => Object.fromEntries(env.DB.q("SELECT name || '/' || language AS k, status FROM templates WHERE account_id = 'acc_atestin'").map((r) => [r.k, r.status]));
  assert.equal(statuses()["weekly_update/en"], "APPROVED");
  await a.post("/api/templates/sync");
  assert.equal(statuses()["youth_camp_poster/en"], "APPROVED");
});

test("not found: wrong name or wrong language gives a clear 404 and saves nothing", async () => {
  const count = () => env.DB.q("SELECT COUNT(*) AS n FROM templates WHERE account_id = 'acc_atestin'")[0].n;
  const n = count();
  const r1 = await lookup(a, "youth_camp_postr", "en");
  assert.equal(r1.status, 404);
  assert.equal(r1.data.code, "NOT_FOUND");
  assert.match(r1.data.error, /Messaging account/);
  assert.equal((await lookup(a, "youth_camp_poster", "en_US")).status, 404);
  // Meta's name filter can return near-matches ("camp_poster" matches "youth_camp_poster"); only an exact match counts.
  assert.equal((await lookup(a, "camp_poster", "en")).status, 404);
  assert.equal(count(), n);
});

test("found but not usable: the reason is returned (pending, unsupported header, unsupported button)", async () => {
  graph.templates[WABA].push(
    imageTpl("pending_poster", { status: "PENDING" }),
    { id: "v", name: "camp_video", language: "en", status: "APPROVED", components: [{ type: "HEADER", format: "VIDEO" }, { type: "BODY", text: "x" }] },
    imageTpl("poster_link", { extra: [{ type: "BUTTONS", buttons: [{ type: "URL", text: "Open", url: "https://e.org/r/{{1}}" }] }] }),
  );
  const p = (await lookup(a, "pending_poster", "en")).data.template;
  assert.equal(p.usable, false);
  assert.match(p.unsupportedReason, /PENDING/);
  assert.match((await lookup(a, "camp_video", "en")).data.template.unsupportedReason, /Video headers/);
  assert.match((await lookup(a, "poster_link", "en")).data.template.unsupportedReason, /URL buttons with a variable/);
  const create = await a.post("/api/campaigns", { name: "x", templateId: p.id, params: [{ type: "text", value: "v" }] });
  assert.equal(create.status, 400);
});

test("input is validated before calling Meta", async () => {
  const before = graph.templateQueries.length;
  for (const [name, language, code] of [["Youth Camp", "en", "BAD_NAME"], ["", "en", "BAD_NAME"], ["camp&name=x", "en", "BAD_NAME"], ["camp", "english", "BAD_LANGUAGE"], ["camp", "en-US", "BAD_LANGUAGE"], ["camp", "", "BAD_LANGUAGE"]]) {
    const r = await lookup(a, name, language);
    assert.equal(r.status, 400, `${name}/${language}`);
    assert.equal(r.data.code, code);
  }
  assert.equal(graph.templateQueries.length, before);
});

test("lookup is scoped to the signed-in account's active number", async () => {
  // B's Messaging account doesn't have A's template, and B's lookup only queries B's WABA.
  const before = graph.templateQueries.length;
  assert.equal((await lookup(b, "youth_camp_poster", "en")).status, 404);
  assert.deepEqual(graph.templateQueries.slice(before).map((q) => q.waba), ["900000002"]);
  await lookup(a, "youth_camp_poster", "en");
  assert.equal(env.DB.q("SELECT COUNT(*) AS n FROM templates WHERE account_id = 'acc_btestin' AND name = 'youth_camp_poster'")[0].n, 0);
  const anon = new (a.constructor)(env);
  assert.equal((await lookup(anon, "youth_camp_poster", "en")).status, 401);
});

test("no active number and Meta errors are reported plainly", async () => {
  graph.failTemplates = true;
  const r = await lookup(a, "youth_camp_poster", "en");
  assert.equal(r.status, 502);
  assert.match(r.data.error, /Could not look up/);
  graph.failTemplates = false;
  env.DB.raw.exec("UPDATE senders SET status = 'inactive' WHERE account_id = 'acc_atestin'");
  assert.equal((await lookup(a, "youth_camp_poster", "en")).status, 409);
});
