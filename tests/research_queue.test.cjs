const {test}=require('node:test');const assert=require('node:assert/strict');
let Queue;try{Queue=require('../web/research-queue.js');}catch{}
const storage=()=>{const m=new Map();return {getItem:k=>m.get(k)??null,setItem:(k,v)=>m.set(k,String(v))};};
test('exact normalized manufacturer and part deduplicate, four statuses persist',()=>{assert.equal(typeof Queue?.createQueue,'function');const s=storage(),q=Queue.createQueue({storage:s});q.add('TOYOTA','90915-10001');q.add('toyota','9091510001');assert.equal(q.snapshot().items.length,1);const id=q.snapshot().items[0].id;for(const status of Object.keys(Queue.statuses))q.update(id,{status,note:'確認メモ'});assert.equal(Queue.createQueue({storage:s}).snapshot().items[0].status,'complete');assert.throws(()=>q.add('TOYOTA','?'));});
test('switching tasks captures old draft and resumes saved draft without lookup',()=>{const q=Queue.createQueue({storage:storage()});const a=q.add('TOYOTA','90915-10001'),b=q.add('HONDA','15400-PLM-A02');let current={weightKg:'1'};const adapter={capture:()=>current,apply:d=>{current=d;},fresh:item=>({weightKg:''})};q.resume(a.id,adapter);current={weightKg:'12.'};q.resume(b.id,adapter);current={weightKg:'3'};q.resume(a.id,adapter);assert.equal(current.weightKg,'12.');assert.equal(q.snapshot().items.find(x=>x.id===b.id).draft.weightKg,'3');});
test('50 task limit and quota failure leave old draft and active task intact',()=>{const s=storage(),q=Queue.createQueue({storage:s});for(let i=0;i<50;i++)q.add('TOYOTA',String(9091510000+i));assert.throws(()=>q.add('TOYOTA','9091520001'));const old=q.snapshot();s.setItem=()=>{throw Error('quota');};let applied=false;assert.throws(()=>q.resume(old.items[0].id,{capture:()=>({}),fresh:()=>({}),apply:()=>{applied=true;}}));assert.equal(applied,false);assert.deepEqual(q.snapshot(),old);});
test('handoff uses live link, pending status and remaining verification',()=>{const q=Queue.createQueue({storage:storage()});const item=q.add('TOYOTA','90915-10001');q.update(item.id,{note:'梱包を実測する',status:'confirm'});const handoff=q.handoff('https://live.example/shipping-calculator.html?token=secret#x');assert.match(handoff,/https:\/\/live.example\/shipping-calculator.html/);assert.doesNotMatch(handoff,/secret/);assert.match(handoff,/梱包を実測する/);assert.match(handoff,/要確認/);});
test('two open tabs preserve both queue edits and block a stale overwrite',()=>{const s=storage(),a=Queue.createQueue({storage:s});const item=a.add('TOYOTA','90915-10001');const b=Queue.createQueue({storage:s});a.update(item.id,{note:'tab A'});assert.throws(()=>b.update(item.id,{note:'tab B'}),/別のタブ/);assert.equal(Queue.createQueue({storage:s}).snapshot().items[0].note,'tab A');assert.equal(b.backupExtras().tabConflicts[0].local.items[0].note,'tab B');});
test('remote active work position cannot reassign the shipping editor owner',()=>{
  const q=Queue.createQueue({storage:storage()});const a=q.add('TOYOTA','90915-10001'),b=q.add('TOYOTA','90915-10002');
  let current={weightKg:'1'};const adapter={capture:()=>current,apply:d=>{current=d;},fresh:()=>({weightKg:''})};
  q.resume(b.id,adapter);current={weightKg:'9'};q.capture(current);q.resume(a.id,adapter);current={weightKg:'1'};q.capture(current);
  const incoming=q.snapshot();incoming.activeId=b.id;q.applyRemote(incoming);
  current={weightKg:'2'};q.capture(current);
  assert.equal(q.snapshot().items.find(x=>x.id===b.id).draft.weightKg,'9');
  assert.equal(q.snapshot().items.find(x=>x.id===a.id).draft.weightKg,'2');
  q.resume(b.id,adapter);assert.equal(current.weightKg,'9');
});
test('receiving a changed owner draft or importing the queue detaches the editor',()=>{
  const q=Queue.createQueue({storage:storage()});const a=q.add('TOYOTA','90915-10001');let current={weightKg:'1'};
  const adapter={capture:()=>current,apply:d=>current=d,fresh:()=>({weightKg:'1'})};q.resume(a.id,adapter);q.capture(current);
  const incoming=q.snapshot();incoming.items[0].draft={weightKg:'7'};q.applyRemote(incoming);q.capture({weightKg:'2'});
  assert.equal(q.snapshot().items[0].draft.weightKg,'7');q.resume(a.id,adapter);assert.equal(current.weightKg,'7');
  q.restore({...q.snapshot(),items:[{...q.snapshot().items[0],draft:{weightKg:'8'}}]});q.capture({weightKg:'3'});
  assert.equal(q.snapshot().items[0].draft.weightKg,'8');
});
