const test = require('node:test');
const assert = require('node:assert/strict');
let C = {}; try { C = require('../web/research-core.js'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const now = new Date('2026-09-21T12:00:00Z');
function fixture() {
  const row = C.newCase('case-1');
  Object.assign(row, {make:'TOYOTA',part:'85915-30050',saleUsd:'100',buyerShippingUsd:'10',packagingJpy:'100',otherJpy:'0',supplierId:'monotaro'});
  Object.assign(row.suppliers[0], {priceJpy:'1000',domesticJpy:'100',availability:'orderable',source:'https://www.monotaro.com/p/1/',checkedAt:'2026-09-21'});
  Object.assign(row.quotes[0], {amountJpy:'2000',dutyJpy:'500',otherJpy:'100',mode:'transport',source:'https://www.orangeconnex.jp/',checkedAt:'2026-09-21',quotedSaleUsd:'100',eligible:true});
  const settings = {...C.defaultSettings(),fx:'150',fvfRate:'10',internationalRate:'1',adRate:'2',feeTaxRate:'10',buyerTaxRate:'0',payoneerRate:'3',payoneerFixedJpy:'20',annualJpy:'0',reserveRate:'3',insertionUsd:'0',feesConfirmed:true};
  return {row,settings};
}
test('unknown and malformed money do not silently become zero',()=> {
  for(const value of ['',null,undefined,false,'abc','1e3','-1','Infinity']) assert.equal(C.money(value),null);
  assert.equal(C.money('0'),0); assert.equal(C.money('１，２３４．５０'),1234.5);
});
test('search escapes input and normalizes a full-width part without changing a URL into a part',()=> {
  assert.equal(C.validPart('８５９１５－３００５０'),true);
  const links=C.searchLinks('TOYOTA','８５９１５－３００５０');
  assert.equal(new URL(links.ebay).searchParams.get('_nkw'),'TOYOTA 85915-30050');
  assert.equal(new URL(links.monotaro).hostname,'www.monotaro.com');
  assert.throws(()=>C.searchLinks('TOYOTA','https://evil.test/12345'));
});
test('fractional counts cannot establish verified actual sales',()=> {
  const {row,settings}=fixture();Object.assign(row,{scopeConfirmed:true,soldSource:'https://www.ebay.com/sh/research',soldCheckedAt:'2026-09-21',periodEnd:'2026-09-21',sold90:'0.5'});
  assert.ok(C.calculate(row,settings,'speedpak',undefined,now).warnings.some(x=>x.includes('販売実績')));
  row.sold90='0';assert.ok(!C.calculate(row,settings,'speedpak',undefined,now).warnings.some(x=>x.includes('販売実績')));
});
test('transport quotes need duty and processing; an all-in quote never adds them twice',()=> {
  const {row}=fixture(); const q=row.quotes[0];
  assert.equal(C.quoteCost(q).total,2600);
  q.dutyJpy=''; assert.equal(C.quoteCost(q).total,null);
  Object.assign(q,{mode:'all_in',amountJpy:'2600',dutyJpy:'500',otherJpy:'100'});
  assert.equal(C.quoteCost(q).total,2600);
});
test('supplier choice uses domestic shipping and ignores unavailable or incomplete rows',()=> {
  const {row}=fixture(); Object.assign(row.suppliers[1],{priceJpy:'500',domesticJpy:'1000',availability:'orderable'});
  Object.assign(row.suppliers[2],{priceJpy:'200',domesticJpy:'0',availability:'out_of_stock'});
  assert.equal(C.cheapestSupplier(row).id,'monotaro');
  row.suppliers[0].domesticJpy=''; assert.equal(C.cheapestSupplier(row).id,'rakuten');
});
test('transaction arithmetic includes shipping revenue, fee tax, Payoneer and returns',()=> {
  const {row,settings}=fixture(); const result=C.calculate(row,settings,'speedpak',undefined,now);
  assert.equal(result.gross,16500); assert.equal(result.ebay,2425.5);
  assert.ok(Math.abs(result.payoneer-442.235)<1e-7);
  assert.ok(Math.abs(result.profit-9337.265)<1e-7);
});
test('a cheaper unknown quote is not ranked as zero cost',()=> {
  const {row,settings}=fixture(); row.quotes[1].amountJpy='1'; row.quotes[1].mode='transport';
  const result=C.compare(row,settings,now);
  assert.equal(result[0].id,'speedpak'); assert.equal(result[1].result.profit,null);
});
test('missing supplier domestic shipping blocks profit instead of suggesting a bargain',()=> {
  const {row,settings}=fixture(); row.suppliers[0].domesticJpy='';
  const result=C.calculate(row,settings,'speedpak',undefined,now);
  assert.equal(result.profit,null); assert.ok(result.missing.length);
});
test('quote age, changed selling price and unconfirmed fees remain visible',()=> {
  const {row,settings}=fixture(); row.quotes[0].checkedAt='2026-09-01'; settings.feesConfirmed=false;
  const result=C.calculate(row,settings,'speedpak',110,now);
  assert.ok(result.warnings.some(x=>x.includes('期限')));
  assert.ok(result.warnings.some(x=>x.includes('売価')));
  assert.ok(result.warnings.some(x=>x.includes('手数料')));
});
test('target price is the minimum cent reaching 20 percent of procurement, not a markup',()=> {
  const {row,settings}=fixture(); row.buyerShippingUsd='0';
  for(const key of ['fvfRate','aboveRate','internationalRate','adRate','feeTaxRate','payoneerRate','payoneerFixedJpy','reserveRate','orderFeeUsd','smallOrderFeeUsd']) settings[key]='0';
  const target=C.targetPrice(row,settings,'speedpak',now);
  assert.equal(target.priceUsd,26.67);
  assert.ok(C.calculate(row,settings,'speedpak',26.66,now).profit<200);
});
test('target price stops when variable charges consume all revenue',()=> {
  const {row,settings}=fixture(); settings.reserveRate='100';
  assert.equal(C.targetPrice(row,settings,'speedpak',now).priceUsd,null);
});
test('backup rejects prototype keys and wrong schema without trusting nested objects',()=> {
  assert.throws(()=>C.validateState(JSON.parse('{"schema":1,"records":[],"__proto__":{"polluted":true}}')));
  assert.throws(()=>C.validateState({schema:99}));
  const state=C.emptyState(); state.draft.notes='<img src=x onerror=alert(1)>';
  assert.equal(C.validateState(JSON.parse(JSON.stringify(state))).draft.notes,state.draft.notes);
});
test('import preserves zero versus missing and never labels observation as actual Sold90',()=> {
  const rows=C.importProducts({products:[{part_number:'85915-30050',brand:'Toyota',sold_90d_est:12,price_median_usd:50},{part_number:'28300-54110',brand:'Toyota',sold_90d_est:0}]});
  assert.equal(rows[0].sold90,''); assert.equal(rows[0].observed90,'12');
  assert.equal(rows[1].observed90,'0'); assert.equal(rows[1].saleUsd,'');
  assert.throws(()=>C.importProducts({demo_data:true,products:[]}));
});
test('CSV exports escape spreadsheet formulas and retain Unicode and embedded quotes',()=> {
  const {row}=fixture(); row.notes='=HYPERLINK("bad")';
  const csv=C.exportCsv([row],C.defaultSettings(),now);
  assert.ok(csv.includes("'=HYPERLINK")); assert.ok(csv.includes('85915-30050'));
});
