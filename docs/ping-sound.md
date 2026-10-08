# Soft ping chime

The in-page tone is a rounded C5/E5 mallet pair. The quieter second note follows after 180ms; the buffer ends after 1.05 seconds. Peak PCM amplitude is 0.20. A smooth onset and tapered tail avoid clicks; physical loudness depends on the device.

A cached mono PCM buffer is reused. Audio within 350ms is coalesced only for sound: all actual events update the timer/history. A new sound fades the prior voice over 25ms. Audio is unlocked through a user gesture, not an incoming event. Hidden pages do not play the in-page tone; OS Web Push is separate. Audio failure never prevents signaling.

Pure waveform tests verify determinism, bounds, onset and decay. Browser rendering is not a physical-speaker or iPhone silent-mode test.
