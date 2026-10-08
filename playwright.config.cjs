const {defineConfig}=require('@playwright/test');
module.exports=defineConfig({testDir:'./tests',testMatch:'*.spec.cjs',workers:1,retries:0,
 timeout:120000,expect:{timeout:10000},reporter:[['line'],['json',{outputFile:'test-results/report.json'}]],
 outputDir:'test-results',use:{trace:'retain-on-failure'},
 webServer:{command:'npm run dev',url:'http://127.0.0.1:8787/api/health',timeout:60000,reuseExistingServer:!process.env.CI}});
