import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeEnv,createAccount,login} from './helpers.js';
async function setup(){const env=makeEnv();await createAccount(env,{login:'preview@test.in'});await createAccount(env,{login:'other@test.in'});return {env,a:await login(env,'preview@test.in'),b:await login(env,'other@test.in')};}
const rows=[{phone:'9876543210',name:'Riya',sourceRow:2},{phone:'+91 98765 43210',name:'Riya S',sourceRow:4},{phone:'9876543210',name:'',sourceRow:5}];
test('preview dedupes, includes file rows, changes nothing, requires valid explicit name',async()=>{
 const {env,a}=await setup();const p=await a.post('/api/contacts/import/preview',{rows});assert.equal(p.status,200);assert.equal(p.data.contacts.length,1);assert.equal(p.data.duplicatesInFile,2);assert.equal(p.data.conflicts.length,1);assert.deepEqual(p.data.conflicts[0].sourceRows,[2,4,5]);assert.equal(env.DB.q('SELECT * FROM contacts').length,0);
 const body={importName:'Chosen',rows};assert.equal((await a.post('/api/contacts/import',body)).status,409);assert.equal(env.DB.q('SELECT * FROM contact_imports').length,0);
 const nameChoices={'919876543210':{name:'Riya',candidates:['Riya','Riya S']}};const r=await a.post('/api/contacts/import',{...body,nameChoices});assert.equal(r.status,200);assert.equal(r.data.created,1);assert.equal(r.data.nameChoices[0].name,'Riya');assert.deepEqual(r.data.nameChoices[0].sourceRows,[2,4,5]);assert.equal(env.DB.q('SELECT name FROM contacts')[0].name,'Riya');
});
test('existing names are account-scoped choices; stale or invented choices reject with no import',async()=>{
 const {env,a,b}=await setup();await a.post('/api/contacts',{phone:'9876543210',name:'Existing'});
 const p=await a.post('/api/contacts/import/preview',{rows});assert.equal(p.data.conflicts[0].candidates.at(-1).name,'Existing');assert.equal((await b.post('/api/contacts/import/preview',{rows})).data.conflicts[0].candidates.length,2);
 for(const choice of [{name:'Invented',candidates:['Existing','Riya','Riya S']},{name:'Riya',candidates:['Riya','Riya S']}])assert.equal((await a.post('/api/contacts/import',{importName:'Bad',rows,nameChoices:{'919876543210':choice}})).status,409);
 assert.equal(env.DB.q('SELECT * FROM contact_imports').length,0);assert.equal(env.DB.q('SELECT name FROM contacts')[0].name,'Existing');
});
test('blank-name grouping still blocks and invalid row errors use source rows',async()=>{
 const {a}=await setup();assert.equal((await a.post('/api/contacts/import/preview',{rows:[{phone:'9876543210',name:'',sourceRow:8}]})).status,400);
 const p=await a.post('/api/contacts/import/preview',{rows:[{phone:'bad',name:'Invalid',sourceRow:9},{phone:'9876543210',name:'Riya'}]});assert.equal(p.data.invalid[0].row,9);assert.equal(p.data.conflicts.length,0);
});
test('skip and list: malformed India numbers keep original rows; valid formats import',async()=>{
 const {env,a}=await setup();const rows=[{phone:'987654321',name:'Short',sourceRow:3},{phone:'9876543210000',name:'Long',sourceRow:5},{phone:'9876543210',name:'Riya',sourceRow:7},{phone:'09876543211',name:'Mona',sourceRow:8},{phone:'919876543212',name:'Sam',sourceRow:9},{phone:'+91987654321',name:'Bad explicit',sourceRow:11}];
 const p=await a.post('/api/contacts/import/preview',{rows});assert.equal(p.status,200);assert.deepEqual(p.data.invalid.map(r=>r.row),[3,5,11]);assert.match(p.data.invalid[0].error,/10 digits/);assert.equal(p.data.contacts.length,3);
 const r=await a.post('/api/contacts/import',{importName:'Skip list',rows});assert.equal(r.status,200);assert.equal(r.data.created,3);assert.deepEqual(r.data.invalid.map(r=>r.row),[3,5,11]);assert.equal(env.DB.q('SELECT * FROM contacts').length,3);
});
