const test=require('node:test'); const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path'); const {JSDOM}=require('jsdom');
const root=path.join(__dirname,'../web');
function boot(saved) {
  const dom=new JSDOM(fs.readFileSync(path.join(root,'research.html'),'utf8'),{url:'https://example.com/ebay-parts-bot/research.html',runScripts:'outside-only'});
  const w=dom.window; w.confirm=()=>true;
  w.URL.createObjectURL=()=> 'blob:test';w.URL.revokeObjectURL=()=>{};w.HTMLAnchorElement.prototype.click=()=>{};
  if(saved) w.localStorage.setItem('part-scout-research-v1',saved);
  for(const file of ['persistence.js','research-core.js','research-ui.js']) w.eval(fs.readFileSync(path.join(root,file),'utf8'));
  return dom;
}
function edit(w,field,value){const el=w.document.querySelector(`[data-field="${field}"]`);assert.ok(el,field);if(el.type==='checkbox')el.checked=value;else el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));}
test('a draft survives reload before being added to the research list',()=>{
  const d=boot(),w=d.window;edit(w,'part','85915-30050');edit(w,'notes','仕入先を再確認');
  const saved=w.localStorage.getItem('part-scout-research-v1');assert.ok(saved);
  const next=boot(saved);assert.equal(next.window.document.querySelector('[data-field="notes"]').value,'仕入先を再確認');
  assert.equal(next.window.document.querySelector('[data-field="part"]').value,'85915-30050');d.window.close();next.window.close();
});
test('corrupt stored data is protected and an explicit valid backup can restore it',async()=>{
  for(const raw of ['{bad', '{"schema":99}']) {
    const d=boot(raw),w=d.window;edit(w,'part','85915-30050');
    assert.equal(w.localStorage.getItem('part-scout-research-v1'),raw);
    assert.match(w.document.querySelector('#save-state').textContent,/読み込めません/);
    const state=w.PartScoutResearch.emptyState();state.draft.part='28300-54110';
    const input=w.document.querySelector('#restore-file');
    Object.defineProperty(input,'files',{value:[{size:1024,text:async()=>JSON.stringify({data:state})}]});
    input.dispatchEvent(new w.Event('change',{bubbles:true}));await new Promise(resolve=>setImmediate(resolve));
    assert.equal(JSON.parse(w.localStorage.getItem('part-scout-research-v1')).draft.part,'28300-54110');
    edit(w,'notes','復元後の編集');assert.equal(JSON.parse(w.localStorage.getItem('part-scout-research-v1')).draft.notes,'復元後の編集');w.close();
  }
});
test('a competing tab is preserved instead of overwritten',()=>{
  const d=boot(),w=d.window;edit(w,'part','85915-30050');
  const remote=JSON.parse(w.localStorage.getItem('part-scout-research-v1'));remote.draft.notes='別タブ';
  w.localStorage.setItem('part-scout-research-v1',JSON.stringify(remote));edit(w,'notes','このタブ');
  assert.equal(JSON.parse(w.localStorage.getItem('part-scout-research-v1')).draft.notes,'別タブ');
  assert.match(w.document.querySelector('#save-state').textContent,/競合/);w.close();
});
test('saving the same normalized manufacturer and part updates one record',()=>{
  const d=boot(),w=d.window;edit(w,'part','85915-30050');w.document.querySelector('#save-record').click();
  edit(w,'part','8591530050');w.document.querySelector('#save-record').click();
  const state=JSON.parse(w.localStorage.getItem('part-scout-research-v1'));assert.equal(state.records.length,1);d.window.close();
});
test('unknown fees show missing data; filling a case displays independent arithmetic',()=>{
  const d=boot(),w=d.window;assert.match(w.document.querySelector('#profit-base').textContent,/—/);
  for(const [k,v] of Object.entries({part:'85915-30050',saleUsd:'100',buyerShippingUsd:'10',packagingJpy:'100','suppliers.0.priceJpy':'1000','suppliers.0.domesticJpy':'100','quotes.0.amountJpy':'2600','settings.fx':'150','settings.buyerTaxRate':'0','settings.payoneerRate':'3','settings.fvfRate':'10','settings.internationalRate':'1','settings.adRate':'2','settings.payoneerFixedJpy':'20'}))edit(w,k,v);
  assert.match(w.document.querySelector('#profit-base').textContent,/9,337/);
  assert.match(w.document.querySelector('#research-warnings').textContent,/未確認/);d.window.close();
});
test('notes from a backup display as text without creating injected elements',()=>{
  const d=boot(),C=d.window.PartScoutResearch,state=C.emptyState();state.draft.part='85915-30050';state.draft.notes='<img src=x onerror="alert(1)">';
  const next=boot(JSON.stringify(state));assert.equal(next.window.document.querySelectorAll('img[onerror]').length,0);
  assert.equal(next.window.document.querySelector('[data-field="notes"]').value,state.draft.notes);d.window.close();next.window.close();
});
test('a price-only draft is retained when cancelling a new case or opening another record',()=>{
  const d=boot(),w=d.window;edit(w,'part','85915-30050');w.document.querySelector('#save-record').click();
  w.document.querySelector('#new-case').click();edit(w,'saleUsd','87');
  let asks=0;w.confirm=()=>{asks++;return false;};w.document.querySelector('#new-case').click();
  assert.equal(w.document.querySelector('[data-field="saleUsd"]').value,'87');
  w.document.querySelector('[data-view="list"]').click();w.document.querySelector('[data-open]').click();
  assert.equal(JSON.parse(w.localStorage.getItem('part-scout-research-v1')).draft.saleUsd,'87');
  assert.equal(asks,2);w.close();
});
test('the 500-record limit still allows correcting an existing part number',()=>{
  const C=require('../web/research-core.js'),state=C.emptyState();
  state.records=Array.from({length:500},(_,i)=>({...C.newCase('row-'+i),part:'PART-'+(1000+i)}));
  state.draft=JSON.parse(JSON.stringify(state.records[0]));const d=boot(JSON.stringify(state)),w=d.window;
  edit(w,'part','85915-30050');w.document.querySelector('#save-record').click();
  const result=JSON.parse(w.localStorage.getItem('part-scout-research-v1'));
  assert.equal(result.records.length,500);assert.equal(result.records[0].part,'85915-30050');w.close();
});
