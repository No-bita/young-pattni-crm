import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {createServer} from '../web/node_modules/vite/dist/node/index.js';
test('single Contacts filter supports status or paged imports and one contact search',async()=>{
 const server=await createServer({root:new URL('../web',import.meta.url).pathname,server:{host:'127.0.0.1',port:0}});await server.listen();const browser=await chromium.launch({executablePath:process.env.CHROME_EXECUTABLE || '/usr/bin/google-chrome',args:['--no-sandbox']});
 try{for(const [label,width,height] of [['mobile',420,900],['desktop',1440,1000]]){
  const page=await browser.newPage({viewport:{width,height}});const queries=[];const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('**/api/**',r=>{const url=new URL(r.request().url());let json;
   if(url.pathname==='/api/auth/me')json={account:{name:'Local test'}};
   else if(url.pathname==='/api/contacts/imports'){const offset=Number(url.searchParams.get('offset'));json={imports:Array.from({length:offset===0?25:2},(_,i)=>({id:'batch'+(offset+i),name:(offset+i===25?'Older outreach':`Youth outreach ${offset+i+1}`),createdAt:'2026-11-24T06:00:00Z',status:'completed',created:10,updated:1,unchanged:2})),total:27};}
   else {queries.push(url.searchParams);json={contacts:[{id:'a',name:'Riya Shah',phone:'+919876543210',createdAt:'2026-11-24T06:00:00Z'}],total:101};}
   return r.fulfill({json});});
  await page.goto(server.resolvedUrls.local[0]+'#/contacts');await page.getByText('Riya Shah',{exact:true}).waitFor();
  assert.equal(await page.getByLabel('Search name or number',{exact:true}).count(),1);
  await page.getByRole('button',{name:'Next',exact:true}).click();await page.waitForFunction(()=>document.body.textContent.includes('Page 2 of 3'));
  await page.getByRole('button',{name:'Contacts filter: All contacts',exact:true}).click();await page.getByRole('button',{name:'Load more imports',exact:true}).click();
  await page.getByRole('button',{name:/^Older outreach/}).click();await page.getByRole('button',{name:'Contacts filter: Older outreach',exact:true}).waitFor();
  await page.waitForTimeout(100);assert.equal(queries.at(-1).get('importId'),'batch25');assert.equal(queries.at(-1).get('filter'),'all');assert.equal(queries.at(-1).get('offset'),'0');
  await page.getByLabel('Search name or number',{exact:true}).fill('Riya');await page.waitForTimeout(100);assert.equal(queries.at(-1).get('q'),'Riya');assert.equal(queries.at(-1).get('importId'),'batch25');
  await page.getByRole('button',{name:'Contacts filter: Older outreach',exact:true}).click();await page.getByRole('button',{name:'Opted out',exact:true}).click();await page.waitForTimeout(100);assert.equal(queries.at(-1).get('importId'),'');assert.equal(queries.at(-1).get('filter'),'suppressed');
  await page.getByRole('button',{name:'Contacts filter: Opted out',exact:true}).click();await page.keyboard.press('Escape');assert.equal(await page.getByRole('button',{name:'Contacts filter: Opted out',exact:true}).getAttribute('aria-expanded'),'false');
  await page.getByLabel('Search name or number',{exact:true}).fill('');await page.getByRole('button',{name:'Contacts filter: Opted out',exact:true}).click();
  await page.screenshot({path:`/downloads/pjm-single-filter-${label}.png`,fullPage:true});assert.deepEqual(errors,[]);await page.close();
 }}finally{await browser.close();await server.close();}
});
