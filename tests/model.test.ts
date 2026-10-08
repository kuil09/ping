import { test } from "node:test";
import assert from "node:assert/strict";
import { execute, freshRoom, identity, leaseDeadline, roster, snapshot, SIGNAL_TTL_MS, PRESENCE_TTL_MS, MAX_EVENTS } from "../src/model.ts";
const start = 1000000;
const named = () => {
  const room = freshRoom("release-a", start);
  roster(room, ["alpha", "bravo"], start);
  execute(room, "alpha", {type: "nickname", id: "nickname_a", nickname: "니트로"}, start);
  execute(room, "bravo", {type: "nickname", id: "nickname_b", nickname: "구름"}, start);
  return room;
};
test("nickname precedes opt-in availability and ping; commands cannot impersonate another member", () => {
  const room = freshRoom("release-a", start); roster(room, ["alpha"], start);
  assert.equal(room.profiles.alpha.available, false);
  assert.throws(() => execute(room, "alpha", {type:"signal", id:"signal_01"}, start), /nickname_required/);
  assert.throws(() => execute(room, "alpha", {type:"availability", id:"avail_001", available:true}, start), /nickname_required/);
  execute(room, "alpha", {type:"nickname", id:"nickname_a", nickname:" 니트로 "}, start);
  assert.equal(room.profiles.alpha.available, false);
  execute(room, "alpha", {type:"availability", id:"avail_002", available:true}, start);
  assert.equal(room.profiles.alpha.available, true);
  assert.throws(() => execute(room, "bravo", {type:"nickname", id:"nickname_x", nickname:"침입"}, start), /not_connected/);
});
test("every new peer ping renews the shared five-minute deadline, never availability", () => {
  const room = named();
  const first = execute(room,"alpha",{type:"signal",id:"signal_a1"},start).signal!;
  const next = execute(room,"bravo",{type:"signal",id:"signal_b1"},start+10000).signal!;
  assert.equal(next.pingUntil, start+10000+SIGNAL_TTL_MS);
  assert.equal(room.profiles.alpha.pingUntil, first.pingUntil);
  assert.equal(room.profiles.alpha.available, false);
  assert.equal(room.profiles.bravo.available, false);
});
test("lost acknowledgments are idempotent; conflicting reuse and too-fast new requests fail", () => {
  const room = named(); const cmd = {type:"signal" as const,id:"signal_a1"};
  const first = execute(room,"alpha",cmd,start);
  assert.deepEqual(execute(room,"alpha",cmd,start+999), {...first, duplicate:true});
  assert.equal(room.sequence,1);
  assert.throws(()=>execute(room,"alpha",{type:"nickname",id:cmd.id,nickname:"다른값"},start+1000),/request_conflict/);
  assert.throws(()=>execute(room,"alpha",{type:"signal",id:"signal_a2"},start+999),/too_fast/);
});
test("tabs count once; a departing sender does not delete a live channel ping", () => {
  const room=named();execute(room,"alpha",{type:"signal",id:"signal_a1"},start);
  roster(room,["alpha","alpha","bravo"],start+1); assert.equal(snapshot(room,start).users.length,2);
  roster(room,["bravo"],start+2);assert.equal(snapshot(room,start+2).users.length,1);
  assert.equal(room.channelPing!.nickname,"니트로");assert.equal(room.channelPing!.pingUntil,start+SIGNAL_TTL_MS);
  roster(room,["alpha","bravo"],start+3);assert.equal(room.profiles.alpha.nickname,"니트로");
});
test("auto-response timestamp extends a 45-second lease without modifying persisted state", () => {
  assert.equal(leaseDeadline(start,undefined),start+PRESENCE_TTL_MS);
  assert.equal(leaseDeadline(start,start+15000),start+60000);
  assert.equal(leaseDeadline(start+20000,start+15000),start+65000);
});
test("hibernation serialization restores state; only a new release starts empty", () => {
  const room=named();execute(room,"alpha",{type:"signal",id:"signal_a1"},start);
  const restored=JSON.parse(JSON.stringify(room));assert.deepEqual(snapshot(restored,start),snapshot(room,start));
  const replacement=freshRoom("release-b",start+1);assert.deepEqual(replacement.online,[]);assert.equal(replacement.channelPing,null);
  assert.notEqual(replacement.epoch,room.epoch);
});
test("server-time history remains named at emission; retained records and receipts are bounded", () => {
  const room=named();execute(room,"alpha",{type:"signal",id:"signal_00"},start);
  execute(room,"alpha",{type:"nickname",id:"nickname_c",nickname:"바뀐이름"},start+1);
  assert.equal(room.events[0].nickname,"니트로");
  for(let i=1;i<550;i++) execute(room,"alpha",{type:"signal",id:`signal_${String(i).padStart(4,"0")}`},start+i*1001);
  assert.equal(room.events.length,MAX_EVENTS);assert.equal(Object.keys(room.receipts).length,512);
});
test("identity is a one-way hash of a private browser credential, not a nickname or client-supplied ID", async () => {
  const key="a".repeat(64);assert.equal(await identity(key),await identity(key));assert.notEqual(await identity(key),key);
  await assert.rejects(identity("short"), /invalid_identity/);
});
test("invalid nickname and availability leave the model unchanged",()=>{
  const room=named();const before=JSON.stringify(room);
  assert.throws(()=>execute(room,"alpha",{type:"nickname",id:"nickname_z",nickname:"가".repeat(21)},start),/nickname_too_long/);
  assert.throws(()=>execute(room,"alpha",{type:"availability",id:"avail_001",available:"false"},start),/invalid_availability/);
  assert.equal(JSON.stringify(room),before);
});
