import { test } from "node:test";
import assert from "node:assert/strict";
import { ALERT_ICONS, countdown, TabStatus } from "../public/tab-status.js";

const start = 1_000_000;
const ping = { eventId: "epoch:1", clientId: "peer", createdAt: start, pingUntil: start + 300_000 };

test("countdown rounds up, pads digits, and clamps at zero", () => {
  assert.equal(countdown(ping.pingUntil, start), "05:00");
  assert.equal(countdown(ping.pingUntil, start + 1001), "04:59");
  assert.equal(countdown(ping.pingUntil, ping.pingUntil - 1), "00:01");
  assert.equal(countdown(ping.pingUntil, ping.pingUntil), "00:00");
  assert.equal(countdown(ping.pingUntil, ping.pingUntil + 9999), "00:00");
  assert.equal(countdown(NaN, start), "00:00");
});
test("idle tab has a stable normal title and icon", () => {
  const tab = new TabStatus().view(null, start, 3, 0, true);
  assert.equal(tab.title, "ping · 3명");
  assert.equal(tab.icon, "/icon.svg");
  assert.equal(tab.countdown, null);
});
test("active tab places countdown before participant counts", () => {
  const tab = new TabStatus().view(ping, start + 2000, 3, 2, true);
  assert.equal(tab.title, "04:58 · ping · 2/3명");
  assert.equal(tab.icon, "/icon-active.svg");
});
test("unseen peer ping alternates title and high contrast favicon", () => {
  const status = new TabStatus();
  status.notice(ping, "self", false, start);
  const first = status.view(ping, start, 2, 1, false);
  const second = status.view(ping, start + 1500, 2, 1, false);
  assert.equal(first.title, "05:00 · PING! · 1/2명");
  assert.equal(second.title, "04:59 · 새 핑 · 1/2명");
  assert.equal(first.icon, ALERT_ICONS[0]);
  assert.equal(second.icon, ALERT_ICONS[1]);
  assert.equal(first.unread, true);
});
test("attention pulse is bounded; unread marker remains until focus or expiry", () => {
  const status = new TabStatus();
  status.notice(ping, "self", false, start);
  const tab = status.view(ping, start + 14000, 2, 1, false);
  assert.equal(tab.pulsing, false);
  assert.equal(tab.unread, true);
  assert.equal(tab.title, "04:46 · PING! · 1/2명");
});
test("focus acknowledges attention without clearing countdown", () => {
  const status = new TabStatus();
  status.notice(ping, "self", false, start);
  const tab = status.view(ping, start + 3000, 2, 1, true);
  assert.equal(tab.unread, false);
  assert.equal(tab.title, "04:57 · ping · 1/2명");
  status.notice(ping, "self", false, start + 4000);
  assert.equal(status.view(ping, start + 4000, 2, 1, false).unread, false);
});
test("self pings and already visible peer pings never demand attention", () => {
  const status = new TabStatus();
  status.notice(ping, "peer", false, start);
  assert.equal(status.view(ping, start, 2, 1, false).unread, false);
  status.reset();
  status.notice(ping, "self", true, start);
  assert.equal(status.view(ping, start, 2, 1, false).unread, false);
});
test("new peer ping renews countdown; duplicate retry does not restart the pulse", () => {
  const status = new TabStatus();
  status.notice(ping, "self", false, start);
  status.notice(ping, "self", false, start + 13000);
  assert.equal(status.view(ping, start + 13000, 2, 1, false).pulsing, false);
  const next = { ...ping, eventId: "epoch:2", createdAt: start + 50000, pingUntil: start + 350000 };
  status.notice(next, "self", false, start + 50000);
  const tab = status.view(next, start + 50000, 2, 2, false);
  assert.equal(tab.countdown, "05:00");
  assert.equal(tab.pulsing, true);
});
test("timer suspension skips directly to correct remaining time and expiry", () => {
  const status = new TabStatus();
  status.notice(ping, "self", false, start);
  status.view(ping, start, 2, 1, false);
  assert.equal(status.view(ping, start + 125000, 2, 1, false).countdown, "02:55");
  const expired = status.view(ping, start + 301000, 2, 0, false);
  assert.equal(expired.title, "ping · 2명");
  assert.equal(expired.icon, "/icon.svg");
  assert.equal(expired.unread, false);
});
test("reduced motion uses a steady alert icon and keeps ticking", () => {
  const status = new TabStatus();
  status.notice(ping, "self", false, start);
  const a = status.view(ping, start, 2, 1, false, true);
  const b = status.view(ping, start + 1500, 2, 1, false, true);
  assert.equal(a.icon, b.icon);
  assert.equal(b.pulsing, false);
  assert.equal(b.title, "04:59 · PING! · 1/2명");
});
test("deployment reset removes previous unread attention", () => {
  const status = new TabStatus();
  status.notice(ping, "self", false, start);
  status.reset();
  assert.equal(status.view(null, start, 0, 0, false).unread, false);
});
