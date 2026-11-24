import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, createAccount, login } from "./helpers.js";
const rows=[{phone:"9876543210",name:"Riya",sourceRow:4},{phone:"9876543211",name:"Mona",sourceRow:6}];
async function setup(){const env=makeEnv();await createAccount(env,{login:"batch@test.in"});await createAccount(env,{login:"other@test.in"});return {env,a:await login(env,"batch@test.in"),b:await login(env,"other@test.in")};}
test("name required before writes; legacy contacts have no invented batch",async()=>{
 const {env,a}=await setup();assert.equal((await a.post('/api/contacts/import',{rows})).status,400);assert.equal(env.DB.q('SELECT * FROM contacts').length,0);assert.equal(env.DB.q('SELECT * FROM contact_imports').length,0);
 await a.post('/api/contacts',{phone:'9876543219',name:'Legacy'});assert.equal((await a.get('/api/contacts')).data.total,1);assert.equal((await a.get('/api/contacts/imports')).data.total,0);
});
test("membership supports many batches, outcomes, search/filter/counts/ids and isolation",async()=>{
 const {env,a,b}=await setup();const first=await a.post('/api/contacts/import',{importName:'Youth November',filename:'one.csv',rows});assert.equal(first.status,200,JSON.stringify(first));assert.equal(first.data.created,2);
 const second=await a.post('/api/contacts/import',{importName:'Camp December',rows:[{...rows[0],name:'Riya S'}]});assert.equal(second.status,200);assert.equal(second.data.updated,1);
 const third=await a.post('/api/contacts/import',{importName:'Same again',rows});assert.equal(third.data.updated,1);assert.equal(third.data.unchanged,1);
 assert.equal((await a.get('/api/contacts?batchName=Youth')).data.total,2);assert.equal((await a.get('/api/contacts?importId='+second.data.id)).data.total,1);assert.equal((await a.get('/api/contacts?importId='+first.data.id+'&q=Mona')).data.total,1);
 assert.equal((await a.get('/api/contacts/imports?q=December')).data.total,1);assert.equal((await b.get('/api/contacts/imports')).data.total,0);assert.equal((await b.get('/api/contacts/imports/'+first.data.id)).status,404);assert.equal((await b.get('/api/contacts?importId='+first.data.id)).data.total,0);
 const cid=env.DB.q("SELECT id FROM contacts WHERE name='Mona'")[0].id;env.DB.raw.prepare('UPDATE contacts SET suppressed=1 WHERE id=?').run(cid);
 assert.equal((await a.get('/api/contacts/ids?importId='+first.data.id)).data.ids.length,1);assert.equal((await a.get('/api/contacts?importId='+first.data.id+'&filter=suppressed')).data.total,1);
 assert.deepEqual(env.DB.q('SELECT source_row FROM contact_import_members WHERE import_id=? ORDER BY source_row',first.data.id).map(r=>r.source_row),[4,6]);
});
test("idempotent completed replay, changed payload conflict",async()=>{
 const {env,a}=await setup();const body={importName:'One',filename:'one.csv',requestId:'same-request',rows};const r=await a.post('/api/contacts/import',body);const again=await a.post('/api/contacts/import',body);assert.equal(again.status,200);assert.equal(again.data.id,r.data.id);assert.equal(again.data.replayed,true);assert.equal(env.DB.q('SELECT * FROM contact_imports').length,1);assert.equal((await a.post('/api/contacts/import',{...body,importName:'Changed'})).status,409);
});
test("later chunk failure preserves committed progress and prevents accidental replay",async()=>{
 const {env,a}=await setup();const original=env.DB.batch.bind(env.DB);let calls=0;env.DB.batch=async stmts=>{if(++calls===2)throw new Error('simulated');return original(stmts)};
 const body={importName:'Partial',requestId:'partial',rows:Array.from({length:60},(_,i)=>({phone:'987654'+String(i).padStart(4,'0'),name:'Name '+i}))};const r=await a.post('/api/contacts/import',body);assert.equal(r.status,500);assert.equal(r.data.import.status,'partial');assert.equal(r.data.import.created,50);assert.equal(env.DB.q('SELECT * FROM contacts').length,50);assert.equal(env.DB.q('SELECT * FROM contact_import_members').length,50);assert.equal((await a.post('/api/contacts/import',body)).status,409);
});
test("batch selection refuses overflow instead of silently truncating",async()=>{
 const {env,a}=await setup();const r=await a.post('/api/contacts/import',{importName:'Two',rows});env.MAX_CAMPAIGN_AUDIENCE='1';const ids=await a.get('/api/contacts/ids?importId='+r.data.id);assert.equal(ids.status,400);assert.equal(ids.data.code,'AUDIENCE_TOO_LARGE');
});
