import {Miniflare,convertV4MiniflareOptions}from'miniflare';
import {mkdtemp,rm}from'node:fs/promises';
import {tmpdir}from'node:os';
import {join,resolve}from'node:path';
import {createECDH,randomBytes,randomUUID}from'node:crypto';
import webpush from'web-push';
import assert from'node:assert/strict';
const path=await mkdtemp(join(tmpdir(),'ping-room-runtime-'));
const keys=webpush.generateVAPIDKeys(),client=createECDH('prime256v1');client.generateKeys();
const subscription={endpoint:'https://web.push.apple.com/runtime-fixture-only',keys:{p256dh:client.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
const room=randomUUID().replaceAll('-',''),credential=randomBytes(32).toString('hex');
function runtime(version){return new Miniflare({ ...convertV4MiniflareOptions({cf:false,name:'room-test',modules:true,
 scriptPath:resolve('dist-room-test/room-runtime-worker.js'),compatibilityDate:'2026-10-08',compatibilityFlags:['nodejs_compat'],
 durableObjects:{ROOMS:{className:'PingRoom',useSQLite:true}},
 bindings:{CF_VERSION_METADATA:{id:version},VAPID_PUBLIC_KEY:keys.publicKey,VAPID_PRIVATE_KEY:keys.privateKey,VAPID_SUBJECT:'mailto:test@example.com'}}), resourcePersistencePath:path });}
async function session(mf){
 const response=await mf.dispatchFetch(`https://test.local/api/rooms/${room}/ws`,{headers:{Upgrade:'websocket',Origin:'https://test.local'}});
 assert.equal(response.status,101);const ws=response.webSocket,queue=[];ws.accept();
 ws.addEventListener('message',e=>queue.push(JSON.parse(e.data)));
 async function wait(test){for(let i=0;i<100;i++){const found=queue.find(test);if(found)return found;await new Promise(r=>setTimeout(r,10));}throw new Error('runtime_message_timeout');}
 ws.send(JSON.stringify({type:'hello',protocol:'ping-ws-v1',credential,visible:true}));
 const welcome=await wait(m=>m.type==='welcome');
 return {ws,welcome,async action(type,payload={}){const id=randomUUID();ws.send(JSON.stringify({...payload,type,id}));const reply=await wait(m=>m.id===id);assert.equal(reply.type,'ack');return reply;}};
}
let mf;
try{
 mf=runtime('release-a');let peer=await session(mf);
 await peer.action('nickname',{nickname:'복원 검증'});await peer.action('availability',{available:true});
 const ping=(await peer.action('signal')).signal;await peer.action('subscribe',{subscription});
 let inspection=await (await mf.dispatchFetch(`https://test.local/inspect?room=${room}`)).json();assert.equal(inspection.subscriptions,1);
 peer.ws.close();await mf.dispose();mf=runtime('release-a');peer=await session(mf);
 assert.equal(peer.welcome.state.users[0].nickname,'복원 검증');assert.equal(peer.welcome.state.users[0].available,true);
 assert.deepEqual(peer.welcome.state.channelPing,ping);
 inspection=await (await mf.dispatchFetch(`https://test.local/inspect?room=${room}`)).json();assert.equal(inspection.subscriptions,1);
 peer.ws.close();await mf.dispose();mf=runtime('release-b');peer=await session(mf);
 assert.equal(peer.welcome.state.users[0].nickname,'');assert.equal(peer.welcome.state.users[0].available,false);
 assert.equal(peer.welcome.state.channelPing,null);assert.equal(peer.welcome.state.events.length,0);
 inspection=await (await mf.dispatchFetch(`https://test.local/inspect?room=${room}`)).json();assert.equal(inspection.subscriptions,0);
 assert.equal(Object.keys(inspection.state.receipts).length,0);
 peer.ws.close();console.log('Native SQLite runtime: same-version restart preserves profile/ping/subscription; new version resets all room data.');
}finally{if(mf)await mf.dispose();await rm(path,{recursive:true,force:true});}
