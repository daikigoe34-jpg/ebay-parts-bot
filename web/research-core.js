'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PartScoutResearch = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const MAKES = ['TOYOTA','NISSAN','HONDA','SUBARU','MAZDA','SUZUKI','MITSUBISHI','DAIHATSU','LEXUS','OTHER'];
  const SUPPLIERS = [['monotaro','モノタロウ'],['rakuten','楽天'],['amazon','Amazon'],['other','その他 / Amayama']];
  const SERVICES = [['speedpak','SpeedPAK Economy'],['ems','日本郵便 EMS'],['airpacket','日本郵便 国際エアパケット']];
  const copy = value => JSON.parse(JSON.stringify(value));
  const text = value => String(value ?? '').normalize('NFKC').trim();
  function money(value) {
    if (value == null || typeof value === 'boolean' || !['number','string'].includes(typeof value)) return null;
    const raw = text(value);
    if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) return null;
    const n = Number(raw.replace(/,/g,''));
    return Number.isFinite(n) && n >= 0 && n <= 1e9 ? n : null;
  }
  function partNumber(value) {
    return text(value).toUpperCase().replace(/[−‐‑–—ー]/g,'-').replace(/\s/g,'');
  }
  function validPart(value) { const part=partNumber(value); return /^[A-Z0-9][A-Z0-9-]{3,29}$/.test(part) && /\d/.test(part); }
  function safeUrl(value) {
    try { const u = new URL(text(value)); return u.protocol === 'https:' && !u.username && !u.password ? u.href : ''; }
    catch (_) { return ''; }
  }
  function searchLinks(make, part) {
    part = partNumber(part); if (!validPart(part)) throw Error('品番を入力してください。商品URLは根拠URL欄に保存できます。');
    const query = `${MAKES.includes(make) && make !== 'OTHER' ? make + ' ' : ''}${part}`;
    return {
      ebay:`https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(query)}&LH_ItemCondition=1000`,
      sold:`https://www.ebay.com/sh/research?marketplace=EBAY-US&keywords=${encodeURIComponent(query)}`,
      monotaro:`https://www.monotaro.com/s/q-${encodeURIComponent(part)}/`,
      rakuten:`https://search.rakuten.co.jp/search/mall/${encodeURIComponent(part)}/`,
      amazon:`https://www.amazon.co.jp/s?k=${encodeURIComponent(part)}`,
      other:`https://www.amayama.com/en/catalogs`,
    };
  }
  function defaultSettings() {
    return {fx:'',fvfRate:'13.6',feeThresholdUsd:'7500',aboveRate:'2.35',internationalRate:'1.35',adRate:'0',
      feeTaxRate:'10',buyerTaxRate:'',orderFeeUsd:'0.40',smallOrderFeeUsd:'0.30',insertionUsd:'0',
      payoneerRate:'',payoneerFixedJpy:'0',annualJpy:'0',reserveRate:'3',targetPercent:'20',feesConfirmed:false};
  }
  function newCase(id = '') {
    return {id,make:'TOYOTA',part:'',title:'',market:'US',status:'researching',notes:'',source:'',
      saleUsd:'',bestUsd:'',worstUsd:'',buyerShippingUsd:'0',packagingJpy:'',otherJpy:'0',
      sold90:'',sold365:'',observed90:'',soldSource:'',soldCheckedAt:'',periodEnd:'',scopeConfirmed:false,
      supplierId:'monotaro',shippingId:'speedpak',updatedAt:'',
      suppliers:SUPPLIERS.map(([id,label])=>({id,label,priceJpy:'',domesticJpy:'',availability:'unknown',source:'',checkedAt:''})),
      quotes:SERVICES.map(([id,label])=>({id,label,mode:'all_in',amountJpy:'',dutyJpy:'',otherJpy:'',source:'',checkedAt:'',quotedSaleUsd:'',eligible:false})),
    };
  }
  function emptyState() { return {schema:1,settings:defaultSettings(),draft:newCase(),records:[],view:'research',savedAt:''}; }
  function caseKey(row) { return [row.make,partNumber(row.part).replace(/-/g,''),row.market].join(':'); }
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const t = Date.parse(value+'T00:00:00Z');
    return Number.isFinite(t) && new Date(t).toISOString().slice(0,10) === value;
  }
  function fresh(value, now = new Date()) {
    if (!validDate(value)) return false;
    const age = new Date(now).getTime() - Date.parse(value+'T00:00:00Z');
    return age >= -86400000 && age <= 8*86400000;
  }
  function supplierCost(supplier) {
    const price=money(supplier?.priceJpy), shipping=money(supplier?.domesticJpy);
    return price !== null && price > 0 && shipping !== null ? price+shipping : null;
  }
  function cheapestSupplier(row) {
    let best = null;
    for (const supplier of row.suppliers) {
      const cost = supplierCost(supplier);
      if (supplier.availability === 'orderable' && cost !== null && (!best || cost < best.total)) best = {...supplier,total:cost};
    }
    return best;
  }
  function quoteCost(quote) {
    const missing=[]; const amount=money(quote?.amountJpy);
    if (amount === null) missing.push('配送見積額');
    let duty=0,other=0;
    if (quote?.mode === 'transport') {
      duty=money(quote.dutyJpy); other=money(quote.otherJpy);
      if(duty === null) missing.push('関税・税金');
      if(other === null) missing.push('通関・処理等の追加費用');
    } else if (quote?.mode !== 'all_in') missing.push('見積範囲');
    return {total:missing.length ? null : amount+duty+other,missing};
  }
  function calculate(row, settings, serviceId=row.shippingId, priceOverride, now=new Date()) {
    const missing=[], warnings=[];
    const number = (value,label,positive=false,max=1e9) => {
      const n=money(value); if(n===null || (positive && n<=0) || n>max) {missing.push(label);return 0;} return n;
    };
    const price=number(priceOverride ?? row.saleUsd,'販売価格',true);
    const buyerShipping=number(row.buyerShippingUsd,'購入者から受け取る送料');
    const fx=number(settings.fx,'為替',true);
    const supplier=row.suppliers.find(x=>x.id===row.supplierId);
    const procurement=number(supplier?.priceJpy,'仕入価格',true);
    const domestic=number(supplier?.domesticJpy,'国内送料');
    if(supplier?.availability==='out_of_stock') missing.push('選択した仕入先は在庫なし');
    const packaging=number(row.packagingJpy,'梱包費'), other=number(row.otherJpy,'その他の取引費用');
    const quote=row.quotes.find(x=>x.id===serviceId), shipping=quoteCost(quote);
    missing.push(...shipping.missing);
    const rate = (key,label) => number(settings[key],label,false,100)/100;
    const fvf=rate('fvfRate','落札手数料率'), above=rate('aboveRate','上限超過分料率');
    const threshold=number(settings.feeThresholdUsd,'手数料の価格境界',true);
    const international=rate('internationalRate','海外決済料率'), ads=rate('adRate','広告料率');
    const feeTax=rate('feeTaxRate','手数料への税率'), buyerTax=rate('buyerTaxRate','購入者側の税率');
    const payoneer=rate('payoneerRate','Payoneer・為替手数料率'), reserve=rate('reserveRate','返品引当率');
    const feeBase=(price+buyerShipping)*(1+buyerTax), gross=(price+buyerShipping)*fx;
    const order=number(feeBase<=10 ? settings.smallOrderFeeUsd : settings.orderFeeUsd,'注文固定料');
    const insertion=number(settings.insertionUsd,'出品料');
    const ebay=(Math.min(feeBase,threshold)*fvf+Math.max(0,feeBase-threshold)*above+feeBase*(international+ads)+order+insertion)*fx*(1+feeTax);
    const payoneerFee=Math.max(0,gross-ebay)*payoneer+number(settings.payoneerFixedJpy,'Payoneer固定費')+number(settings.annualJpy,'年間費用の配賦');
    const returnReserve=gross*reserve;
    const total=ebay+payoneerFee+returnReserve+procurement+domestic+packaging+other+(shipping.total??0);
    if(!settings.feesConfirmed) warnings.push('手数料設定が未確認です');
    if(!fresh(supplier?.checkedAt,now)) warnings.push('仕入条件の確認日が未入力・期限切れです');
    if(!safeUrl(supplier?.source)) warnings.push('仕入価格の根拠URLが未入力です');
    if(supplier?.availability!=='orderable') warnings.push('仕入先の注文可否が未確認です');
    if(!fresh(quote?.checkedAt,now)) warnings.push('配送見積の確認日が未入力・期限切れです');
    if(!safeUrl(quote?.source)) warnings.push('配送見積の根拠URLが未入力です');
    if(!quote?.eligible) warnings.push('配送サービスの利用条件が未確認です');
    if(money(quote?.quotedSaleUsd)!==price) warnings.push('見積時と売価が異なるか未記録です。関税等の再見積が必要です');
    if(!row.scopeConfirmed || !safeUrl(row.soldSource) || !fresh(row.soldCheckedAt,now) || !validDate(row.periodEnd) || !Number.isInteger(money(row.sold90)) || (row.sold365!==''&&!Number.isInteger(money(row.sold365))))
      warnings.push('日本出品→米国購入・新品単品の販売実績が未確認です');
    const profit=missing.length ? null : gross-total;
    return {profit,total:profit===null?null:total,gross,ebay,payoneer:payoneerFee,returnReserve,shipping:shipping.total,
      procurement,domestic,packaging,other,margin:profit===null?null:profit/gross*100,
      roi:profit===null?null:profit/total*100,missing:[...new Set(missing)],warnings:[...new Set(warnings)]};
  }
  function compare(row,settings,now=new Date()) {
    return row.quotes.map(q=>({id:q.id,label:q.label,result:calculate(row,settings,q.id,undefined,now)}))
      .sort((a,b)=>(b.result.profit??-Infinity)-(a.result.profit??-Infinity));
  }
  function targetPrice(row,settings,serviceId=row.shippingId,now=new Date()) {
    const pct=money(settings.targetPercent), supplier=row.suppliers.find(x=>x.id===row.supplierId), cost=money(supplier?.priceJpy);
    const initial=calculate(row,settings,serviceId,1,now);
    if(initial.missing.length || pct===null || pct>1000 || cost===null) return {priceUsd:null,targetJpy:null};
    const target=cost*pct/100;
    // Search integer cents in each linear fee segment: never skip the $10 order-fee discontinuity.
    const buyer=money(row.buyerShippingUsd), tax=money(settings.buyerTaxRate)/100;
    const breaks=[10,money(settings.feeThresholdUsd)].map(x=>Math.floor((x/(1+tax)-buyer)*100)).filter(x=>x>=1&&x<100000000);
    const ends=[...new Set([...breaks,100000000])].sort((a,b)=>a-b);
    let start=1;
    for(const end of ends) {
      const at = cents => calculate(row,settings,serviceId,cents/100,now).profit;
      if(at(start)>=target-1e-8) return {priceUsd:start/100,targetJpy:target};
      if(at(end)>=target-1e-8) {
        let lo=start,hi=end;
        while(lo<hi) {const mid=Math.floor((lo+hi)/2);if(at(mid)>=target-1e-8)hi=mid;else lo=mid+1;}
        return {priceUsd:lo/100,targetJpy:target};
      }
      start=end+1;
    }
    return {priceUsd:null,targetJpy:target};
  }
  function assertSafe(value,depth=0) {
    if(depth>12) throw Error('保存データの階層が深すぎます');
    if(value && typeof value==='object') for(const key of Object.keys(value)) {
      if(['__proto__','prototype','constructor'].includes(key)) throw Error('不正な保存データです');
      assertSafe(value[key],depth+1);
    }
  }
  function normalizeRecord(value,template) {
    if(!value || typeof value!=='object' || Array.isArray(value)) throw Error('保存データの形式が違います');
    const out=copy(template);
    for(const key of Object.keys(template)) {
      if(!Object.hasOwn(value,key) || Array.isArray(template[key])) continue;
      if(typeof template[key]==='boolean') {if(typeof value[key]!=='boolean')throw Error('確認状態の形式が違います');}
      else if(typeof value[key]!=='string' || value[key].length>(key==='notes'?4000:2000)) throw Error('保存値の形式・長さが違います');
      out[key]=value[key];
    }
    return out;
  }
  function normalizeCase(value) {
    const out=normalizeRecord(value,newCase());
    if(!MAKES.includes(out.make)||out.market!=='US'||!['researching','candidate','rejected'].includes(out.status))throw Error('対象国・メーカー・状態の形式が違います');
    for(const field of ['suppliers','quotes']) {
      if(!Array.isArray(value[field])||value[field].length!==out[field].length)throw Error('見積・仕入先の形式が違います');
      out[field]=out[field].map(template=>{
        const found=value[field].filter(x=>x?.id===template.id);
        if(found.length!==1)throw Error('見積・仕入先が重複しています');
        const item=normalizeRecord(found[0],template); item.label=template.label;
        if(field==='quotes'&&!['all_in','transport'].includes(item.mode))throw Error('見積範囲が不正です');
        if(field==='suppliers'&&!['unknown','orderable','out_of_stock'].includes(item.availability))throw Error('在庫状態が不正です');
        return item;
      });
    }
    if(!out.suppliers.some(x=>x.id===out.supplierId)||!out.quotes.some(x=>x.id===out.shippingId))throw Error('選択した見積がありません');
    return out;
  }
  function validateState(value) {
    assertSafe(value);
    if(!value||value.schema!==1||!Array.isArray(value.records)||value.records.length>500)throw Error('このバックアップ形式には対応していません（最大500件）');
    const state=emptyState(); state.settings=normalizeRecord(value.settings,defaultSettings());
    state.draft=normalizeCase(value.draft); state.records=value.records.map(normalizeCase);
    const ids=new Set(),keys=new Set();
    for(const row of state.records) {
      if(!row.id||!validPart(row.part)||ids.has(row.id)||keys.has(caseKey(row)))throw Error('品番が不正、または記録が重複しています');
      ids.add(row.id);keys.add(caseKey(row));
    }
    state.view=['research','list','settings'].includes(value.view)?value.view:'research';
    state.savedAt=typeof value.savedAt==='string'?value.savedAt.slice(0,40):''; return state;
  }
  function importProducts(payload) {
    assertSafe(payload);
    if(!payload||payload.demo_data||!Array.isArray(payload.products)||payload.products.length>500)throw Error('products配列のある実調査JSONを選んでください（最大500件）');
    const seen=new Set();
    return payload.products.map((p,i)=>{
      if(!p||!validPart(p.part_number)||/^DEMO:/i.test(p.title||''))throw Error('品番が不正、またはデモデータです');
      const row=newCase(`import-${i}-${partNumber(p.part_number)}`);
      row.part=partNumber(p.part_number); row.make=MAKES.includes(text(p.brand).toUpperCase())?text(p.brand).toUpperCase():'OTHER';
      row.title=String(p.title||'').slice(0,2000);
      const value=money(p.price_median_usd); row.saleUsd=value===null?'':String(value);
      const sold=money(p.sold_90d_est);row.observed90=sold===null?'':String(sold);
      row.source=safeUrl(p.item_web_url||p.ebay_url); row.updatedAt=String(payload.generated_at||'').slice(0,40);
      row.notes='自動調査JSONから取込。価格は出品相場、販売数は観測推定です。仕入・配送・販売実績は未確認です。';
      return row;
    }).filter(row=>{const key=caseKey(row);if(seen.has(key))return false;seen.add(key);return true;});
  }
  function csvCell(value) {
    let s=String(value??''); if(/^[\s]*[=+\-@\t\r]/.test(s))s="'"+s;
    return '"'+s.replace(/"/g,'""')+'"';
  }
  function exportCsv(records,settings,now=new Date()) {
    const fields=['メーカー','品番','商品名','状態（本人判定）','販売価格USD','90日実績（本人確認）','90日観測推定','配送','参考取引利益JPY','不足費用','再確認事項','根拠URL','メモ'];
    return '\uFEFF'+[fields,...records.map(row=>{const r=calculate(row,settings,row.shippingId,undefined,now);return [row.make,row.part,row.title,row.status,row.saleUsd,row.sold90,row.observed90,row.shippingId,r.profit===null?'':r.profit.toFixed(2),r.missing.join(' / '),r.warnings.join(' / '),row.source,row.notes];})].map(row=>row.map(csvCell).join(',')).join('\r\n');
  }
  return {MAKES,SUPPLIERS,SERVICES,money,partNumber,validPart,safeUrl,searchLinks,defaultSettings,newCase,emptyState,caseKey,fresh,supplierCost,cheapestSupplier,quoteCost,calculate,compare,targetPrice,validateState,importProducts,exportCsv};
});
