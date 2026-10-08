import { test } from "node:test";
import assert from "node:assert/strict";
import { PingSound, PING_SOUND_PEAK, PING_SOUND_SECONDS, renderPingSamples } from "../public/ping-sound.js";

const rms = (data: Float32Array) => Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
test("soft chime is finite, deterministic and has ample peak headroom at common sample rates", () => {
  for (const rate of [8000, 44100, 48000, 96000]) {
    const samples = renderPingSamples(rate);
    assert.equal(samples.length, Math.ceil(rate * PING_SOUND_SECONDS));
    assert.equal(samples[0], 0);
    assert.equal(Math.abs(samples.at(-1)!), 0);
    let peak = 0;
    for (const sample of samples) { assert.ok(Number.isFinite(sample)); peak = Math.max(peak, Math.abs(sample)); }
    assert.ok(Math.abs(peak - PING_SOUND_PEAK) < 0.000001);
    assert.ok(rms(samples) > 0.03 && rms(samples) < 0.06);
    assert.deepEqual(samples, renderPingSamples(rate));
  }
});
test("rounded onset and quiet tail surround two distinct soft strikes", () => {
  const rate = 48000, samples = renderPingSamples(rate);
  const part = (start: number, end: number) => samples.slice(Math.floor(start * rate), Math.floor(end * rate));
  const first = rms(part(0.02, 0.09)), second = rms(part(0.20, 0.27));
  assert.ok(rms(part(0, 0.001)) < first * 0.02);
  assert.ok(second > rms(part(0.14, 0.17)) * 1.3);
  assert.ok(second < first * 1.2);
  assert.ok(rms(part(0.96, 1.05)) < first * 0.03);
  let step = 0;
  for (let i = 1; i < samples.length; i++) step = Math.max(step, Math.abs(samples[i] - samples[i - 1]));
  assert.ok(step < 0.03);
});
test("invalid sample rates are rejected without allocating an unbounded buffer", () => {
  for (const rate of [0, -1, NaN, Infinity, 48000.5, 7999, 192001]) {
    assert.throws(() => renderPingSamples(rate), RangeError);
  }
});
test("missing or throwing audio never plays and never throws into application flow", () => {
  for (const create of [() => null, () => { throw new Error("blocked"); }]) {
    const sound = new PingSound(create);
    assert.equal(sound.play(), false);
    assert.equal(sound.unlock(), false);
    assert.equal(sound.play(), false);
    assert.doesNotThrow(() => sound.stop());
  }
});
