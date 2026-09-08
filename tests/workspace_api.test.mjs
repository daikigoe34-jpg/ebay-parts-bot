import test from 'node:test';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {database} from './workspace_d1_fixture.mjs';
const api = await import('../server/workspace.mjs').catch(()=>({}));
const origin='https://part-scout.test';
function request(path='main', {method='GET',user='alice',data,headers={},raw}={}) {
  return new Request(`${origin}/api/workspace/${path}`, {method,
    headers:{...(user?{'oai-authenticated-user-id':user}:{}),...(method==='PUT'?{'Content-Type':'application/json',Origin:origin,'X-Part-Scout-User-Key':createHash('sha256').update('part-scout-workspace-v1:'+user).digest('hex')}:{}),...headers},
    ...(method==='PUT'?{body:raw??JSON.stringify(data)}:{})});
}
async function call(req,db) {
  assert.equal(typeof api.handleWorkspace,'function','workspace endpoint must be implemented');
  return api.handleWorkspace(req,{DB:db});
}
const main={settings:{feesConfirmed:false},costs:{},workspace:{tab:'today'}};

test('identity required, per-user isolation and private no-store on all responses',async t=>{
  const db=database();t.after(()=>db.close());
  const noUser=await call(request('main',{user:null}),db);
  assert.equal(noUser.status,401);assert.equal((await noUser.json()).error,'sign_in_required');
  const empty=await call(request(),db); const initial=await empty.json();
  assert.equal(empty.headers.get('cache-control'),'private, no-store');
  assert.equal(initial.schemaVersion,1);assert.equal(initial.revision,0);assert.equal(initial.data,null);
  assert.match(initial.userKey,/^[a-f0-9]{64}$/);assert.notEqual(initial.userKey,'alice');
  const saved=await call(request('main',{method:'PUT',data:{baseRevision:0,data:main}}),db);
  assert.equal(saved.status,200);assert.equal((await saved.json()).revision,1);
  assert.deepEqual((await (await call(request(),db)).json()).data,main);
  const other=await (await call(request('main',{user:'bob'}),db)).json();
  assert.equal(other.data,null);assert.notEqual(initial.userKey,other.userKey);
  assert.equal((await (await call(request('shipping'),db)).json()).data,null);
});

test('same-base concurrent writes and obsolete revisions cannot overwrite newer edits',async t=>{
  const db=database();t.after(()=>db.close());
  const put=value=>call(request('queue',{method:'PUT',data:{baseRevision:0,data:{items:[value]}}}),db);
  const both=await Promise.all([put('first'),put('second')]);
  assert.deepEqual(both.map(r=>r.status).sort(),[200,409]);
  const winner=await both.find(r=>r.status===200).json();
  const conflict=await both.find(r=>r.status===409).json();
  assert.equal(conflict.error,'revision_conflict');assert.deepEqual(conflict.data,winner.data);
  const next=await call(request('queue',{method:'PUT',data:{baseRevision:1,data:{items:['next']}}}),db);
  assert.equal(next.status,200);assert.equal((await next.json()).revision,2);
  const stale=await call(request('queue',{method:'PUT',data:{baseRevision:1,data:{items:['stale']}}}),db);
  assert.equal(stale.status,409);assert.deepEqual((await stale.json()).data,{items:['next']});
  const missing=await call(request('shipping',{method:'PUT',data:{baseRevision:9,data:{weightKg:'1'}}}),db);
  assert.equal(missing.status,409);assert.equal((await missing.json()).revision,0);
});

test('mutations require same-origin JSON and validated bounded payload',async t=>{
  const db=database();t.after(()=>db.close());
  const cases=[
    [{headers:{Origin:'https://evil.test'},data:{baseRevision:0,data:main}},403],
    [{headers:{Origin:''},data:{baseRevision:0,data:main}},403],
    [{headers:{'Content-Type':'text/plain'},data:{baseRevision:0,data:main}},415],
    [{raw:'not-json'},400],
    [{data:{baseRevision:-1,data:main}},400],
    [{data:{baseRevision:0,data:[]}},400],
    [{data:{baseRevision:0,data:null}},400],
    [{data:{baseRevision:0,data:main,userKey:'bob'}},400],
    [{raw:'{"baseRevision":0,"data":{"nested":{"__proto__":{}}}}'},400],
    [{data:{baseRevision:0,data:{value:'あ'.repeat(700000)}}},413],
  ];
  for(const [options,expected] of cases){
    const response=await call(request('main',{method:'PUT',...options}),db);
    assert.equal(response.status,expected);assert.equal(response.headers.get('cache-control'),'private, no-store');
    assert.equal(response.headers.has('access-control-allow-origin'),false);
  }
  assert.equal((await (await call(request(),db)).json()).revision,0);
});

test('bad methods/namespaces and unavailable database fail closed',async t=>{
  const db=database();t.after(()=>db.close());
  const method=await call(request('main',{method:'DELETE'}),db);
  assert.equal(method.status,405);assert.equal(method.headers.get('allow'),'GET, PUT');
  for(const path of ['unknown','main/','main/extra','constructor']) assert.equal((await call(request(path),db)).status,404);
  const noDB=await call(request(),null);
  assert.equal(noDB.status,503);assert.equal((await noDB.json()).error,'storage_unavailable');
  const brokenDB={prepare(){throw new Error('private failure should not leak');}};
  const broken=await call(request(),brokenDB);
  assert.equal(broken.status,503);assert.equal((await broken.text()).includes('private failure'),false);
});


test('a login change between GET and PUT cannot save the previous account data',async t=>{
  const db=database();t.after(()=>db.close());
  const initial=await (await call(request('main',{user:'alice'}),db)).json();
  const changed=await call(request('main',{user:'bob',method:'PUT',headers:{'X-Part-Scout-User-Key':initial.userKey},data:{baseRevision:0,data:main}}),db);
  assert.equal(changed.status,403);assert.equal((await changed.json()).error,'account_changed');
  for(const user of ['alice','bob']) assert.equal((await (await call(request('main',{user}),db)).json()).revision,0);
  for(const expected of ['', 'malformed']) {
    const response=await call(request('main',{method:'PUT',headers:{'X-Part-Scout-User-Key':expected},data:{baseRevision:0,data:main}}),db);
    assert.equal(response.status,400);
  }
});
