# Soft ping chime

The in-page sound is a short, rounded two-note mallet (C5/E5), not a louder alarm. The quieter second note follows after 180 ms; the whole sound ends after 1.05 seconds. A smooth 12 ms onset, quickly fading overtones and a tapered ending avoid an abrupt click or shrill sustained tone. Mono output keeps both notes intact on a phone speaker. The synthesized buffer peaks at 0.20, leaving digital headroom; physical loudness still depends on the device volume and speaker.

One cached PCM buffer is reused with new one-shot Web Audio sources. Arrivals within 350 ms share an audible cue only: every actual ping still updates the timer, history and UI. A later sound fades the previous voice over 25 ms rather than stacking voices. A hidden/stopped page cancels its tail. No external sound files, analytics, permissions or dependencies are added.

Audio is unlocked only by an existing user gesture, never by receiving a message. Failed or suspended audio does not queue a later surprise sound and never blocks signaling. Existing event-ID deduplication, visible-page policy, availability, VAPID and OS Web Push behavior are unchanged. This changes the in-page tone, not the operating system notification sound.

Unit tests verify deterministic waveform bounds and its envelope. Chromium and WebKit tests use native playback and OfflineAudioContext, alongside shared-KV signaling. These verify software output, not a physical-speaker listening assessment. The browser regression selectors now target the single self member card removed from the duplicate top profile in the prior change.
