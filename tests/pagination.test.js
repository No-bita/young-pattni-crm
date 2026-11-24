import { test } from "node:test";
import assert from "node:assert/strict";
import { pageInfo } from "../web/src/lib/pagination.js";
test("pagination covers empty, full, final and stale pages", () => {
 assert.deepEqual(pageInfo(0,0),{page:0,pages:1,start:0,end:0,total:0});
 assert.deepEqual(pageInfo(101,1),{page:1,pages:3,start:51,end:100,total:101});
 assert.deepEqual(pageInfo(101,2),{page:2,pages:3,start:101,end:101,total:101});
 assert.equal(pageInfo(1,5).page,0);assert.equal(pageInfo(50,0).pages,1);
});
