import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultImportName} from '../web/src/lib/importName.js';
test('import name is date only in Kolkata, including midnight boundary',()=>{
 assert.equal(defaultImportName(new Date('2026-11-24T18:29:59Z')),'24 Nov 2026');
 assert.equal(defaultImportName(new Date('2026-11-24T18:30:00Z')),'25 Nov 2026');
 assert.equal(defaultImportName(new Date('2026-12-31T18:30:00Z')),'1 Jan 2027');
});
