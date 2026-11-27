import test from "node:test";
import assert from "node:assert/strict";
import { defaultNameChoices } from "../web/src/lib/nameDefaults.js";

test("conflicts default to the name from the later file row", () => {
  const out = defaultNameChoices([{ phone: "919800000001", candidates: [
    { name: "Asha", rows: [2], existing: false },
    { name: "Asha K", rows: [7, 9], existing: false },
    { name: "Old", rows: [], existing: true },
  ] }]);
  assert.equal(out["919800000001"].name, "Asha K");
  assert.deepEqual(out["919800000001"].candidates, ["Asha", "Asha K", "Old"]);
});

test("a file name beats an existing contact name", () => {
  const out = defaultNameChoices([{ phone: "1", candidates: [{ name: "Saved", rows: [], existing: true }, { name: "New", rows: [3], existing: false }] }]);
  assert.equal(out["1"].name, "New");
});
