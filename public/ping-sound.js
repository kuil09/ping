export const PING_SOUND_VERSION = "soft-chime-v1";
export const PING_SOUND_SECONDS = 1.05;
export const PING_SOUND_PEAK = 0.20;
const MIN_GAP = 0.35;
const RELEASE = 0.025;

/** Rounded C5/E5 mallet: no noise, sweep, hard edge, or piercing upper partials. */
export function renderPingSamples(sampleRate = 48000) {
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000) {
    throw new RangeError("unsupported_sample_rate");
  }
  const samples = new Float32Array(Math.ceil(sampleRate * PING_SOUND_SECONDS));
  const notes = [[0, 523.251, 1], [0.18, 659.255, 0.86]];
  for (const [offset, frequency, level] of notes) {
    for (let i = Math.ceil(offset * sampleRate); i < samples.length; i++) {
      const t = i / sampleRate - offset;
      const attack = 0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, t / 0.012));
      const phase = 2 * Math.PI * frequency * t;
      const body = (0.55 * Math.exp(-t / 0.10) + 0.45 * Math.exp(-t / 0.26)) * Math.sin(phase);
      const warmth = 0.16 * Math.exp(-t / 0.09) * Math.sin(2 * phase);
      const texture = 0.035 * Math.exp(-t / 0.04) * Math.sin(3 * phase);
      samples[i] += level * attack * (body + warmth + texture);
    }
  }
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    // Smoothly finish at zero; never cut the residual waveform mid-cycle.
    const end = Math.min(1, (samples.length - 1 - i) / (sampleRate * 0.09));
    samples[i] *= 0.5 - 0.5 * Math.cos(Math.PI * end);
    peak = Math.max(peak, Math.abs(samples[i]));
  }
  if (peak) for (let i = 0; i < samples.length; i++) samples[i] *= PING_SOUND_PEAK / peak;
  return samples;
}

/** Optional audio. No permission prompts, queued autoplay, external files or network. */
export class PingSound {
  constructor(makeContext = () => {
    const Audio = globalThis.AudioContext || globalThis.webkitAudioContext;
    return Audio ? new Audio() : null;
  }) {
    this.makeContext = makeContext;
    this.context = null;
    this.buffer = null;
    this.voice = null;
    this.lastStarted = -Infinity;
    this.resuming = false;
  }
  // Call only from an existing user gesture. Creating/unlocking does not play a note.
  unlock() {
    try {
      if (!this.context || this.context.state === "closed") {
        this.context = this.makeContext();
        this.buffer = null;
        this.voice = null;
        this.lastStarted = -Infinity;
      }
      const context = this.context;
      if (!context) return false;
      if (context.state !== "running" && !this.resuming) {
        this.resuming = true;
        Promise.resolve(context.resume()).catch(() => {}).finally(() => { this.resuming = false; });
      }
      return true;
    } catch { this.resuming = false; return false; }
  }
  play() {
    let source;
    let gain;
    try {
      const context = this.context;
      if (context?.state !== "running") return false;
      const time = context.currentTime;
      // Coalesce only sound in a burst. All visual/network/history events still apply.
      if (time - this.lastStarted < MIN_GAP) return false;
      if (!this.buffer) {
        const data = renderPingSamples(context.sampleRate);
        this.buffer = context.createBuffer(1, data.length, context.sampleRate);
        this.buffer.getChannelData(0).set(data);
      }
      this.stop();
      source = context.createBufferSource();
      gain = context.createGain();
      gain.gain.setValueAtTime(1, time);
      source.buffer = this.buffer;
      source.connect(gain);
      gain.connect(context.destination);
      const voice = { source, gain };
      source.onended = () => {
        try { source.disconnect(); gain.disconnect(); } catch { /* already disconnected */ }
        if (this.voice === voice) this.voice = null;
      };
      source.start(time);
      this.voice = voice;
      this.lastStarted = time;
      return true;
    } catch {
      try { source?.stop(); } catch { /* source not started */ }
      try { source?.disconnect(); gain?.disconnect(); } catch { /* optional cleanup */ }
      return false;
    }
  }
  stop() {
    const voice = this.voice;
    this.voice = null;
    if (!voice) return;
    try {
      const time = this.context.currentTime;
      voice.gain.gain.cancelScheduledValues(time);
      voice.gain.gain.setValueAtTime(1, time);
      voice.gain.gain.linearRampToValueAtTime(0, time + RELEASE);
      voice.source.stop(time + RELEASE);
    } catch {
      try { voice.source.stop(); voice.source.disconnect(); voice.gain.disconnect(); } catch { /* optional */ }
    }
  }
}
