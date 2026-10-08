const {test,expect,chromium,webkit,devices}=require('@playwright/test');
const {setNickname}=require('./profile-actions.cjs');
const {randomUUID}=require('node:crypto');
const WebSocket=require('ws');
const ORIGIN='http://127.0.0.1:8787';
const room=()=>randomUUID().replaceAll('-','');
async function socket(id, credential='b'.repeat(64), origin=ORIGIN) {
 const ws=new WebSocket(`${ORIGIN.replace('http','ws')}/api/rooms/${id}/ws`,{headers:{Origin:origin}});
 const messages=[];ws.on('message',data=>{ const text=data.toString();if(text==='~pong')messages.push(text);else messages.push(JSON.parse(text)); });
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
 ws.send(JSON.stringify({type:'hello',protocol:'ping-ws-v1',credential,visible:true}));
 await expect.poll(()=>messages.some(m=>m.type==='welcome')).toBe(true);
 return {ws,messages,command(type,payload={},id=randomUUID()){ws.send(JSON.stringify({...payload,type,id}));return id;}};
}
for(const [label,engine,device] of [['Chromium',chromium,'Pixel 7'],['WebKit',webkit,'iPhone 13']]) {
 test(`${label}: names, independent opt-in state, peer renewal, tab title, history, reconnection and isolated rooms`,async({},info)=>{
  const browser=await engine.launch();const errors=[];
  try{
   const ca=await browser.newContext({...devices[device],colorScheme:'light'}),cb=await browser.newContext({...devices[device],colorScheme:'light'});
   const a=await ca.newPage(),b=await cb.newPage(),id=room();
   for(const p of [a,b])p.on('pageerror',e=>errors.push(String(e)));
   await Promise.all([a.goto(`${ORIGIN}/r/${id}`),b.goto(`${ORIGIN}/r/${id}`)]);
   for(const p of [a,b]){
    await expect(p.locator('.user')).toHaveCount(2);
    await expect(p.locator('#availability-control')).toBeHidden();
    await expect(p.locator('#signal')).toBeDisabled();
   }
   await setNickname(a,'니트로');await setNickname(b,'구름');
   await expect(a.locator('.user[data-self="false"] .user-name')).toHaveText('구름');
   await expect(a.locator('#self-profile')).toHaveCount(0);
   await expect(a.locator('#availability-state')).toHaveText('불가능');
   await a.locator('#availability').click();
   await expect(b.locator('.user[data-self="false"]')).toHaveAttribute('data-available','true');
   await a.locator('#signal').click();
   await expect(b.locator('#ping-clock')).toHaveAttribute('data-active','true');
   const before=Number(await b.locator('#ping-time').getAttribute('data-created-at'));
   await b.waitForTimeout(1100);await b.locator('#signal').click();
   await expect.poll(async()=>Number(await a.locator('#ping-time').getAttribute('data-created-at'))).toBeGreaterThan(before);
   await expect(a).toHaveTitle(/^(05:00|04:\d\d) · ping · 2\/2명$/);
   await expect(b.locator('#availability-state')).toHaveText('불가능');
   await a.locator('#history > summary').click();
   await expect(a.locator('.history-entry[data-kind="ping"]')).toHaveCount(2);
   await a.locator('.user[data-self="true"] .user-profile').click();
   await expect(a.locator('#nickname')).toBeFocused();
   await a.locator('#nickname').fill('수정 중');
   await b.waitForTimeout(1100);await b.locator('#signal').click();
   await expect(a.locator('#nickname')).toHaveValue('수정 중');
   await a.locator('#nickname-cancel').click();
   await setNickname(a,'니트로 개발');
   await expect(b.locator('.user[data-self="false"] .user-name')).toHaveText('니트로 개발');
   await a.reload();await expect(a.locator('#nickname-form')).toBeHidden();
   await expect(a.locator('#availability-state')).toHaveText('가능');
   await a.locator('#history > summary').click();
   await expect(a.locator('.history-entry[data-kind="ping"]')).toHaveCount(3);
   const sibling=await ca.newPage();await sibling.goto(`${ORIGIN}/r/${id}`);
   await expect(sibling.locator('.user')).toHaveCount(2);await sibling.close();
   const other=await ca.newPage();await other.goto(`${ORIGIN}/r/${room()}`);await expect(other.locator('.user')).toHaveCount(1);await other.close();
   // Idle transport heartbeat is auto-responded; this is not a measurement of production billing.
   await a.waitForTimeout(16000);await b.locator('#signal').click();
   await expect(a.locator('.history-entry[data-kind="ping"]')).toHaveCount(4);
   const requests=[];a.on('request',r=>requests.push(new URL(r.url()).pathname));
   await a.waitForTimeout(16000);expect(requests.filter(p=>p.startsWith('/api/'))).toEqual([]);
   await a.screenshot({path:info.outputPath('cloudflare-history.png'),fullPage:true});
   await a.emulateMedia({colorScheme:'dark',reducedMotion:'reduce'});
   await a.screenshot({path:info.outputPath('cloudflare-dark.png'),fullPage:true});
   const manifest=await (await a.request.get(`${ORIGIN}/api/manifest/${id}`)).json();expect(manifest.start_url).toBe(`/r/${id}`);
   expect(errors).toEqual([]);
  }finally{await browser.close();}
 });
}
test('raw native WebSocket: automatic pong, immutable retry, rejected impersonation and cross-origin upgrade',async()=>{
 const id=room(),peer=await socket(id);
 try{
  const who=peer.messages.find(m=>m.type==='welcome').clientId;
  const name=peer.command('nickname',{nickname:'실제 사용자'});
  await expect.poll(()=>peer.messages.some(m=>m.type==='ack'&&m.id===name)).toBe(true);
  peer.ws.send('~ping');await expect.poll(()=>peer.messages.includes('~pong')).toBe(true);
  const req=peer.command('signal',{clientId:'someone-else'});
  await expect.poll(()=>peer.messages.some(m=>m.type==='ack'&&m.id===req)).toBe(true);
  const first=peer.messages.find(m=>m.type==='ack'&&m.id===req).signal;expect(first.clientId).toBe(who);
  peer.command('signal',{clientId:'someone-else'},req);
  await expect.poll(()=>peer.messages.filter(m=>m.type==='ack'&&m.id===req).length).toBe(2);
  const both=peer.messages.filter(m=>m.type==='ack'&&m.id===req);expect(both[1].signal).toEqual(first);
  expect((await fetch(`${ORIGIN}/api/rooms/${id}/state`)).status).toBe(404);
  const denied=new WebSocket(`${ORIGIN.replace('http','ws')}/api/rooms/${id}/ws`,{headers:{Origin:'https://untrusted.example'}});
  denied.on('error',()=>{});
  const status=await new Promise(resolve=>denied.on('unexpected-response',(_,r)=>{resolve(r.statusCode);r.resume();denied.terminate();}));
  expect(status).toBe(403);
 }finally{peer.ws.close();}
});
test('silent clients expire after 45 seconds; other connections and the last ping survive',async()=>{
 const browser=await chromium.launch();let ghost;
 try{
  const page=await browser.newPage(),id=room();await page.goto(`${ORIGIN}/r/${id}`);await setNickname(page,'관찰자');
  ghost=await socket(id,'c'.repeat(64));ghost.command('nickname',{nickname:'응답 중단'});
  await expect(page.locator('.user')).toHaveCount(2);ghost.command('signal');
  await expect(page.locator('#ping-clock')).toHaveAttribute('data-active','true');
  await expect(page.locator('.user')).toHaveCount(1,{timeout:55000});
  await expect(page.locator('#ping-clock')).toHaveAttribute('data-active','true');
  expect(ghost.ws.readyState).not.toBe(WebSocket.OPEN);
 }finally{ghost?.ws.close();await browser.close();}
});
test('optional APIs and local storage failure never prevent WebSocket signaling',async()=>{
 const browser=await webkit.launch();
 try{
  const context=await browser.newContext({...devices['iPhone 13']});
  await context.addInitScript(()=>{
   Reflect.deleteProperty(globalThis,'Notification');Reflect.deleteProperty(globalThis,'PushManager');
   Object.defineProperty(globalThis,'localStorage',{configurable:true,get(){throw new Error('blocked');}});
   globalThis.AudioContext=function(){throw new Error('blocked');};globalThis.webkitAudioContext=globalThis.AudioContext;
  });
  const page=await context.newPage();await page.goto(`${ORIGIN}/r/${room()}`);await setNickname(page,'임시');
  await page.locator('#signal').click();await expect(page.locator('#ping-clock')).toHaveAttribute('data-active','true');
  await page.locator('#history > summary').click();await expect(page.locator('#history-note')).toContainText('로컬 저장 불가');
 }finally{await browser.close();}
});
for (const [label, engine] of [['Chromium', chromium], ['WebKit', webkit]]) {
 test(`${label}: native soft audio plays once, hidden peer pings update the tab without audio, and reconnect restores missed events`, async () => {
  const browser=await engine.launch();let peer;
  try {
   const context=await browser.newContext();
   await context.addInitScript(()=>{
    window.__audioStarts=0;
    const Native=window.AudioContext||window.webkitAudioContext;
    if(Native) window.AudioContext=class extends Native {
     createBufferSource(){const source=super.createBufferSource(),start=source.start.bind(source);
      source.start=(...args)=>{window.__audioStarts++;return start(...args);};return source;}
    };
   });
   const page=await context.newPage(),id=room();await page.goto(`${ORIGIN}/r/${id}`);await setNickname(page,'소리 수신자');
   await page.locator('#signal').click();await expect.poll(()=>page.evaluate(()=>window.__audioStarts)).toBe(1);
   await page.waitForTimeout(200);expect(await page.evaluate(()=>window.__audioStarts)).toBe(1);
   const peak=await page.evaluate(async()=>{
    const {renderPingSamples}=await import('/ping-sound.js');
    const Offline=window.OfflineAudioContext||window.webkitOfflineAudioContext;
    const data=renderPingSamples(48000),context=new Offline(1,data.length,48000),buffer=context.createBuffer(1,data.length,48000);
    buffer.getChannelData(0).set(data);const source=context.createBufferSource();source.buffer=buffer;source.connect(context.destination);source.start();
    const rendered=await context.startRendering();return Math.max(...rendered.getChannelData(0));
   });
   expect(peak).toBeGreaterThan(.19);expect(peak).toBeLessThan(.201);
   await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'hidden'});document.dispatchEvent(new Event('visibilitychange'));});
   peer=await socket(id,'d'.repeat(64));const name=peer.command('nickname',{nickname:'배경 발신자'});
   await expect.poll(()=>peer.messages.some(m=>m.type==='ack'&&m.id===name)).toBe(true);
   const signal=peer.command('signal');await expect.poll(()=>peer.messages.some(m=>m.type==='ack'&&m.id===signal)).toBe(true);
   await expect(page.locator('body')).toHaveAttribute('data-tab-unread','true');
   await expect(page).toHaveTitle(/^(05:00|04:\d\d) · (PING!|새 핑) · 2\/2명$/);
   expect(await page.evaluate(()=>window.__audioStarts)).toBe(1);
   await context.setOffline(true);await expect(page.locator('body')).toHaveAttribute('data-ready','false');
   await page.waitForTimeout(1100);const missed=peer.command('signal');
   await expect.poll(()=>peer.messages.some(m=>m.type==='ack'&&m.id===missed)).toBe(true);
   const eventId=peer.messages.find(m=>m.type==='ack'&&m.id===missed).signal.eventId;
   await context.setOffline(false);await expect(page.locator('body')).toHaveAttribute('data-ready','true');
   await expect(page.locator('#ping-clock')).toHaveAttribute('data-event-id',eventId);
   await page.evaluate(()=>{Object.defineProperty(document,'visibilityState',{configurable:true,get:()=> 'visible'});document.dispatchEvent(new Event('visibilitychange'));});
   await page.locator('#history > summary').click();await expect(page.locator('.history-entry[data-kind="ping"]')).toHaveCount(3);
  }finally{peer?.ws.close();await browser.close();}
 });
}
