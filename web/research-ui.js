'use strict';
(function () {
  const C=globalThis.PartScoutResearch, P=globalThis.PartScoutPersistence;
  const KEY='part-scout-research-v1', $=selector=>document.querySelector(selector);
  let storage; try {storage=window.localStorage;} catch (_) {storage=null;}
  const store=P.createStore(storage,{guardedKeys:[KEY]});
  let state=C.emptyState(), loadError='', timer, importBusy=false, conflicted=false;
  const saved=store.read(KEY,null);
  let rawSaved=null;try{rawSaved=storage?.getItem(KEY)??null;}catch(_){}
  if(saved!==null||rawSaved!==null) try {state=C.validateState(saved);} catch(e){loadError='保存データを読み込めません。バックアップを保存してから復元してください。';}
  let blocked=Boolean(loadError);
  const labels={researching:'調査中',candidate:'候補（本人判定）',rejected:'見送り'};
  const yen=n=>n===null||!Number.isFinite(n)?'—':new Intl.NumberFormat('ja-JP',{style:'currency',currency:'JPY',maximumFractionDigits:0}).format(n);
  const usd=n=>n===null||!Number.isFinite(n)?'—':new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(n);
  const escapeHtml=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function toast(message){$('#toast').textContent=message;$('#toast').hidden=false;clearTimeout(timer);timer=setTimeout(()=>{$('#toast').hidden=true;},6000);}
  function saveStatus(ok,message){const el=$('#save-state');el.textContent=message||(ok?'入力を端末に保存済み':'保存できません。JSONバックアップを保存してください');el.classList.toggle('error',!ok);}
  function persist(){
    if(blocked){saveStatus(false,loadError||'別タブとの競合があります。バックアップ後に再読み込みしてください');return false;}
    state.savedAt=new Date().toISOString();const result=store.write(KEY,state);
    if(result.conflict){blocked=true;conflicted=true;loadError='別タブとの編集が競合しました。バックアップ後に再読み込みしてください';}
    saveStatus(result.ok,result.conflict?loadError:undefined);return result.ok;
  }
  function readField(path){return path.split('.').reduce((obj,key)=>obj?.[key],path.startsWith('settings.')?state:{...state.draft,settings:state.settings});}
  function setField(path,value){
    const parts=path.split('.');let obj=parts[0]==='settings'?state:state.draft;
    if(parts.some(x=>['__proto__','prototype','constructor'].includes(x)))return;
    for(const key of parts.slice(0,-1))obj=obj[key];
    if(Object.hasOwn(obj,parts.at(-1)))obj[parts.at(-1)]=value;
  }
  const field=(path,label,type='text',extra='')=>`<label>${label}<input data-field="${path}" type="${type}" ${type==='text'?'inputmode="decimal"':''} ${extra}></label>`;
  function buildForms(){
    $('#make').replaceChildren(...C.MAKES.map(make=>{const o=document.createElement('option');o.value=make;o.textContent=make==='OTHER'?'その他':make;return o;}));
    $('#suppliers').innerHTML=C.SUPPLIERS.map(([id,label],i)=>`<section class="source-card" data-supplier="${id}"><div class="source-heading"><label><input type="radio" name="supplier" value="${id}">${label}</label><output id="supplier-total-${id}">—</output></div><div class="fields">${field(`suppliers.${i}.priceJpy`,'税込仕入価格（円）','text','placeholder="未確認"')}${field(`suppliers.${i}.domesticJpy`,'国内送料（円）','text','placeholder="無料確認済みなら0"')}</div><label>注文可否<select data-field="suppliers.${i}.availability"><option value="unknown">未確認</option><option value="orderable">注文可能</option><option value="out_of_stock">在庫なし・注文不可</option></select></label><details><summary>根拠URL・確認日</summary>${field(`suppliers.${i}.source`,'商品ページURL','url','placeholder="https://…"')}${field(`suppliers.${i}.checkedAt`,'確認日','date')}</details></section>`).join('');
    $('#quotes').innerHTML=C.SERVICES.map(([id,label],i)=>`<section class="source-card" data-quote="${id}"><div class="source-heading"><label><input type="radio" name="shipping" value="${id}">${label}</label><output id="quote-total-${id}">—</output></div><label>見積に含む範囲<select data-field="quotes.${i}.mode"><option value="all_in">関税・通関等も含む総額</option><option value="transport">輸送費のみ（燃油込み）</option></select></label>${field(`quotes.${i}.amountJpy`,'見積金額（円）','text','placeholder="未確認"')}<div class="fields" id="quote-extras-${id}">${field(`quotes.${i}.dutyJpy`,'関税・税金（円）','text','placeholder="未確認"')}${field(`quotes.${i}.otherJpy`,'通関・処理等の追加費用（円）','text','placeholder="未確認"')}</div><div class="fields">${field(`quotes.${i}.quotedSaleUsd`,'見積時の商品売価（USD）','text','placeholder="見積条件の金額"')}${field(`quotes.${i}.checkedAt`,'見積確認日','date')}</div>${field(`quotes.${i}.source`,'見積・料金根拠のURL','url','placeholder="https://…"')}<label class="check"><input data-field="quotes.${i}.eligible" type="checkbox"><span>品目・梱包寸法・重量・米国宛ての受付条件を確認しました</span></label></section>`).join('');
    const settings=[['fx','為替（1 USD＝円）'],['fvfRate','落札手数料率（%）'],['feeThresholdUsd','落札手数料の価格境界（USD）'],['aboveRate','境界を超える部分の料率（%）'],['internationalRate','海外決済手数料（%）'],['adRate','広告料（%）'],['feeTaxRate','eBay手数料への税率（%）'],['buyerTaxRate','購入者側の税金の仮定（%）'],['orderFeeUsd','注文固定料（USD）'],['smallOrderFeeUsd','注文総額10 USD以下の固定料'],['insertionUsd','出品手数料／1件（USD）'],['payoneerRate','Payoneer・為替手数料（%）'],['payoneerFixedJpy','Payoneer固定費／1件（円）'],['annualJpy','年間口座費用の配賦／1件（円）'],['reserveRate','返品・不良引当（売上の%）'],['targetPercent','目標利益（仕入価格に対する%）']];
    $('#settings-fields').innerHTML=settings.map(([key,label])=>field('settings.'+key,label,'text','placeholder="未確認"')).join('');
  }
  function populate(){
    document.querySelectorAll('[data-field]').forEach(el=>{const value=readField(el.dataset.field);if(el.type==='checkbox')el.checked=value===true;else el.value=value??'';});
    document.querySelectorAll('[name=supplier]').forEach(el=>{el.checked=el.value===state.draft.supplierId;});
    document.querySelectorAll('[name=shipping]').forEach(el=>{el.checked=el.value===state.draft.shippingId;});
    render();
  }
  function addRow(container,title,value,small){
    const row=document.createElement('div');row.className='comparison-row';
    const name=document.createElement('span');name.textContent=title;
    if(small){const note=document.createElement('small');note.textContent=small;name.append(note);}
    const amount=document.createElement('strong');amount.textContent=value;row.append(name,amount);container.append(row);
  }
  function render(){
    const row=state.draft;
    $('#search-links').replaceChildren();
    if(row.part)try{
      const links=C.searchLinks(row.make,row.part);
      for(const [key,label] of [['sold','販売実績'],['ebay','出品中'],['monotaro','モノタロウ'],['rakuten','楽天'],['amazon','Amazon']]) {
        const a=document.createElement('a');a.href=links[key];a.textContent=label+' ↗';a.target='_blank';a.rel='noopener noreferrer';$('#search-links').append(a);
      }
      $('#part-message').textContent='販売実績：Seller＝Japan、Buyer＝United States、期間・新品単品を画面で確認します。';
    }catch(e){$('#part-message').textContent=e.message;}
    else $('#part-message').textContent='品番を入れると、各サイトを同じ品番で開けます。';
    for(const supplier of row.suppliers){$('#supplier-total-'+supplier.id).textContent=yen(C.supplierCost(supplier));$(`[data-supplier="${supplier.id}"]`).classList.toggle('selected',supplier.id===row.supplierId);}
    for(const quote of row.quotes){$('#quote-total-'+quote.id).textContent=yen(C.quoteCost(quote).total);$('#quote-extras-'+quote.id).hidden=quote.mode==='all_in';$(`[data-quote="${quote.id}"]`).classList.toggle('selected',quote.id===row.shippingId);}
    const calc=C.calculate(row,state.settings), chosen=row.quotes.find(x=>x.id===row.shippingId);
    $('#selected-service').textContent=chosen.label;$('#profit-base').textContent=yen(calc.profit);$('#profit-base').classList.toggle('negative',calc.profit!==null&&calc.profit<0);
    $('#profit-margin').textContent=calc.margin===null?'—':calc.margin.toFixed(1)+'%';$('#profit-roi').textContent=calc.roi===null?'—':calc.roi.toFixed(1)+'%';
    $('#profit-state').textContent=calc.missing.length?'費用・設定が揃うと計算します':calc.warnings.length?'入力値による参考計算・確認事項あり':'入力根拠を記録済み・仕入判断はご自身で';
    $('#comparison').replaceChildren();for(const item of C.compare(row,state.settings))addRow($('#comparison'),item.label,yen(item.result.profit),item.result.missing.length?'未入力費用あり':`${item.result.warnings.length}件の再確認事項`);
    $('#scenarios').replaceChildren();for(const [key,label] of [['bestUsd','Best'],['saleUsd','Base'],['worstUsd','Worst']]){
      const price=C.money(row[key]);const result=price===null?null:C.calculate(row,state.settings,row.shippingId,price);
      addRow($('#scenarios'),label,result?yen(result.profit):'—',price===null?'売価未入力':usd(price));
    }
    const target=C.targetPrice(row,state.settings);const targetBox=$('#target-price');targetBox.replaceChildren();targetBox.className='target';
    const targetLabel=document.createElement('span');targetLabel.textContent=`仕入価格の${state.settings.targetPercent||'—'}%を利益にする売価`;
    const targetValue=document.createElement('strong');targetValue.textContent=usd(target.priceUsd);targetBox.append(targetLabel,targetValue);
    $('#breakdown').replaceChildren();
    for(const [label,value] of [['売上（購入者送料込み）',calc.gross],['仕入価格',calc.procurement],['国内送料',calc.domestic],['梱包費',calc.packaging],['国際配送・関税等',calc.shipping],['eBay手数料・手数料への税',calc.ebay],['Payoneer等',calc.payoneer],['返品引当',calc.returnReserve],['その他',calc.other],['費用合計',calc.total]]){
      const dt=document.createElement('dt');dt.textContent=label;const dd=document.createElement('dd');dd.textContent=calc.missing.length&&label!=='国際配送・関税等'?'—':yen(value);$('#breakdown').append(dt,dd);
    }
    $('#research-warnings').replaceChildren();for(const message of [...calc.missing.map(x=>'未入力・不正：'+x),...calc.warnings]){const li=document.createElement('li');li.textContent=message;$('#research-warnings').append(li);}
    if(!calc.missing.length&&!calc.warnings.length){const li=document.createElement('li');li.textContent='見積後に売価・梱包・配送先が変わった場合は再確認してください。';$('#research-warnings').append(li);}
    const observed=$('#observed-sales');observed.hidden=row.observed90==='';observed.textContent=`自動調査からの90日換算推定：${row.observed90}個。実成約数とは別の指標です。`;
    $('#record-count').textContent=state.records.length+'件';
    if(state.view==='list')renderList();
  }
  function showView(view,save=true){
    state.view=view;document.querySelectorAll('.view').forEach(el=>{el.hidden=el.id!=='view-'+view;});
    document.querySelectorAll('[data-view]').forEach(el=>{if(el.dataset.view===view)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');});
    if(view==='list')renderList();if(save)persist();
  }
  function renderList(){
    const search=$('#list-search').value.toLowerCase(),filter=$('#list-filter').value;
    const rows=state.records.filter(r=>(filter==='all'||r.status===filter)&&[r.part,r.make,r.title,r.notes].join(' ').toLowerCase().includes(search));
    const box=$('#records');box.replaceChildren();$('#list-empty').hidden=rows.length>0;$('#list-empty').textContent=state.records.length?'条件に合う調査はありません。':'まだ保存した調査はありません。品番から調査を始めてください。';
    for(const row of rows.slice().reverse()){
      const result=C.calculate(row,state.settings),card=document.createElement('article');card.className='panel record-card';
      card.innerHTML=`<div><span class="record-status">${labels[row.status]}</span><h2>${escapeHtml(row.part)}</h2><p>${escapeHtml(row.make+' / '+(row.title||'名称未入力'))}</p></div><div><p>参考取引利益</p><p class="record-profit">${escapeHtml(yen(result.profit))}</p></div><div class="actions"><button type="button" class="button secondary" data-open="${escapeHtml(row.id)}">開いて続ける</button><button type="button" class="button secondary danger-button" data-delete="${escapeHtml(row.id)}">削除</button></div>`;box.append(card);
    }
  }
  function saveRecord(){
    if(!C.validPart(state.draft.part)){toast('有効な品番を入力してください');$('#part').focus();return;}
    if(blocked){persist();return;}
    const record=JSON.parse(JSON.stringify(state.draft));record.part=C.partNumber(record.part);record.updatedAt=new Date().toISOString();
    const same=state.records.find(x=>C.caseKey(x)===C.caseKey(record));
    if(record.id&&same&&same.id!==record.id){toast('同じメーカー・品番が別の記録にあります。先にその記録を開いてください');return;}
    if(!same&&state.records.length>=500){toast('保存は500件までです。バックアップ後に不要な記録を削除してください');return;}
    record.id=same?.id||record.id||crypto.randomUUID();
    const index=state.records.findIndex(x=>x.id===record.id);if(index<0)state.records.push(record);else state.records[index]=record;
    state.draft=JSON.parse(JSON.stringify(record));const ok=persist();populate();toast(ok?'調査リストに保存しました':'保存できませんでした。JSONバックアップで入力を保護してください');
  }
  function download(content,name,type){
    const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);
  }
  function backup(){
    let conflicts=[];try{conflicts=store.conflicts(KEY);}catch(_){}
    let unreadableStoredValue=rawSaved;try{unreadableStoredValue=storage?.getItem(KEY)??rawSaved;}catch(_){}
    download(JSON.stringify({application:'part-scout-research',data:state,conflicts,...(loadError?{unreadableStoredValue}:{})},null,2),'part-scout-research-'+new Date().toISOString().slice(0,10)+'.json','application/json');
  }
  async function fileJson(file){if(!file)return null;if(file.size>5*1024*1024)throw Error('5MB以下のJSONを選んでください');return JSON.parse(await file.text());}
  function importRows(payload){
    const incoming=C.importProducts(payload),keys=new Set(state.records.map(C.caseKey));
    const fresh=incoming.filter(row=>!keys.has(C.caseKey(row)));
    if(state.records.length+fresh.length>500)throw Error('保存件数が500件を超えます');
    if(!fresh.length){toast('追加できる新しい品番はありません');return;}
    if(blocked)throw Error('保存の問題を解消してから取り込んでください');
    if(!window.confirm(`${fresh.length}品番を追加します。既存の記録は上書きしません。`))return;
    state.records.push(...fresh.map(row=>({...row,id:crypto.randomUUID()})));const ok=persist();render();toast(ok?fresh.length+'品番を追加しました':'追加内容を端末に保存できません。JSONバックアップで保護してください');
  }
  buildForms();populate();showView(state.view,false);
  document.addEventListener('input',event=>{
    const el=event.target;
    if(el.matches('[data-field]')){setField(el.dataset.field,el.type==='checkbox'?el.checked:el.value);if(el.dataset.field.startsWith('settings.')&&el.dataset.field!=='settings.feesConfirmed'){
      state.settings.feesConfirmed=false;$('[data-field="settings.feesConfirmed"]').checked=false;
    }persist();render();}
  });
  document.addEventListener('change',event=>{
    const el=event.target;
    if(el.matches('[name=supplier],[name=shipping]')){state.draft[el.name==='supplier'?'supplierId':'shippingId']=el.value;persist();render();}
  });
  document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>showView(button.dataset.view)));
  $('#save-record').addEventListener('click',saveRecord);
  $('#new-case').addEventListener('click',()=>{
    if(state.draft.part||state.draft.notes||state.draft.title){if(!window.confirm('入力中の調査を新規入力に切り替えます。残す場合は先に「調査リストに保存」を押してください。'))return;}
    state.draft=C.newCase();persist();populate();$('#part').focus();
  });
  $('#choose-cheapest').addEventListener('click',()=>{const best=C.cheapestSupplier(state.draft);if(!best){toast('税込価格・国内送料・注文可能を確認した仕入先がありません');return;}state.draft.supplierId=best.id;persist();populate();toast(best.label+'を選択しました。価格・在庫の確認日もご確認ください');});
  $('#list-search').addEventListener('input',renderList);$('#list-filter').addEventListener('change',renderList);
  $('#records').addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;const id=button.dataset.open||button.dataset.delete;
    const row=state.records.find(x=>x.id===id);if(!row)return;
    if(button.dataset.open){
      if(state.draft.part&&JSON.stringify(state.draft)!==JSON.stringify(state.records.find(x=>x.id===state.draft.id))&&!window.confirm('入力中の内容を、この保存済み調査に切り替えますか？'))return;
      state.draft=JSON.parse(JSON.stringify(row));populate();showView('research');
    }else if(window.confirm(row.part+'を調査リストから削除しますか？')){
      state.records=state.records.filter(x=>x.id!==id);if(state.draft.id===id)state.draft.id='';persist();renderList();render();
    }
  });
  for(const id of ['backup','backup-list'])$('#'+id).addEventListener('click',backup);
  $('#export-csv').addEventListener('click',()=>download(C.exportCsv(state.records,state.settings),'part-scout-research.csv','text/csv;charset=utf-8'));
  $('#restore-file').addEventListener('change',async event=>{
    try{
      const raw=await fileJson(event.target.files[0]);if(!raw)return;const restored=C.validateState(raw.data||raw);
      if(!window.confirm(`${restored.records.length}件の記録と入力中の内容を復元します。現在のバックアップをダウンロードしてから置き換えます。`))return;
      backup();if(conflicted)throw Error('バックアップを保存しました。別タブを閉じて再読み込みし、もう一度復元してください');
      const result=store.write(KEY,restored);
      if(!result.ok){if(result.conflict){conflicted=true;blocked=true;loadError='別タブとの編集が競合しました。バックアップ後に再読み込みしてください';saveStatus(false,loadError);}throw Error('保存できないため復元しませんでした');}
      state=restored;blocked=false;loadError='';rawSaved=null;populate();showView(state.view,false);saveStatus(true);toast('復元しました');
    }catch(e){toast(e.message);}finally{event.target.value='';}
  });
  $('#import-file').addEventListener('change',async event=>{try{const raw=await fileJson(event.target.files[0]);if(raw)importRows(raw);}catch(e){toast(e.message);}finally{event.target.value='';}});
  $('#import-latest').addEventListener('click',async()=>{
    if(importBusy)return;importBusy=true;const button=$('#import-latest');button.disabled=true;
    const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),10000);
    try{
      const responses=await Promise.all(['setup_status.json','results.json'].map(file=>fetch('./data/'+file,{cache:'no-store',signal:controller.signal})));
      if(responses.some(r=>!r.ok))throw Error('調査結果を読み込めません。接続状態を確認してください');
      const [setup,payload]=await Promise.all(responses.map(r=>r.json()));
      if(!setup.ready)throw Error('GitHub版の自動調査が未接続です。品番を手入力して調査できます');
      importRows(payload);
    }catch(e){toast(e.name==='AbortError'?'読み込みがタイムアウトしました':e.message);}finally{clearTimeout(timeout);importBusy=false;button.disabled=false;}
  });
  function connection(){$('#connection-state').textContent=navigator.onLine===false?'オフライン':'iPhone内に保存';}
  window.addEventListener('online',connection);window.addEventListener('offline',connection);connection();
  document.addEventListener('visibilitychange',()=>{if(document.hidden)persist();});window.addEventListener('pagehide',persist);
  if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(()=>{});
  // Keep a single copy of every result: compact total above the form, detail below it on phones.
  const resultPanels=Array.from(document.querySelectorAll('.results > .panel'));
  const mobile=document.createElement('div');mobile.className='mobile-results';$('.workspace').after(mobile);
  function layout(){const target=window.innerWidth<=760?mobile:$('.results');resultPanels.forEach(panel=>target.append(panel));}
  window.addEventListener('resize',layout);layout();
  saveStatus(!loadError,loadError||(store.recovered?'直前の保存データから復元しました':saved?'入力を端末から復元しました':'入力はこの端末に自動保存されます'));
})();
