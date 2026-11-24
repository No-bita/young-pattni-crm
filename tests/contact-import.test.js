import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, createAccount, login } from "./helpers.js";
import { missingNamesError } from "../src/lib/contact-import.js";
import { parseCsv, toImportRows } from "../web/src/lib/contactCsv.js";

const phone = "9876543210";
for (const [label, rows] of [
  ["missing names", [{ phone }]],
  ["whitespace names", [{ phone, name: " \t " }]],
  ["name only on invalid phone", [{ phone }, { phone: "bad", name: "Riya" }]],
]) {
  test(`import rejects ${label} without any database writes`, async () => {
    const env = makeEnv();
    await createAccount(env, { login: "import@test.in" });
    const client = await login(env, "import@test.in");
    await client.post("/api/contacts", { phone, name: "Existing" });
    const before = env.DB.q("SELECT * FROM contacts");
    env.DB.batch = () => { throw new Error("Rejected import must not write a batch"); };
    const result = await client.post("/api/contacts/import", { importName: "Test import", rows });
    assert.equal(result.status, 400);
    assert.equal(result.data.error, missingNamesError([rows.findIndex((r) => !r.name?.trim()) + 2]));
    assert.equal(result.data.code, "MISSING_IMPORT_NAMES");
    assert.deepEqual(env.DB.q("SELECT * FROM contacts"), before);
  });
}

test("fully named imports still work and preserve suppression, invalid rows and duplicate counts", async () => {
  const env = makeEnv();
  await createAccount(env, { login: "import@test.in" });
  const client = await login(env, "import@test.in");
  await client.post("/api/contacts", { phone, name: "Existing" });
  env.DB.raw.exec("UPDATE contacts SET suppressed=1, suppressed_source='stop'");
  const r = await client.post("/api/contacts/import", { importName: "Test import", nameChoices:{"919876543210":{name:"Final",candidates:["Existing","Riya","Final"]}}, rows: [
    { phone, name: "Riya" }, { phone: "+91 98765 43210", name: "Final" },
    { phone: "9876543211", name: "Other" }, { phone: "bad", name: "Invalid" },
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.data.created, 1);
  assert.equal(r.data.updated, 1);
  assert.equal(r.data.duplicatesInFile, 1);
  assert.equal(r.data.invalid.length, 1);
  assert.equal(env.DB.q("SELECT suppressed FROM contacts WHERE phone_e164='919876543210'")[0].suppressed, 1);
});

test("CSV guard handles missing header, whitespace, aliases, BOM and quoted names", () => {
  for (const [csv, sourceRow] of [["phone\n9876543210", 2], ["phone,name\n9876543210,   ", 2], ["phone,name\n9876543210,\nbad,Riya", 2]]) {
    assert.equal(toImportRows(parseCsv(csv)).error, missingNamesError([sourceRow]));
  }
  const out = toImportRows(parseCsv('\uFEFFMobile,Full Name\r\n9876543210,"Riya, S"\r\n9876543211,Other\r\n'));
  assert.equal(out.error, undefined);
  assert.equal(out.rows[0].name, "Riya, S");
  assert.equal(out.rows.length, 2);
});

test("CSV guard checks the entire file, not just the first five preview rows", () => {
  const rows = Array.from({ length: 6 }, (_, i) => [`987654321${i}`, i === 5 ? "" : "Named"]);
  const out = toImportRows([["phone", "name"], ...rows]);
  assert.equal(out.error, missingNamesError([7]));
});

test("source row numbers survive empty rows and quoted multiline cells", () => {
  const out = toImportRows(parseCsv('phone,name\n9876543210,"Riya\nS"\n\n9876543211,\n'));
  assert.equal(out.error, missingNamesError([4]));
});

test("API reports original spreadsheet rows and caps the list at ten before any write", async () => {
  const env = makeEnv();
  await createAccount(env, { login: "rows@test.in" });
  const client = await login(env, "rows@test.in");
  const rows = Array.from({ length: 12 }, (_, i) => ({ phone, name: "", sourceRow: i + 5 }));
  const r = await client.post("/api/contacts/import", { importName: "Test import", rows });
  assert.equal(r.status, 400);
  assert.equal(r.data.missingNameCount, 12);
  assert.deepEqual(r.data.missingNameRows, [5,6,7,8,9,10,11,12,13,14]);
  assert.equal(r.data.moreMissingNameRows, 2);
  assert.match(r.data.error, /and 2 more/);
  assert.equal(env.DB.q("SELECT * FROM contacts").length, 0);
});

for (const rows of [
  [{ phone, name: "" }, { phone: "+91 98765 43210", name: "Riya" }],
  [{ phone, name: "Riya" }, { phone: "+91 98765 43210", name: " \t " }],
]) {
  test(`named duplicate rescues blank row in order ${rows[0].name ? "named-first" : "blank-first"}`, async () => {
    const env = makeEnv();
    await createAccount(env, { login: "duplicate@test.in" });
    const client = await login(env, "duplicate@test.in");
    const r = await client.post("/api/contacts/import", { importName: "Test import", rows });
    assert.equal(r.status, 200);
    assert.equal(r.data.created, 1);
    assert.equal(r.data.duplicatesInFile, 1);
    assert.equal(env.DB.q("SELECT name FROM contacts")[0].name, "Riya");
    const csv = toImportRows([["phone", "name"], ...rows.map((r) => [r.phone, r.name])]);
    assert.equal(csv.error, undefined);
  });
}

test("only unrescued blank numbers block, with all their original row numbers", async () => {
  const env = makeEnv();
  await createAccount(env, { login: "duplicate@test.in" });
  const client = await login(env, "duplicate@test.in");
  const rows = [
    { phone, name: "", sourceRow: 2 }, { phone, name: "Riya", sourceRow: 3 },
    { phone: "9876543211", name: "", sourceRow: 5 },
    { phone: "+91 98765 43211", name: "", sourceRow: 9 },
    { phone: "invalid", name: "Someone", sourceRow: 10 },
  ];
  const r = await client.post("/api/contacts/import", { importName: "Test import", rows });
  assert.equal(r.status, 400);
  assert.deepEqual(r.data.missingNameRows, [5,9]);
  assert.equal(env.DB.q("SELECT * FROM contacts").length, 0);
});

test("explicit chosen duplicate name wins, never a trailing blank", async () => {
  const env = makeEnv();
  await createAccount(env, { login: "duplicate@test.in" });
  const client = await login(env, "duplicate@test.in");
  const r = await client.post("/api/contacts/import", { importName: "Test import", nameChoices:{"919876543210":{name:"Final",candidates:["First","Final"]}}, rows: [
    { phone, name: "First" }, { phone, name: "Final" }, { phone, name: "" },
  ] });
  assert.equal(r.status, 200);
  assert.equal(r.data.duplicatesInFile, 2);
  assert.equal(env.DB.q("SELECT name FROM contacts")[0].name, "Final");
});
