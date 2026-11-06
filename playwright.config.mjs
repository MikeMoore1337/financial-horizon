import {defineConfig} from '@playwright/test';
const python=process.env.FH_E2E_PYTHON||(process.platform==='win32'?'py -3':'python3');
export default defineConfig({
 testDir:'./tests/e2e',testMatch:'**/*.spec.mjs',
 timeout:60_000,expect:{timeout:10_000},fullyParallel:false,
 forbidOnly:Boolean(process.env.CI),retries:process.env.CI?1:0,workers:1,
 reporter:process.env.CI?[['list'],['junit',{outputFile:'test-results/e2e-junit.xml'}]]:'list',
 outputDir:'test-results/e2e',
 use:{baseURL:'http://127.0.0.1:8791',browserName:'chromium',serviceWorkers:'allow',
   trace:'retain-on-failure',screenshot:'only-on-failure',video:'off',viewport:{width:1280,height:800}},
 webServer:{command:python+' -u tests/e2e/server.py',url:'http://127.0.0.1:8791/__e2e__/ready',
  reuseExistingServer:false,timeout:45_000,stdout:'ignore',stderr:'pipe'},
});
