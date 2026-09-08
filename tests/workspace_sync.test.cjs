const {test}=require('node:test');
const assert=require('node:assert/strict');
let createSync; try { ({createSync}=require('../web/workspace-sync.js')); } catch {}
function memory(){const rows=new Map();return {getItem:k=>rows.get(k)??null,setItem:(k,v)=>rows.set(k,String(v)),rows};}
function server(){let doc={schemaVersion:1,userKey:'alice',revision:0,data:null,updatedAt:null};return {get doc(){return doc;},set doc(v){doc=v;},async fetch(url,options){if(options.method==='PUT'){const body=JSON.parse(options.body);if(body.baseRevision!==doc.revision)return {status:409,json:async()=>({...doc,error:'revision_conflict'})};doc={...doc,revision:doc.revision+1,data:body.data,updatedAt:new Date().toISOString()};}return {status:200,json:async()=>structuredClone(doc)};}};}
function client(s,storage=memory(),initial=null){let local=initial;const options={namespace:'main',storage,getLocal:()=>local,hasLocal:()=>local!==null,validate:x=>{assert.equal(typeof x,'object');return x;},applyRemote:x=>{local=structuredClone(x);},fetch:(...a)=>s.fetch(...a),debounceMs:100000}; const sync=createSync(options);return {sync,storage,getLocal:()=>local,edit(x){local=x;sync.changed();},flush:()=>sync.flush(),get status(){return sync.status;},reopen(){sync.dispose();return client(s,storage,local);}};}
test('two independent devices round trip without uploading initial defaults',async()=>{assert.equal(typeof createSync,'function');const s=server(),a=client(s),b=client(s);a.edit({part:'123'});await a.flush();await b.flush();assert.deepEqual(b.getLocal(),a.getLocal());a.sync.dispose();b.sync.dispose();});
test('divergent edits and both conflict copies survive reconstruction',async()=>{const s=server(),a=client(s);a.edit({part:'base'});await a.flush();let b=client(s);await b.flush();a.edit({part:'A'});b.edit({part:'B'});await a.flush();await b.flush();assert.equal(b.status,'conflict');b=b.reopen();assert.equal(b.status,'conflict');assert.deepEqual(b.sync.backup().local,{part:'B'});assert.deepEqual(b.sync.backup().remote,{part:'A'});a.sync.dispose();b.sync.dispose();});
test('late GET cannot overwrite an edit made while requesting',async()=>{const s=server();s.doc={...s.doc,revision:1,data:{part:'cloud'},updatedAt:new Date().toISOString()};let release;const original=s.fetch;s.fetch=async(...a)=>{const r=await original(...a);await new Promise(r=>release=r);return r;};const b=client(s);const request=b.flush();await new Promise(setImmediate);b.edit({part:'typed'});release();await request;assert.deepEqual(b.getLocal(),{part:'typed'});assert.equal(b.status,'conflict');b.sync.dispose();});
test('lost PUT response is acknowledged on next GET without endless retry',async()=>{const s=server();const original=s.fetch;let lost=true;s.fetch=async(...args)=>{const result=await original(...args);if(args[1].method==='PUT'&&lost){lost=false;throw Error('offline');}return result;};const a=client(s);a.edit({part:'x'});await a.flush();await a.flush();assert.equal(a.status,'synced');assert.equal(s.doc.revision,1);a.sync.dispose();});
test('late PUT acknowledgement preserves a newer pending edit',async()=>{const s=server();let release;const original=s.fetch;s.fetch=async(...args)=>{const result=await original(...args);if(args[1].method==='PUT')await new Promise(r=>release=r);return result;};const a=client(s);a.edit({part:'first'});const request=a.flush();await new Promise(setImmediate);a.edit({part:'second'});release();await request;assert.equal(a.getLocal().part,'second');s.fetch=original;await a.flush();assert.equal(s.doc.data.part,'second');a.sync.dispose();});
test('account change never uploads prior account pending data',async()=>{const s=server(),a=client(s);a.edit({part:'alice'});await a.flush();a.edit({part:'private'});s.doc={...s.doc,userKey:'bob',data:null,revision:0,updatedAt:null};await a.flush();assert.equal(a.status,'account-changed');assert.equal(s.doc.data,null);a.sync.dispose();});
test('quota failure blocks conflict resolution and retains both values',async()=>{const s=server(),a=client(s),b=client(s);a.edit({part:'base'});await a.flush();await b.flush();a.edit({part:'cloud'});b.edit({part:'local'});await a.flush();await b.flush();b.storage.setItem=()=>{throw Error('quota');};assert.equal(await b.sync.resolve('remote'),false);assert.equal(b.getLocal().part,'local');assert.equal(b.sync.backup().remote.part,'cloud');a.sync.dispose();b.sync.dispose();});
test('invalid remote envelope and prototype keys cannot apply',async()=>{const s=server(),a=client(s);s.doc={...s.doc,revision:-1,data:{part:'bad'}};await a.flush();assert.equal(a.status,'unavailable');assert.equal(a.getLocal(),null);s.doc={...s.doc,revision:1,data:JSON.parse('{"constructor":{}}'),updatedAt:new Date().toISOString()};await a.flush();assert.equal(a.getLocal(),null);a.sync.dispose();});
test('pending edits survive reload while offline and fetch is private',async()=>{const s=server();s.fetch=async()=>{throw Error('offline');};let a=client(s);a.edit({part:'saved'});await a.flush();a=a.reopen();assert.equal(a.sync.backup().local.part,'saved');const live=server();s.fetch=async(url,options)=>{assert.equal(url,'/api/workspace/main');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');return live.fetch(url,options);};await a.flush();assert.equal(live.doc.data.part,'saved');a.sync.dispose();});
test('automatic sync sends a newer edit after a slow PUT outlives its debounce',async()=>{const s=server();let release;const original=s.fetch;s.fetch=async(...args)=>{const result=await original(...args);if(args[1].method==='PUT'&&result&&s.doc.revision===1)await new Promise(r=>release=r);return result;};let local=null;const sync=createSync({namespace:'shipping',storage:memory(),getLocal:()=>local,hasLocal:()=>false,validate:x=>x,applyRemote:x=>local=x,fetch:(...a)=>s.fetch(...a),debounceMs:5});local={part:'one'};sync.changed();await new Promise(r=>setTimeout(r,15));local={part:'two'};sync.changed();await new Promise(r=>setTimeout(r,15));release();await new Promise(r=>setTimeout(r,30));assert.equal(s.doc.data.part,'two');sync.dispose();});
test('unchosen conflict version survives later ordinary cloud receives',async()=>{const s=server(),a=client(s),b=client(s);a.edit({part:'base'});await a.flush();await b.flush();a.edit({part:'cloud'});b.edit({part:'local'});await a.flush();await b.flush();await b.sync.resolve('remote');a.edit({part:'cloud-new'});await a.flush();await b.flush();assert.equal(b.sync.backup().conflictRecovery.local.part,'local');a.sync.dispose();b.sync.dispose();});
test('PUT binds the exact GET account and keeps its body limited to revision and data',async()=>{
  const s=server(),original=s.fetch;let binding,body;
  s.fetch=async(url,options)=>{
    if(options.method==='PUT'){binding=options.headers['X-Part-Scout-User-Key'];body=JSON.parse(options.body);}
    return original(url,options);
  };
  const a=client(s);a.edit({part:'bound'});await a.flush();
  assert.equal(binding,'alice');assert.deepEqual(Object.keys(body).sort(),['baseRevision','data']);
  assert.equal(a.status,'synced');a.sync.dispose();
});
test('GET-to-PUT account switch reports account-changed and preserves pending and recovery on reload',async()=>{
  const s=server(),storage=memory(),original=s.fetch;
  const recovery={local:{part:'retained-local'},remote:{part:'retained-cloud'}};
  storage.setItem('part-scout-sync-v1:main:conflict-recovery',JSON.stringify([recovery]));
  let suppliedBinding;
  s.fetch=async(url,options)=>{
    if(options.method==='PUT'){
      suppliedBinding=options.headers['X-Part-Scout-User-Key'];
      s.doc={...s.doc,userKey:'bob'};
      return {status:403,json:async()=>({error:'account_changed'})};
    }
    return original(url,options);
  };
  let a=client(s,storage);a.edit({part:'alice-private'});await a.flush();
  assert.equal(a.status,'account-changed');assert.equal(suppliedBinding,'alice');assert.equal(s.doc.data,null);
  assert.deepEqual(JSON.parse(storage.getItem('part-scout-sync-v1:main')).pending,{part:'alice-private'});
  assert.deepEqual(a.sync.backup().conflictRecovery,recovery);
  a=a.reopen();await a.flush();assert.equal(a.status,'account-changed');
  assert.deepEqual(a.sync.backup().local,{part:'alice-private'});assert.deepEqual(a.sync.backup().conflictRecovery,recovery);
  a.sync.dispose();
});
test('a stale tab cannot erase another tab pending journal while receiving cloud data',async()=>{
  const {createStore}=require('../web/persistence.js');const shared=memory(),s=server();
  s.doc={...s.doc,revision:1,data:{weight:'1'},updatedAt:new Date().toISOString()};
  shared.setItem('draft',JSON.stringify({weight:'1'}));
  function tab(){const store=createStore(shared,{guardedKeys:['draft']});let local=store.read('draft',null);const sync=createSync({namespace:'shipping',storage:shared,getLocal:()=>local,hasLocal:()=>true,validate:x=>x,applyRemote:x=>{if(!store.write('draft',x).ok)return false;local=x;},fetch:(...a)=>s.fetch(...a),debounceMs:100000});return {sync,edit(x){local=x;const result=store.write('draft',x);if(result.ok)sync.changed();return result;}};}
  const a=tab();await a.sync.flush();const b=tab();await b.sync.flush();
  a.edit({weight:'UNSENT_A'});s.doc={...s.doc,revision:2,data:{weight:'REMOTE_C'}};await b.sync.flush();
  assert.equal(JSON.parse(shared.getItem('draft')).weight,'UNSENT_A');
  assert.equal(JSON.parse(shared.getItem('part-scout-sync-v1:shipping')).pending.weight,'UNSENT_A');
  assert.equal(b.sync.status,'tab-conflict');
  a.sync.dispose();b.edit({weight:'NEW_B'});b.sync.dispose();
  const reopened=tab();reopened.edit({weight:'LATER'});
  assert.ok(JSON.stringify(reopened.sync.backup().tabConflicts).includes('UNSENT_A'));
  reopened.sync.dispose();
});
