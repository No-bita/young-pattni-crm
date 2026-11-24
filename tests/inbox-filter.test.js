import { test } from "node:test";
import assert from "node:assert/strict";
import { makeEnv, createAccount, login } from "./helpers.js";
import { conversationMatches } from "../src/lib/inbox-filters.js";
test("status means latest message, suppression overlaps", () => {
  const incoming={last_direction:"inbound",last_status:"received",suppressed:1};
  assert.equal(conversationMatches(incoming,"replied"),true);
  assert.equal(conversationMatches(incoming,"opted_out"),true);
  assert.equal(conversationMatches(incoming,"read"),false);
  assert.equal(conversationMatches({last_direction:"outbound",last_status:"read"},"read"),true);
});
test("Inbox filters all matches before pagination, counts overlap, accounts isolated",async()=>{
 const env=makeEnv(); const id=await createAccount(env,{login:"filter@test.in"});const other=await createAccount(env,{login:"other@test.in"});const client=await login(env,"filter@test.in");
 env.DB.raw.exec(`INSERT INTO senders(id,account_id,token_ref,phone_number_id,waba_id) VALUES('s','${id}','s','1','1')`);
 for(let i=0;i<205;i++){
  env.DB.raw.prepare("INSERT INTO contacts(id,account_id,phone_e164,name,last_message_at,suppressed) VALUES(?,?,?,?,?,?)").run('c'+i,id,'91900000'+String(i).padStart(4,'0'),i===204?'Find me':'Person','2026-11-24T01:00:00Z',i===204?1:0);
  env.DB.raw.prepare("INSERT INTO messages(id,account_id,contact_id,sender_id,direction,kind,body,status) VALUES(?,?,?,?,?,?,?,?)").run('m'+i,id,'c'+i,'s',i===204?'inbound':'outbound','text','Hello',i===204?'received':'read');
 }
 env.DB.raw.prepare("INSERT INTO contacts(id,account_id,phone_e164,name,last_message_at) VALUES('foreign',?,'919111111111','Find me','2026-11-24T01:00:00Z')").run(other);
 const r=await client.get('/api/inbox?status=replied&q=Find');assert.equal(r.status,200);assert.equal(r.data.total,1);assert.equal(r.data.counts.opted_out,1);assert.equal(r.data.conversations[0].contactId,'c204');
 assert.equal((await client.get('/api/inbox?status=read')).data.total,204);
 assert.equal((await client.get('/api/inbox?status=invalid')).status,400);
});
