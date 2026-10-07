const { test, expect, chromium, webkit, devices } = require("@playwright/test");
const { setNickname } = require("./profile-actions.cjs");
const crypto = require("node:crypto");
const A = process.env.PING_TEST_ORIGIN || "http://127.0.0.1:9101";
const B = process.env.PING_TEST_ORIGIN || "http://127.0.0.1:9102";

for (const [label, engine, device] of [["Chromium", chromium, "Pixel 7"], ["WebKit", webkit, "iPhone 13"]]) {
  test(`${label}: native audio renders a soft chime and confirmed pings play once without changing availability`, async ({}, info) => {
    const browser = await engine.launch();
    const errors = [];
    try {
      const context = await browser.newContext({ ...devices[device] });
      await context.addInitScript(() => {
        window.__chimes = [];
        const original = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function (...args) {
          const result = original.apply(this, args);
          if (this.buffer && Math.abs(this.buffer.duration - 1.05) < 0.001) {
            let peak = 0;
            for (const value of this.buffer.getChannelData(0)) peak = Math.max(peak, Math.abs(value));
            window.__chimes.push({ duration: this.buffer.duration, peak, channels: this.buffer.numberOfChannels });
          }
          return result;
        };
      });
      const page = await context.newPage(), room = "sound_" + crypto.randomUUID().replaceAll("-", "");
      page.on("pageerror", e => errors.push(String(e)));
      await page.goto(`${A}/r/${room}`);
      await expect(page.locator("body")).toHaveAttribute("data-sound-ui", "soft-chime-v1");
      await setNickname(page, "음색 확인");
      expect(await page.evaluate(() => window.__chimes.length)).toBe(0);
      await page.locator("#signal").click();
      await expect.poll(() => page.evaluate(() => window.__chimes.length)).toBe(1);
      await expect(page.locator("#availability-state")).toHaveText("불가능");
      await page.waitForTimeout(1200);
      expect(await page.evaluate(() => window.__chimes.length)).toBe(1);
      const peer = { clientId: crypto.randomUUID(), sessionId: crypto.randomUUID() };
      const response = await fetch(`${B}/api/rooms/${room}/signal`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...peer, requestId: crypto.randomUUID() }),
      });
      expect(response.ok).toBe(true);
      const signal = (await response.json()).signal;
      await expect.poll(() => page.evaluate(() => window.__chimes.length)).toBe(2);
      await expect(page.locator("#ping-clock")).toHaveAttribute("data-event-id", signal.eventId);
      await page.locator("#history > summary").click();
      await expect(page.locator('.history-entry[data-kind="ping"]')).toHaveCount(2);
      const heard = await page.evaluate(() => window.__chimes);
      for (const chime of heard) { expect(chime.peak).toBeLessThan(0.201); expect(chime.peak).toBeGreaterThan(0.19); expect(chime.channels).toBe(1); }
      // OfflineAudioContext exercises the browser audio engine, not a substitute oscillator.
      const rendered = await page.evaluate(async () => {
        const { renderPingSamples } = await import("/ping-sound.js");
        const rate = 48000, data = renderPingSamples(rate);
        const offline = new OfflineAudioContext(1, data.length + 4800, rate);
        const buffer = offline.createBuffer(1, data.length, rate);
        buffer.getChannelData(0).set(data);
        const source = offline.createBufferSource(); source.buffer = buffer; source.connect(offline.destination); source.start();
        const output = (await offline.startRendering()).getChannelData(0);
        let peak = 0, energy = 0;
        for (const sample of output) { peak = Math.max(peak, Math.abs(sample)); energy += sample * sample; }
        return { peak, rms: Math.sqrt(energy / data.length), last: output[output.length - 1] };
      });
      expect(rendered.peak).toBeLessThan(0.201); expect(rendered.rms).toBeGreaterThan(0.03); expect(rendered.rms).toBeLessThan(0.06); expect(Math.abs(rendered.last)).toBe(0);
      expect(errors).toEqual([]);
      await info.attach("audio-evidence", { body: JSON.stringify({ engine: label, heard, rendered, errors, physicalSpeakerListening: false }), contentType: "application/json" });
    } finally { await browser.close(); }
  });
}

test("audio bursts reuse the buffer, fade previous voices, and never queue rejected autoplay", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage(); await page.goto(`${A}/r/sound_module_${crypto.randomUUID().replaceAll("-", "")}`);
    const result = await page.evaluate(async () => {
      const { PingSound } = await import("/ping-sound.js");
      let buffers = 0, starts = 0, stops = 0, disconnected = 0;
      const ramps = [], sources = [];
      const context = {
        state: "running", currentTime: 0, sampleRate: 48000, destination: {},
        createBuffer(channels, length) { buffers++; const data = new Float32Array(length); return { getChannelData: () => data }; },
        createGain() { return { connect() {}, disconnect() { disconnected++; }, gain: { setValueAtTime() {}, cancelScheduledValues() {}, linearRampToValueAtTime(value, time) { ramps.push({ value, time }); } } }; },
        createBufferSource() { const source = { connect() {}, disconnect() { disconnected++; }, start() { starts++; }, stop() { stops++; } }; sources.push(source); return source; },
      };
      const sound = new PingSound(() => context);
      const before = sound.play(); sound.unlock(); const first = sound.play();
      context.currentTime = 0.1; const burst = sound.play();
      context.currentTime = 0.4; const renewed = sound.play();
      sources[0].onended(); const currentRetained = sound.voice?.source === sources[1];
      sound.stop(); sources[1].onended();
      let resumes = 0;
      const locked = new PingSound(() => ({ state: "suspended", currentTime: 0, resume() { resumes++; return Promise.reject(new Error("blocked")); } }));
      locked.unlock(); await Promise.resolve(); await Promise.resolve();
      return { before, first, burst, renewed, buffers, starts, stops, disconnected, ramps, currentRetained, lockedPlay: locked.play(), resumes };
    });
    expect(result.before).toBe(false); expect(result.first).toBe(true); expect(result.burst).toBe(false); expect(result.renewed).toBe(true);
    expect(result.buffers).toBe(1); expect(result.starts).toBe(2); expect(result.stops).toBe(2); expect(result.disconnected).toBe(4);
    expect(result.currentRetained).toBe(true); expect(result.lockedPlay).toBe(false); expect(result.resumes).toBe(1);
    expect(result.ramps).toHaveLength(2); for (const ramp of result.ramps) { expect(ramp.value).toBe(0); expect(ramp.time).toBeCloseTo(0.425); }
  } finally { await browser.close(); }
});
