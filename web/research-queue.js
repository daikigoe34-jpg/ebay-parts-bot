"use strict";
(function(root) {
  const P = root.PartScoutParcel || require("./part-parcel.js");
  const Sync = root.PartScoutSync || require("./workspace-sync.js");
  const key = "part-scout-research-queue-v1";
  const statuses = {waiting:"調査待ち",researching:"調査中",confirm:"要確認",complete:"完了"};
  const clone = v => JSON.parse(JSON.stringify(v));
  function validateDraft(draft) {
    Sync.safe(draft);
    const fields = ["region","weightKg","declaredValueUsd","lengthCm","widthCm","heightCm"];
    if (!draft || typeof draft !== "object" || Array.isArray(draft) || !Object.keys(draft).every(k => k === "partLookup" || (fields.includes(k) && typeof draft[k] === "string" && draft[k].length <= 100)) || (draft.region && !["US48","OTHER"].includes(draft.region))) throw Error("見積の形式が違います。");
    if (draft.partLookup != null) {
      const lookup = root.PartScoutLookup || require("./part-lookup-ui.js");
      draft = {...draft,partLookup:lookup.validateState(draft.partLookup)};
    }
    return clone(draft);
  }
  function identity(manufacturer, part) {
    const make = String(manufacturer).trim().toUpperCase();
    const partNumber = P.normalizePart(make,part);
    if (!partNumber) throw Error("メーカーと正確な品番を入力してください。");
    return {id:`${make}:${partNumber}`,manufacturer:make,partNumber};
  }
  function validate(value) {
    Sync.safe(value);
    if (!value || value.version !== 1 || !Array.isArray(value.items) || value.items.length > 50 || !(value.activeId === null || typeof value.activeId === "string")) throw Error("調査リストの形式が違います（最大50件）。");
    const ids = new Set();
    const items = value.items.map(item => {
      const ident = identity(item.manufacturer,item.partNumber);
      if (ident.id !== item.id || ids.has(item.id) || !Object.hasOwn(statuses,item.status) || typeof item.note !== "string" || item.note.length > 2000) throw Error("調査項目の形式が違います。");
      ids.add(item.id);
      return {...ident,status:item.status,note:item.note,draft:item.draft === null ? null : validateDraft(item.draft)};
    });
    if (value.activeId !== null && !ids.has(value.activeId)) throw Error("再開する項目が見つかりません。");
    return {version:1,items,activeId:value.activeId};
  }
  function createQueue(options) {
    let data = {version:1,items:[],activeId:null};
    let loadError = false;
    let lastRaw = null;
    try { const raw = options.storage?.getItem(key); lastRaw=raw; if (raw) data = validate(JSON.parse(raw)); }
    catch (_) { loadError = true; options.onError?.("保存した調査リストを読み込めません。バックアップを確認してください。"); }
    function commit(next,notify=true) {
      if (loadError) throw Error("保存した調査リストを保護しています。バックアップを確認してください。");
      next = validate(next);
      const raw = JSON.stringify(next);
      // Leave room for the sync request envelope.
      const bytes = typeof TextEncoder !== "undefined" ? new TextEncoder().encode(raw).length : new Blob([raw]).size;
      if (bytes > 1950000) throw Error("調査リストの容量が大きすぎます。バックアップを保存してください。");
      const currentRaw = options.storage?.getItem(key);
      if (currentRaw !== lastRaw) {
        const history = JSON.parse(options.storage.getItem(`${key}:tab-conflicts`) || "[]");
        if (history.length >= 20) throw Error("別のタブとの競合保存がいっぱいです。バックアップして再読み込みしてください。");
        history.push({local:next,remote:JSON.parse(currentRaw),savedAt:new Date().toISOString()});
        options.storage.setItem(`${key}:tab-conflicts`,JSON.stringify(history));
        throw Error("別のタブで調査リストが変わりました。両方をバックアップして、このページを再読み込みしてください。");
      }
      try { options.storage.setItem(key,raw); lastRaw=raw; }
      catch (_) { throw Error("保存領域が不足しています。現在の見積は残しています。"); }
      data=next; if(notify) options.onChange?.(); return true;
    }
    function add(make,part) {
      const ident = identity(make,part);
      const existing = data.items.find(x=>x.id===ident.id); if (existing) return clone(existing);
      if (data.items.length >= 50) throw Error("調査リストは最大50件です。完了した項目をバックアップして整理してください。");
      const item={...ident,status:"waiting",note:"",draft:null};
      commit({...data,items:[...data.items,item]});return clone(item);
    }
    function update(id,patch) {const next=clone(data),item=next.items.find(x=>x.id===id);if(!item)throw Error("項目がありません。");for(const field of ["status","note"])if(Object.hasOwn(patch,field))item[field]=patch[field];commit(next);}
    function capture(draft) {if(!data.activeId)return true;const next=clone(data);next.items.find(x=>x.id===next.activeId).draft=validateDraft(draft);return commit(next);}
    function resume(id,adapter) {
      const next=clone(data),target=next.items.find(x=>x.id===id);if(!target)throw Error("項目がありません。");
      if(next.activeId && adapter)next.items.find(x=>x.id===next.activeId).draft=validateDraft(adapter.capture());
      const draft=adapter ? validateDraft(target.draft || adapter.fresh(target)) : null;
      const previous=clone(data);next.activeId=id;commit(next);
      if(adapter)try {if(adapter.apply(draft)===false)throw Error("見積を保存できません。");}catch(error){commit(previous);throw error;}
      return clone(target);
    }
    function handoff(href) {
      const url=new URL(href);url.search="";url.hash="";url.username="";url.password="";
      const pending=data.items.filter(x=>x.status!=="complete");
      return `Part Scoutの続きです。現在のページ：${url.href}\n${pending.map(x=>`${x.manufacturer} ${x.partNumber}［${statuses[x.status]}］ 未確認：${x.note || "重量・梱包寸法、適合、仕入価格・在庫・送料、原産国・関税を確認"}`).join("\n") || "未完了の項目はありません。"}\n保存した調査リストから送料見積を再開してください。取得は明示操作のみ。進捗は手動の記録で、購入・出品の承認ではありません。`;
    }
    return {add,update,resume,capture,handoff,backupExtras:()=>({tabConflicts:JSON.parse(options.storage?.getItem(`${key}:tab-conflicts`)||"[]")}),snapshot:()=>clone(data),restore:next=>commit(next),applyRemote:next=>commit(next,false),remove(id){commit({...data,items:data.items.filter(x=>x.id!==id),activeId:data.activeId===id?null:data.activeId});}};
  }
  function mount(container,options={}) {
    if(!container)return null;
    let storage;try{storage=root.localStorage;}catch(_){}
    container.innerHTML='<h2>続きから調査</h2><p>eBay未接続でも保存できます。進捗は自分で記録します（購入・出品の承認ではありません）。</p><form data-queue-add class="workspace-actions"><label>メーカー<select name="manufacturer"><option>TOYOTA</option><option>NISSAN</option><option>HONDA</option><option>SUBARU</option></select></label><label>正確な品番<input name="partNumber" maxlength="40" required placeholder="90915-10001"></label><button type="submit">調査に追加</button></form><p data-queue-message role="status"></p><div data-queue-sync></div><div data-queue-items></div><div class="workspace-actions"><button type="button" data-queue-import>調査リストを復元</button><input type="file" data-queue-file accept=".json,application/json" hidden></div><button type="button" data-queue-handoff>Workへの引き継ぎ文を作る</button><label data-handoff-label hidden>コピーしてWorkへ貼り付け<textarea data-handoff readonly rows="7"></textarea></label>';
    const message=container.querySelector('[data-queue-message]');let sync;
    const queue=createQueue({storage,onChange:()=>sync?.changed(),onError:text=>message.textContent=text});
    function perform(fn){try{fn();message.textContent="端末に保存しました。";return true;}catch(error){message.textContent=error.message;return false;}}
    function render() {
      const list=container.querySelector('[data-queue-items]');list.replaceChildren();
      const data=queue.snapshot();
      for(const item of data.items) {
        const row=document.createElement('article');row.className='research-item';list.append(row);
        const title=document.createElement('h3');title.textContent=`${item.manufacturer} ${item.partNumber}${data.activeId===item.id ? '（作業中）':''}`;row.append(title);
        const label=document.createElement('label');label.textContent='進捗';const select=document.createElement('select');select.setAttribute('aria-label',`${item.partNumber}の進捗`);for(const [value,text]of Object.entries(statuses)){const o=document.createElement('option');o.value=value;o.textContent=text;select.append(o);}select.value=item.status;label.append(select);row.append(label);select.onchange=()=>perform(()=>queue.update(item.id,{status:select.value}));
        const noteLabel=document.createElement('label');noteLabel.textContent='残りの確認・メモ';const note=document.createElement('textarea');note.maxLength=2000;note.value=item.note;note.setAttribute('aria-label',`${item.partNumber}のメモ`);noteLabel.append(note);row.append(noteLabel);note.oninput=()=>perform(()=>queue.update(item.id,{note:note.value}));
        const actions=document.createElement('div');actions.className='workspace-actions';row.append(actions);
        const resume=document.createElement('button');resume.type='button';resume.textContent='送料見積を再開';resume.onclick=()=>{if(perform(()=>queue.resume(item.id,options.adapter))){render();if(!options.adapter)root.location.href='./shipping-calculator.html?research='+encodeURIComponent(item.id);}};actions.append(resume);
        const remove=document.createElement('button');remove.type='button';remove.textContent='項目を削除';remove.onclick=()=>{if(root.confirm('この調査項目と保存見積を削除しますか？必要な場合は先にバックアップしてください。')&&perform(()=>queue.remove(item.id)))render();};actions.append(remove);
      }
    }
    sync=Sync.mountStatus(container.querySelector('[data-queue-sync]'),{namespace:'queue',storage,getLocal:queue.snapshot,backupExtras:queue.backupExtras,hasLocal:()=>storage?.getItem(key)!=null,validate,canApply:()=>!container.contains(document.activeElement)||!document.activeElement.matches('input,textarea,select'),applyRemote:data=>{queue.applyRemote(data);render();}});
    container.querySelector('[data-queue-add]').onsubmit=event=>{event.preventDefault();const form=event.currentTarget;if(perform(()=>queue.add(form.elements.manufacturer.value,form.elements.partNumber.value))){form.elements.partNumber.value='';render();}};
    container.querySelector('[data-queue-handoff]').onclick=async()=>{const text=queue.handoff(root.location.href);const area=container.querySelector('[data-handoff]');area.value=text;container.querySelector('[data-handoff-label]').hidden=false;area.focus();area.select();try{await root.navigator.clipboard.writeText(text);message.textContent='引き継ぎ文をコピーしました。';}catch(_){message.textContent='表示した文をコピーしてWorkへ貼り付けてください。';}};
    const fileInput=container.querySelector('[data-queue-file]');let importGeneration=0;
    container.querySelector('[data-queue-import]').onclick=()=>fileInput.click();
    fileInput.onchange=async()=>{
      const file=fileInput.files?.[0];if(!file)return;
      const generation=++importGeneration, before=JSON.stringify(queue.snapshot());
      try {
        if(file.size>2000000)throw Error("2MB以下の調査リストを選んでください。");
        const value=JSON.parse(await file.text());
        if(generation!==importGeneration)return;
        if(JSON.stringify(queue.snapshot())!==before)throw Error("入力または同期データが変わったため復元を中止しました。");
        if(value.format!==key)throw Error("調査リストのバックアップを選んでください。");
        const next=validate(value.data);
        storage.setItem(`${key}:before-import`,before);
        queue.restore(next);render();message.textContent="調査リストを復元しました。見積の再開は項目のボタンを押してください。";
      }catch(error){message.textContent=error.message||"復元できませんでした。";}finally{if(generation===importGeneration)fileInput.value="";}
    };
    render();sync.start();
    return {queue,sync,capture:draft=>perform(()=>queue.capture(draft)),resumeRequested(id){const item=queue.snapshot().items.find(x=>x.id===id);if(item&&options.adapter)perform(()=>{if(options.adapter.apply(item.draft || options.adapter.fresh(item))===false)throw Error("見積を保存できません。");});render();}};
  }
  root.PartScoutQueue={key,statuses,validate,validateDraft,createQueue,mount};
  if(typeof module!=="undefined"&&module.exports)module.exports=root.PartScoutQueue;
})(typeof globalThis!=="undefined"?globalThis:this);
