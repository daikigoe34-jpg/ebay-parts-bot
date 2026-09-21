const {defineConfig,devices}=require('@playwright/test');

module.exports=defineConfig({
  testDir:'./tests/browser',
  fullyParallel:false,
  workers:1,
  retries:0,
  timeout:30000,
  reporter:[['list'],['html',{open:'never'}]],
  use:{baseURL:'http://127.0.0.1:8766',trace:'retain-on-failure',screenshot:'only-on-failure'},
  projects:[
    {name:'chromium-mobile',use:{...devices['iPhone 13'],browserName:'chromium'}},
    {name:'webkit-iphone',use:{...devices['iPhone 13'],browserName:'webkit'}},
  ],
  webServer:{command:'python3 -m http.server 8766 --bind 127.0.0.1 --directory web',url:'http://127.0.0.1:8766/research.html',reuseExistingServer:false},
});
