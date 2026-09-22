const {test,expect}=require('@playwright/test');
const fs=require('node:fs/promises');
const http=require('node:http');
const path=require('node:path');
const KEY='part-scout-research-v1';
const field=(page,name)=>page.locator(`[data-field="${name}"]`);

test.beforeEach(async({page})=>{
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('/research.html');
  await expect(page.locator('#save-state')).toContainText('自動保存');
  page.__errors=errors;
});
test.afterEach(async({page})=>{expect(page.__errors).toEqual([]);});

async function fillCase(page){
  for(const [name,value] of Object.entries({part:'８５９１５－３００５０',title:'メインリレー（動作確認用）',saleUsd:'100',bestUsd:'110',worstUsd:'90',buyerShippingUsd:'10',packagingJpy:'100','suppliers.0.priceJpy':'1000','suppliers.0.domesticJpy':'100','quotes.0.amountJpy':'2600','quotes.1.amountJpy':'2200'}))await field(page,name).fill(value);
  await field(page,'suppliers.0.availability').selectOption('orderable');
  await page.getByRole('button',{name:'設定・保存',exact:true}).click();
  for(const [name,value] of Object.entries({fx:'150',buyerTaxRate:'0',payoneerRate:'3',fvfRate:'10',internationalRate:'1',adRate:'2',payoneerFixedJpy:'20'}))await field(page,'settings.'+name).fill(value);
  await page.getByRole('button',{name:'調べる',exact:true}).click();
}

test('all views fit 320–1280px and the mobile results stay visible',async({page},info)=>{
  for(const width of [320,390,768,1280]){
    await page.setViewportSize({width,height:844});
    for(const name of ['調べる','調査リスト','設定・保存']){
      await page.getByRole('button',{name,exact:true}).click();
      const sizes=await page.evaluate(()=>({viewport:innerWidth,document:document.documentElement.scrollWidth}));
      expect(sizes.document,`${name} at ${width}px`).toBeLessThanOrEqual(sizes.viewport+1);
    }
  }
  await page.setViewportSize({width:390,height:844});
  await page.getByRole('button',{name:'調べる',exact:true}).click();
  await expect(page.getByRole('heading',{name:'配送別の参考利益'})).toBeVisible();
  await expect(page.locator('#profit-base')).toHaveCount(1);
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:info.outputPath('iphone-initial.png')});
});

test('real inputs calculate profit, compare shipping, save and survive reload',async({page},info)=>{
  await fillCase(page);await expect(page.locator('#profit-base')).toContainText('9,337');
  await expect(page.locator('#comparison')).toContainText('9,737');
  const href=await page.getByRole('link',{name:'出品中 ↗',exact:true}).getAttribute('href');
  expect(new URL(href).searchParams.get('_nkw')).toBe('TOYOTA 85915-30050');
  await page.locator('input[name="shipping"][value="ems"]').check();await expect(page.locator('#profit-base')).toContainText('9,737');
  await page.getByRole('button',{name:'調査リストに保存',exact:true}).click();await expect(page.locator('#toast')).toContainText('保存しました');
  await page.reload();await expect(field(page,'part')).toHaveValue('85915-30050');await expect(page.locator('#profit-base')).toContainText('9,737');
  await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:info.outputPath('iphone-calculation.png')});
  await page.getByRole('button',{name:'調査リスト',exact:true}).click();await expect(page.locator('#record-count')).toHaveText('1件');
});

test('transport fees must be complete and all-in quotes do not double-count',async({page})=>{
  await fillCase(page);await field(page,'quotes.0.mode').selectOption('transport');await expect(page.locator('#profit-base')).toHaveText('—');
  await field(page,'quotes.0.dutyJpy').fill('500');await field(page,'quotes.0.otherJpy').fill('100');await expect(page.locator('#profit-base')).toContainText('8,737');
  await field(page,'quotes.0.mode').selectOption('all_in');await expect(page.locator('#profit-base')).toContainText('9,337');
  await field(page,'suppliers.0.domesticJpy').fill('');await expect(page.locator('#profit-base')).toHaveText('—');
});

test('JSON download and restore retain records, current draft and settings',async({page})=>{
  await fillCase(page);await page.getByRole('button',{name:'調査リストに保存',exact:true}).click();
  await page.getByRole('button',{name:'設定・保存',exact:true}).click();
  const pending=page.waitForEvent('download');await page.getByRole('button',{name:'JSONバックアップ',exact:true}).click();const download=await pending;
  const path=await download.path(),backup=JSON.parse(await fs.readFile(path,'utf8'));
  expect(backup.data.records).toHaveLength(1);expect(backup.data.settings.fx).toBe('150');
  await page.getByRole('button',{name:'調べる',exact:true}).click();await field(page,'title').fill('変更後');
  await page.getByRole('button',{name:'設定・保存',exact:true}).click();page.once('dialog',dialog=>dialog.accept());await page.locator('#restore-file').setInputFiles(path);
  await expect(page.locator('#toast')).toHaveText('復元しました');await page.getByRole('button',{name:'調べる',exact:true}).click();
  await expect(field(page,'title')).toHaveValue('メインリレー（動作確認用）');await expect(page.locator('#profit-base')).toContainText('9,337');
});

async function temporaryOrigin(){
  const root=path.resolve(__dirname,'../../web');
  const types={'.html':'text/html; charset=utf-8','.js':'application/javascript','.css':'text/css','.json':'application/json','.webmanifest':'application/manifest+json','.png':'image/png'};
  const server=http.createServer(async(req,res)=>{
    const pathname=decodeURIComponent(new URL(req.url,'http://localhost').pathname);
    const file=path.resolve(root,'.'+(pathname==='/'?'/index.html':pathname));
    if(!file.startsWith(root+path.sep)){res.writeHead(403);res.end();return;}
    try{const bytes=await fs.readFile(file);res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store'});res.end(bytes);}
    catch{res.writeHead(404);res.end();}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {url:`http://127.0.0.1:${server.address().port}`,stop:()=>new Promise((resolve,reject)=>{
    if(!server.listening){resolve();return;}server.close(e=>e?reject(e):resolve());server.closeAllConnections();
  })};
}

test('an installed worker reopens the draft with the origin stopped',async({page,context,browserName},info)=>{
  const origin=await temporaryOrigin();
  try{
    await page.goto(origin.url+'/research.html');await fillCase(page);
    await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
    await expect.poll(()=>page.evaluate(()=>Boolean(navigator.serviceWorker.controller))).toBe(true);
    expect(await page.evaluate(async()=>Boolean(await caches.match('./research.html')))).toBe(true);
    await origin.stop();
    await expect(fetch(origin.url+'/research.html')).rejects.toThrow();
    // WebKit's offline emulator blocks even literal SW responses (Playwright #42775).
    // A stopped origin tests real server loss without misreporting it as airplane mode.
    if(browserName==='chromium')await context.setOffline(true);
    info.annotations.push({type:'outage',description:browserName==='webkit'?'Origin stopped; no HTTP cache. Offline emulation is affected by microsoft/playwright#42775.':'Origin stopped and context offline.'});
    const response=await page.reload();expect(response.fromServiceWorker()).toBe(true);
    await expect(field(page,'part')).toHaveValue('８５９１５－３００５０');await expect(page.locator('#profit-base')).toContainText('9,337');
    await field(page,'notes').fill('オフラインでも継続');await page.reload();await expect(field(page,'notes')).toHaveValue('オフラインでも継続');
  }finally{await context.setOffline(false);await origin.stop();}
});

test('another tab cannot erase saved edits, and a corrupt backup cannot overwrite them',async({page,context})=>{
  await field(page,'part').fill('85915-30050');
  const other=await context.newPage();await other.goto('/research.html');await field(other,'notes').fill('先に保存した別タブ');
  await field(page,'notes').fill('競合するこのタブ');await expect(page.locator('#save-state')).toContainText('競合');
  expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).draft.notes,KEY)).toBe('先に保存した別タブ');
  await page.getByRole('button',{name:'設定・保存',exact:true}).click();
  await page.locator('#restore-file').setInputFiles({name:'invalid.json',mimeType:'application/json',buffer:Buffer.from('{"schema":99}')});
  await expect(page.locator('#toast')).toContainText('バックアップ形式');
  expect(await page.evaluate(key=>JSON.parse(localStorage.getItem(key)).draft.notes,KEY)).toBe('先に保存した別タブ');
  await other.close();
});
