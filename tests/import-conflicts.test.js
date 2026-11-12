// Tests for the import conflict review (check endpoint, update/discard resolutions, repeat choices).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, createAccount, login } from "./helpers.js";

let env, a;

beforeEach(async () => {
  env = makeEnv();
  await createAccount(env, { login: "a@test.in" });
  a = await login(env, "a@test.in");
});

const imp = (rows, extra = {}) => a.post("/api/contacts/import", { rows, ...extra });
const check = (rows) => a.post("/api/contacts/import/check", { rows });
const saved = (phone) => env.DB.q("SELECT name, suppressed FROM contacts WHERE phone_e164 = ?", `91${phone}`)[0];

async function seed(phone, name, suppressed = 0) {
  await env.DB.prepare("INSERT INTO contacts (id, account_id, phone_e164, name, suppressed, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(`cnt_${phone}`, "acc_atestin", `91${phone}`, name, suppressed, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z").run();
}

test("check flags a saved contact whose name would change, with its opt-out state", async () => {
  await seed("9830000001", "Old Name", 1);
  const res = await check([{ phone: "9830000001", name: "New Name" }]);
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual(res.data.conflicts, [{ phone: "919830000001", phoneDisplay: "+919830000001", savedName: "Old Name", incomingNames: ["New Name"], optedOut: true }]);
  assert.deepEqual(res.data.repeats, []);
});

test("check stays quiet for identical names, empty incoming names and new numbers", async () => {
  await seed("9830000002", "Same");
  await seed("9830000003", "Kept");
  const res = await check([
    { phone: "9830000002", name: "Same" },
    { phone: "9830000003", name: "" },
    { phone: "9830000004", name: "Brand New" },
  ]);
  assert.deepEqual(res.data.conflicts, []);
  assert.deepEqual(res.data.repeats, []);
});

test("check flags numbers repeated in the file with different names", async () => {
  const res = await check([
    { phone: "9830000005", name: "First" },
    { phone: "9830000006", name: "Alone" },
    { phone: "9830000005", name: "Second" },
  ]);
  assert.deepEqual(res.data.repeats, [{ phone: "919830000005", phoneDisplay: "+919830000005", names: [{ name: "First", row: 1 }, { name: "Second", row: 3 }] }]);
});

test("a blank-versus-name repeat is flagged with a No name option, whichever order the rows come in", async () => {
  const chk = await check([{ phone: "9830000007", name: "Named" }, { phone: "9830000007", name: "" }]);
  assert.deepEqual(chk.data.repeats, [{ phone: "919830000007", phoneDisplay: "+919830000007", names: [{ name: "Named", row: 1 }, { name: "", row: 2 }] }]);
  const chk2 = await check([{ phone: "9830000007", name: "" }, { phone: "9830000007", name: "Named" }]);
  assert.equal(chk2.data.repeats.length, 1);
});

test("the blank-versus-name choice applies explicitly, including choosing No name", async () => {
  const res = await imp([{ phone: "9830000007", name: "Named" }, { phone: "9830000007", name: "" }], { repeatChoices: { "919830000007": "Named" } });
  assert.equal(res.data.created, 1);
  assert.equal(saved("9830000007").name, "Named");
  const res2 = await imp([{ phone: "9830000008", name: "Named" }, { phone: "9830000008", name: "" }], { repeatChoices: { "919830000008": "" } });
  assert.equal(res2.data.created, 1);
  assert.equal(saved("9830000008").name, "");
});

test("a blank repeat choice is rejected when the file has no blank row for that number", async () => {
  const res = await imp([{ phone: "9830000009", name: "First" }, { phone: "9830000009", name: "Second" }], { repeatChoices: { "919830000009": "" } });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, "BAD_REPEAT_CHOICE");
});

test("rows repeated identically, including all-blank names, are not flagged", async () => {
  const chk = await check([
    { phone: "9830000019", name: "Same" }, { phone: "9830000019", name: "Same" },
    { phone: "9830000020", name: "" }, { phone: "9830000020", name: "" },
  ]);
  assert.deepEqual(chk.data.repeats, []);
});

test("discard keeps the saved name and counts as unchanged; update replaces it", async () => {
  await seed("9830000010", "Old A");
  await seed("9830000011", "Old B");
  const res = await imp(
    [{ phone: "9830000010", name: "New A" }, { phone: "9830000011", name: "New B" }],
    { resolutions: { "919830000010": "discard", "919830000011": "update" } },
  );
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.deepEqual([res.data.created, res.data.updated, res.data.unchanged], [0, 1, 1]);
  assert.equal(saved("9830000010").name, "Old A");
  assert.equal(saved("9830000011").name, "New B");
});

test("discarding an opted-out contact preserves both its name and its opt-out", async () => {
  await seed("9830000012", "Old Name", 1);
  const res = await imp([{ phone: "9830000012", name: "New Name" }], { resolutions: { "919830000012": "discard" } });
  assert.equal(res.data.unchanged, 1);
  assert.equal(saved("9830000012").name, "Old Name");
  assert.equal(saved("9830000012").suppressed, 1);
});

test("without resolutions the existing behaviour is unchanged: a differing name updates silently", async () => {
  await seed("9830000013", "Old");
  const res = await imp([{ phone: "9830000013", name: "New" }]);
  assert.equal(res.data.updated, 1);
  assert.equal(saved("9830000013").name, "New");
});

test("repeat choice picks the chosen name for a new contact; without a choice the last row wins", async () => {
  const res = await imp([{ phone: "9830000014", name: "First" }, { phone: "9830000014", name: "Second" }], { repeatChoices: { "919830000014": "First" } });
  assert.equal(res.data.created, 1);
  assert.equal(saved("9830000014").name, "First");
  await imp([{ phone: "9830000015", name: "First" }, { phone: "9830000015", name: "Second" }]);
  assert.equal(saved("9830000015").name, "Second");
});

test("repeat choice combines with update resolution for an existing contact", async () => {
  await seed("9830000016", "Old");
  const res = await imp(
    [{ phone: "9830000016", name: "First" }, { phone: "9830000016", name: "Second" }],
    { resolutions: { "919830000016": "update" }, repeatChoices: { "919830000016": "First" } },
  );
  assert.equal(res.data.updated, 1);
  assert.equal(saved("9830000016").name, "First");
});

test("a repeat choice that does not match the file is rejected", async () => {
  const res = await imp([{ phone: "9830000017", name: "First" }, { phone: "9830000017", name: "Second" }], { repeatChoices: { "919830000017": "Not In File" } });
  assert.equal(res.status, 400);
  assert.equal(res.data.code, "BAD_REPEAT_CHOICE");
});

test("an invalid resolution value is rejected", async () => {
  const res = await imp([{ phone: "9830000018", name: "A" }], { resolutions: { "919830000018": "merge" } });
  assert.equal(res.status, 400);
});

test("check validates input like import does", async () => {
  assert.equal((await check([])).status, 400);
  assert.equal((await check([{ phone: "not a phone", name: "X" }])).data.invalidCount, 1);
});
