import test from "node:test";
import assert from "node:assert/strict";
import { createAccount, makeEnv, makeGraph, login, setupSender, template, Client } from "./helpers.js";
import { inspectMetaTemplate, templateInventory, INSPECTION_MAX_BYTES, INSPECTION_TIMEOUT_MS } from "../src/lib/template-inspection.js";
import { inspectionGate, claimInspection } from "../src/lib/template-inspection-gate.js";

const privateValue = "DO_NOT_EXPOSE_private_person_token_path";
const metaId = "123456789012345";
const json = (v, status = 200, headers = {}) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json", ...headers } });
const raw = () => ({ id: metaId, name: privateValue, language: "en", status: "APPROVED", category: "MARKETING", parameter_format: "NAMED", last_updated_time: 123,
  [privateValue]: privateValue,
  components: [
    { type: "HEADER", format: "IMAGE", text: privateValue, example: { header_handle: [`https://scontent.whatsapp.net/${privateValue}?access_token=${privateValue}#${privateValue}`, `4::${privateValue}`, metaId, `https://${privateValue}.example/x`], header_text: [privateValue], [privateValue]: privateValue } },
    { type: "BODY", text: `${privateValue} {{private_name}} {{1}}`, example: { body_text: [[privateValue]], body_text_named_params: [{ param_name: privateValue, example: privateValue }] } },
    { type: "FOOTER", text: privateValue },
    { type: "BUTTONS", buttons: [{ type: "URL", text: privateValue, url: `https://example.com/${privateValue}?${privateValue}=${privateValue}`, example: [privateValue] }, { type: "PHONE_NUMBER", phone_number: privateValue }] },
  ] });
const envForRead = () => ({ GRAPH_API_VERSION: "v23.0", WA_TOKEN_TEST: privateValue });
const sender = { token_ref: "TEST" };
const read = () => inspectMetaTemplate(envForRead(), sender, metaId);

test("inventory never returns arbitrary content, names, signed values, paths or unknown field names", () => {
  const out = templateInventory(raw());
  const text = JSON.stringify(out);
  assert.ok(!text.includes(privateValue));
  assert.ok(!text.includes("private_name"));
  assert.ok(!text.includes(metaId));
  assert.ok(!text.includes("access_token"));
  assert.equal(out.components[0].example.headerHandle.items[0].hostname, "scontent.whatsapp.net");
  assert.equal(out.components[0].example.headerHandle.items[1].kind, "upload_handle");
  assert.equal(out.components[0].example.headerHandle.items[3].hostname, "hidden_non_meta_host");
  assert.equal(out.components[1].text.namedCount, 1);
  assert.equal(out.components[1].text.positionalCount, 1);
  assert.equal(out.reuseVerified, false);
});

test("absent and null samples remain distinct; malformed structures fail closed", () => {
  const out = templateInventory({ components: [{ type: "HEADER", example: null }, { type: "BODY" }] });
  assert.equal(out.components[0].example.state, "null");
  assert.equal(out.components[1].example.state, "absent");
  for (const value of [null, [], { components: null }, { components: [null] }, { components: [{ buttons: null }] }, { components: Array(31).fill({}) }]) {
    assert.throws(() => templateInventory(value), /INVALID_RESPONSE/);
  }
});

test("enum-like upstream values cannot smuggle arbitrary strings", () => {
  const out = templateInventory({ status: privateValue, parameter_format: privateValue, components: [{ type: privateValue, format: privateValue, buttons: [{ type: privateValue }] }] });
  assert.ok(!JSON.stringify(out).includes(privateValue));
  assert.equal(out.status, "OTHER");
});

test("one fixed-host GET uses header credential, exact configured version, no redirect or pagination", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (url, init) => {
      calls++;
      const u = new URL(url);
      assert.equal(u.hostname, "graph.facebook.com");
      assert.equal(u.pathname, `/v23.0/${metaId}`);
      assert.ok(!u.href.includes(privateValue));
      assert.equal(init.method, "GET");
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers.Authorization, `Bearer ${privateValue}`);
      assert.ok(init.signal instanceof AbortSignal);
      assert.ok(u.searchParams.get("fields").includes("components"));
      return json({ ...raw(), paging: { next: `https://evil.example/?token=${privateValue}` } });
    };
    const out = await read();
    assert.equal(calls, 1);
    assert.equal(out.requestCount, 1);
    assert.ok(!JSON.stringify(out).includes(privateValue));
  } finally { globalThis.fetch = original; }
});

test("invalid configuration and missing credential make zero requests", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw Error(privateValue); };
    await assert.rejects(inspectMetaTemplate({ ...envForRead(), GRAPH_API_VERSION: "https://evil.example" }, sender, metaId), /INVALID_CONFIGURATION/);
    await assert.rejects(inspectMetaTemplate({}, sender, metaId), /CREDENTIAL_UNAVAILABLE/);
    await assert.rejects(inspectMetaTemplate(envForRead(), sender, "../evil"), /INVALID_CONFIGURATION/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("upstream error messages and network exceptions are not propagated", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => json({ error: { message: privateValue, type: privateValue, code: 100, error_subcode: 33, details: privateValue } }, 400);
    await assert.rejects(read(), (e) => e.code === "META_REQUEST_FAILED" && e.metaCode === 100 && e.metaSubcode === 33 && !JSON.stringify(e).includes(privateValue));
    globalThis.fetch = async () => { throw Error(privateValue); };
    await assert.rejects(read(), (e) => e.code === "META_UNAVAILABLE" && !String(e.stack).includes(privateValue));
  } finally { globalThis.fetch = original; }
});

test("redirect, wrong ID, wrong content type and malformed JSON fail closed", async () => {
  const original = globalThis.fetch;
  try {
    for (const [response, code] of [
      [new Response(null, { status: 302, headers: { Location: `https://evil.example/${privateValue}` } }), "REDIRECT_REFUSED"],
      [json({ ...raw(), id: "99999999" }), "INVALID_RESPONSE"],
      [new Response(JSON.stringify(raw()), { headers: { "Content-Type": "text/html" } }), "INVALID_RESPONSE"],
      [new Response("bad JSON " + privateValue, { headers: { "Content-Type": "application/json" } }), "INVALID_RESPONSE"],
    ]) {
      globalThis.fetch = async () => response;
      await assert.rejects(read(), (e) => e.code === code && !JSON.stringify(e).includes(privateValue));
    }
  } finally { globalThis.fetch = original; }
});

test("both declared and streamed response sizes are bounded", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => json(raw(), 200, { "Content-Length": String(INSPECTION_MAX_BYTES + 1) });
    await assert.rejects(read(), /RESPONSE_TOO_LARGE/);
    globalThis.fetch = async () => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(INSPECTION_MAX_BYTES + 1)); c.close(); } }), { headers: { "Content-Type": "application/json" } });
    await assert.rejects(read(), /RESPONSE_TOO_LARGE/);
  } finally { globalThis.fetch = original; }
});

test("deadline ends a stalled request without requiring upstream cooperation", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Promise(() => {});
    const started = Date.now();
    await assert.rejects(read(), /META_TIMEOUT/);
    assert.ok(Date.now() - started < INSPECTION_TIMEOUT_MS + 2000);
  } finally { globalThis.fetch = original; }
});

test("gate is off by default, account scoped, time bounded and reversible", () => {
  const now = Date.now();
  const env = { TEMPLATE_INSPECTION_ACCOUNT_ID: "acc_test", TEMPLATE_INSPECTION_TEMPLATE_ID: "tpl_test", TEMPLATE_INSPECTION_FROM: new Date(now - 1000).toISOString(), TEMPLATE_INSPECTION_UNTIL: new Date(now + 60000).toISOString() };
  assert.equal(inspectionGate({}, "acc_test"), null);
  assert.equal(inspectionGate(env, "other"), null);
  assert.ok(inspectionGate(env, "acc_test"));
  assert.equal(inspectionGate(env, "acc_test", now + 60000), null);
  assert.equal(inspectionGate({ ...env, TEMPLATE_INSPECTION_UNTIL: new Date(now + 31 * 60000).toISOString() }, "acc_test"), null);
  assert.equal(inspectionGate({ ...env, TEMPLATE_INSPECTION_FROM: "bad" }, "acc_test"), null);
});

test("isolate limiter blocks in-flight and cooldown without claiming a global quota", () => {
  const gate = { key: "limiter-unit" };
  const release = claimInspection(gate, 100000);
  assert.equal(typeof release, "function");
  assert.equal(claimInspection(gate, 200000), null);
  release();
  assert.equal(claimInspection(gate, 100001), null);
  const later = claimInspection(gate, 160000);
  assert.equal(typeof later, "function");
  later();
});

async function fixture() {
  const graph = makeGraph();
  globalThis.fetch = graph.fetch;
  const env = makeEnv();
  const account = await createAccount(env, { login: "inspect@example.test" });
  const client = await login(env, "inspect@example.test");
  const sid = await setupSender(client, graph, env, { ref: "MAIN", phoneNumberId: "111111111111", wabaId: "222222222222", display: "+910000000001", templates: [{ ...template("image_offer", { header: "IMAGE" }), id: metaId }] });
  const t = env.DB.q("SELECT * FROM templates WHERE account_id = ?", account)[0];
  Object.assign(env, { TEMPLATE_INSPECTION_ACCOUNT_ID: account, TEMPLATE_INSPECTION_TEMPLATE_ID: t.id,
    TEMPLATE_INSPECTION_FROM: new Date(Date.now() - 1000).toISOString(), TEMPLATE_INSPECTION_UNTIL: new Date(Date.now() + 60000).toISOString() });
  return { env, account, client, sid, t, graph };
}
const post = (c, id, headers = {}) => c.req("POST", `/api/templates/${id}/inspect`, undefined, { Origin: "https://sb.test", "X-Template-Inspection": "1", ...headers });

test("route enforces login, exact origin, header, enabled scope and local ownership before Meta", async () => {
  const original = globalThis.fetch;
  try {
    const { env, account, client, t } = await fixture();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return json(raw()); };
    assert.equal((await post(new Client(env), t.id)).status, 401);
    assert.equal((await post(client, t.id, { Origin: "https://evil.test" })).status, 403);
    assert.equal((await post(client, t.id, { "X-Template-Inspection": "" })).status, 403);
    assert.equal((await post(client, t.id, { "Sec-Fetch-Site": "cross-site" })).status, 403);
    assert.equal((await post(client, "wrong-local-id")).status, 404);
    const otherAccount = await createAccount(env, { login: "other@example.test" });
    const other = await login(env, "other@example.test");
    assert.equal((await post(other, t.id)).status, 404);
    env.TEMPLATE_INSPECTION_ACCOUNT_ID = otherAccount;
    assert.equal((await post(client, t.id)).status, 404);
    assert.equal((await post(other, t.id)).status, 404);
    env.TEMPLATE_INSPECTION_ACCOUNT_ID = account;
    env.TEMPLATE_INSPECTION_UNTIL = new Date(Date.now() - 1).toISOString();
    assert.equal((await post(client, t.id)).status, 404);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("valid route reads once, writes no business data, emits no raw values and blocks repeat", async () => {
  const original = globalThis.fetch;
  try {
    const { env, client, t } = await fixture();
    const before = JSON.stringify(env.DB.q("SELECT * FROM templates"));
    let calls = 0;
    globalThis.fetch = async () => { calls++; return json(raw()); };
    const status = await client.get("/api/templates/inspection");
    assert.equal(status.data.enabled, true);
    const r = await post(client, t.id);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("Cache-Control"), "no-store");
    assert.equal(r.data.requestCount, 1);
    assert.ok(!JSON.stringify(r.data).includes(privateValue));
    assert.equal((await post(client, t.id)).status, 429);
    assert.equal(calls, 1);
    assert.equal(JSON.stringify(env.DB.q("SELECT * FROM templates")), before);
    assert.equal(env.DB.q("SELECT * FROM messages").length, 0);
    assert.equal(env.CAMPAIGN_QUEUE.sent.length, 0);
  } finally { globalThis.fetch = original; }
});

test("sender switch and WABA mismatch prevent read", async () => {
  const original = globalThis.fetch;
  try {
    const { env, client, t, sid } = await fixture();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return json(raw()); };
    await env.DB.prepare("UPDATE senders SET waba_id = ? WHERE id = ?").bind("different", sid).run();
    assert.equal((await post(client, t.id)).status, 404);
    assert.equal((await client.get("/api/templates/inspection")).data.enabled, false);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("route refuses overlap and sanitizes upstream failures without raw error logs", async () => {
  const original = globalThis.fetch;
  const originalError = console.error;
  let logs = "";
  try {
    const { env, client, t } = await fixture();
    console.error = (...args) => { logs += args.join(" "); };
    let resolve;
    let calls = 0;
    globalThis.fetch = async () => { calls++; return new Promise((r) => { resolve = r; }); };
    const pending = post(client, t.id);
    while (!resolve) await new Promise((r) => setTimeout(r, 1));
    assert.equal((await post(client, t.id)).status, 429);
    resolve(json({ error: { message: privateValue, type: privateValue, code: 100, error_subcode: 33 } }, 403));
    const response = await pending;
    assert.equal(response.status, 502);
    assert.equal(response.data.metaCode, 100);
    assert.ok(!JSON.stringify(response.data).includes(privateValue));
    assert.ok(!logs.includes(privateValue));
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; console.error = originalError; }
});

test("route refuses missing Meta ID without fetching", async () => {
  const original = globalThis.fetch;
  try {
    const { env, client, t } = await fixture();
    await env.DB.prepare("UPDATE templates SET meta_template_id = NULL WHERE id = ?").bind(t.id).run();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return json(raw()); };
    const r = await post(client, t.id);
    assert.equal(r.status, 409);
    assert.equal(r.data.code, "INVALID_CONFIGURATION");
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("ownership reassignment and inactive sender both hide status and block inspection", async () => {
  const original = globalThis.fetch;
  try {
    const { env, client, t, sid } = await fixture();
    let calls = 0;
    globalThis.fetch = async () => { calls++; return json(raw()); };
    await env.DB.prepare("UPDATE senders SET status = 'inactive' WHERE id = ?").bind(sid).run();
    assert.equal((await post(client, t.id)).status, 404);
    assert.equal((await client.get("/api/templates/inspection")).data.enabled, false);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("unknown or attacker-controlled URL fields cannot escape redaction", () => {
  const t = raw();
  t.components[0].example.header_handle = ["https://private-label.whatsapp.net/userinfo/private?secret=token", "https://username:password@scontent.whatsapp.net/private?secret=token", "https://scontent.whatsapp.net.evil.example/private", null];
  const s = JSON.stringify(templateInventory(t));
  for (const secret of ["private-label", "userinfo", "username", "password", "secret=", "evil.example"]) assert.ok(!s.includes(secret));
  assert.ok(s.includes("scontent.whatsapp.net"));
});


test("omitted components is inventoried as absent, not an invalid response", () => {
  const out = templateInventory({ id: metaId, status: "APPROVED" });
  assert.equal(out.componentsState, "absent");
  assert.deepEqual(out.components, []);
  assert.ok(out.missingFields.includes("components"));
  assert.equal(out.reuseVerified, false);
  assert.throws(() => templateInventory({ components: null }), /INVALID_RESPONSE/);
});

test("real Node fetch manual redirect returns refusal without following target", async () => {
  const { createServer } = await import("node:http");
  const original = globalThis.fetch;
  let sourceCalls = 0, targetCalls = 0;
  const server = createServer((req, res) => {
    if (req.url === "/redirect") { sourceCalls++; res.writeHead(302, { Location: "/target" }); res.end(); }
    else { targetCalls++; res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(raw())); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    // Test transport substitutes localhost only. Production code remains fixed to Meta.
    globalThis.fetch = async (_url, init) => {
      assert.equal(init.redirect, "manual");
      return original(`http://127.0.0.1:${address.port}/redirect`, init);
    };
    await assert.rejects(read(), (e) => e.code === "REDIRECT_REFUSED");
    assert.equal(sourceCalls, 1);
    assert.equal(targetCalls, 0);
  } finally {
    globalThis.fetch = original;
    await new Promise((resolve) => server.close(resolve));
  }
});

const reasonCases = [
  ["CONTENT_TYPE", () => new Response(privateValue, { headers: { "Content-Type": "text/html" } })],
  ["BODY_MISSING", () => new Response(null, { headers: { "Content-Type": "application/json" } })],
  ["UTF8_INVALID", () => new Response(new Uint8Array([0xc3, 0x28]), { headers: { "Content-Type": "application/json" } })],
  ["JSON_INVALID", () => new Response(privateValue, { headers: { "Content-Type": "application/json" } })],
  ["ROOT_TYPE", () => json([privateValue])],
  ["ID_MISSING", () => json({ name: privateValue })],
  ["ID_MISMATCH", () => json({ id: "99999999", name: privateValue })],
  ["COMPONENTS_TYPE", () => json({ id: metaId, components: null })],
  ["COMPONENTS_LIMIT", () => json({ id: metaId, components: Array(31).fill({ text: privateValue }) })],
  ["COMPONENT_TYPE", () => json({ id: metaId, components: [privateValue] })],
  ["BUTTONS_TYPE", () => json({ id: metaId, components: [{ buttons: {} }] })],
  ["BUTTONS_LIMIT", () => json({ id: metaId, components: [{ buttons: Array(21).fill({ text: privateValue }) }] })],
  ["BUTTON_TYPE", () => json({ id: metaId, components: [{ buttons: [privateValue] }] })],
  ["HEADER_REFERENCES_LIMIT", () => json({ id: metaId, components: [{ example: { header_handle: Array(11).fill(privateValue) } }] })],
  ["EXAMPLE_VALUES_LIMIT", () => json({ id: metaId, components: [{ example: { body_text: [Array(41).fill(privateValue)] } }] })],
];
for (const [reason, response] of reasonCases) {
  test(`fixed failure reason ${reason} survives route without private response values or logs`, async () => {
    const original = globalThis.fetch;
    const originalError = console.error;
    let logs = "";
    try {
      const { env, client, t } = await fixture();
      const before = JSON.stringify(env.DB.q("SELECT * FROM templates"));
      let calls = 0;
      console.error = (...args) => { logs += args.join(" "); };
      globalThis.fetch = async () => { calls++; return response(); };
      const result = await post(client, t.id);
      assert.equal(result.status, 502);
      assert.equal(result.data.code, "INVALID_RESPONSE");
      assert.equal(result.data.reason, reason);
      assert.equal(result.headers.get("Cache-Control"), "no-store");
      assert.ok(!JSON.stringify(result.data).includes(privateValue));
      assert.ok(!JSON.stringify(result.data).includes(metaId));
      assert.equal(logs, "");
      assert.equal(calls, 1);
      assert.equal(JSON.stringify(env.DB.q("SELECT * FROM templates")), before);
      assert.equal(env.DB.q("SELECT * FROM messages").length, 0);
      assert.equal(env.CAMPAIGN_QUEUE.sent.length, 0);
      assert.equal((await post(client, t.id)).status, 429);
      assert.equal(calls, 1);
    } finally { globalThis.fetch = original; console.error = originalError; }
  });
}

test("failure reason allowlist rejects arbitrary values and non-response errors", async () => {
  const { InspectionError, safeInspectionReason } = await import("../src/lib/template-inspection.js");
  for (const value of [privateValue, "content_type", {}, ["CONTENT_TYPE"], null, undefined]) {
    assert.equal(safeInspectionReason(value), null);
    assert.equal(new InspectionError("INVALID_RESPONSE", 502, null, null, value).reason, null);
  }
  assert.equal(new InspectionError("META_UNAVAILABLE", 502, null, null, "ID_MISMATCH").reason, null);
  assert.equal(new InspectionError("INVALID_RESPONSE", 502, null, null, "ID_MISMATCH").reason, "ID_MISMATCH");
});

test("success and non-response failures do not claim a validation reason", async () => {
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async () => json(raw());
    assert.equal(Object.hasOwn(await read(), "reason"), false);
    globalThis.fetch = async () => json({ error: { code: 100, message: privateValue, reason: "ID_MISMATCH" } }, 400);
    await assert.rejects(read(), (e) => e.code === "META_REQUEST_FAILED" && e.reason === null);
    globalThis.fetch = async () => { throw Error(privateValue); };
    await assert.rejects(read(), (e) => e.code === "META_UNAVAILABLE" && e.reason === null);
  } finally { globalThis.fetch = original; }
});
