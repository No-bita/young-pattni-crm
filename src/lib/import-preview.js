import { prepareContactImport } from './contact-import.js';
import { all } from './db.js';

export async function previewContactImport(db, accountId, rows) {
  const prepared = prepareContactImport(rows);
  const groups = new Map(prepared.list.map(row => [row.phone, { ...row, candidates: [], sourceRows: [] }]));
  for (const [index,row] of rows.entries()) {
    const one = prepareContactImport([row]).list[0];
    if (!one) continue;
    const group = groups.get(one.phone);
    const name = one.name;
    const sourceRow = Number.isSafeInteger(row.sourceRow) && row.sourceRow >= 2 ? row.sourceRow : index + 2;
    group.sourceRows.push(sourceRow);
    if (name && !group.candidates.some(c => c.name === name)) group.candidates.push({name, rows: [], existing:false});
    if (name) group.candidates.find(c => c.name === name).rows.push(sourceRow);
  }
  const existing = new Map();
  const phones = [...groups.keys()];
  for (let i=0;i<phones.length;i+=80) {
    const part=phones.slice(i,i+80);
    const found=await all(db, `SELECT phone_e164,name FROM contacts WHERE account_id=? AND phone_e164 IN (${part.map(()=>'?').join(',')})`, accountId,...part);
    for (const contact of found) existing.set(contact.phone_e164,contact.name);
  }
  const list=[...groups.values()];
  for(const group of list){
    const name=existing.get(group.phone);
    if(name){
      const candidate=group.candidates.find(c=>c.name===name);
      if(candidate)candidate.existing=true;
      else group.candidates.push({name,rows:[],existing:true});
    }
  }
  return {...prepared,list,conflicts:list.filter(g=>g.candidates.length>1),duplicatesInFile:rows.length-prepared.invalid.length-list.length};
}
export function resolveImportNames(preview, choices) {
  const unresolved=[];
  for(const group of preview.conflicts){
    const choice=choices?.[group.phone];
    const candidates=group.candidates.map(c=>c.name).sort();
    if(!choice || !candidates.includes(choice.name) || JSON.stringify(candidates)!==JSON.stringify(choice.candidates?.slice().sort())){
      unresolved.push(group.phone);continue;
    }
    group.name=choice.name;
    const candidate=group.candidates.find(c=>c.name===choice.name);
    group.sourceRow=candidate.rows[0] || group.sourceRows[0];
  }
  return unresolved;
}
