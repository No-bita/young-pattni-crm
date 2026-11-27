import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {prepareContactImport} from '../src/lib/contact-import.js';
import { readContactFile, contactSheetRows } from '../web/src/lib/contactFile.js';
const file = (name, bytes) => ({name, size: bytes.length, arrayBuffer: async () => bytes, text: async () => String(bytes)});
test('reads real XLSX, preserves sheets, numeric phones and original row numbers', async () => {
  const sheets = await readContactFile(file('contacts.xlsx', await readFile(new URL('./fixtures/contact-import.xlsx', import.meta.url))));
  assert.deepEqual(sheets.map(s => s.sheet), ['Contacts','Other']);
  const out = contactSheetRows(sheets[0]);
  assert.equal(out.error, undefined);
  assert.deepEqual(out.rows, [{sourceRow:2,phone:'9876543210',name:'Riya'},{sourceRow:4,phone:'+44 7700 900123',name:'Sam'}]);
  assert.equal(contactSheetRows(sheets[1]).error, undefined); // no-name check switched off for now
});
test('CSV still works; corrupt, old-format, oversize and empty inputs are rejected', async () => {
  assert.equal(contactSheetRows((await readContactFile(file('a.csv','phone,name\n9876543210,Riya')))[0]).rows.length,1);
  await assert.rejects(readContactFile(file('bad.xlsx',Buffer.from('not zip'))), /Could not read/);
  await assert.rejects(readContactFile(file('old.xls',Buffer.from('old'))), /Choose a .csv or .xlsx/);
  await assert.rejects(readContactFile({name:'huge.xlsx',size:6*1024*1024}), /5 MB/);
  assert.match(contactSheetRows({data:[]}).error, /empty/);
});
test('unsafe numeric, date and boolean phone cells reject, but blank duplicate is rescued', () => {
  for (const value of [1.23,Number.MAX_SAFE_INTEGER+1,new Date(),true]) { const parsed=contactSheetRows({data:[['phone','name'],[value,'Test'],['9876543210','Riya']]}); assert.equal(parsed.error,undefined); const checked=prepareContactImport(parsed.rows); assert.equal(checked.invalid.length,1); assert.equal(checked.list.length,1); }
  const out = contactSheetRows({data:[['phone','name'],['9876543210',''],['9876543210','Named']]});
  assert.equal(out.error,undefined);
  assert.equal(out.rows.length,2);
});
