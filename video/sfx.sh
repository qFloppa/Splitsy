#!/usr/bin/env bash
# The Promo's sound design, synthesised rather than sampled.
#
# Why: every cue has to land on an exact frame of a cut that is locked to a
# 120bpm grid (see Promo.tsx). One file per cue, placed at its frame by Sfx.tsx,
# is more precise than one pre-mixed track — and a waveform built here carries
# no licence, which a sample pack would.
#
#   bash video/sfx.sh          # rewrites public/sfx/*.wav
#
# Retune a single cue by editing its line and rerunning; nothing else depends on
# the file's internals, only on its duration and its peak being sane. Levels are
# deliberately conservative: these stack, and <Audio volume> in Sfx.tsx is the
# per-cue fader, so a hot source here would force everything else down.
set -euo pipefail

OUT=public/sfx
SR=48000
mkdir -p "$OUT"

enc() { ffmpeg -y -v error -ac 1 -ar $SR -c:a pcm_s16le "$@"; }

# ── cold open ────────────────────────────────────────────────────────────────

# Riser under the logo. Instantaneous pitch is the derivative of the phase
# expression: 140 Hz climbing to ~1.5 kHz across the 1.1s, which is the "swell"
# half of a logo reveal. Pink noise on top gives it air.
ffmpeg -y -v error \
  -f lavfi -i "aevalsrc=0.32*sin(2*PI*(140*t+700*t*t)):d=1.1:s=$SR" \
  -f lavfi -i "anoisesrc=d=1.1:c=pink:a=0.5:s=$SR" \
  -filter_complex "[1]highpass=f=600,lowpass=f=7000,aformat=cl=mono[n]; \
                   [0][n]amix=inputs=2:normalize=0:duration=longest, \
                   afade=t=in:d=0.35,afade=t=out:st=0.88:d=0.22, \
                   volume=0.85[out]" \
  -map "[out]" "$OUT/swell.wav"

# The logo's landing. A sine dropping 85 → 49 Hz (f = dφ/dt) reads as weight; the
# 60ms white burst on the front is the transient that makes it read as a hit
# rather than as a hum fading in.
ffmpeg -y -v error \
  -f lavfi -i "aevalsrc=0.95*sin(2*PI*(85*t-20*t*t)):d=0.9:s=$SR" \
  -f lavfi -i "anoisesrc=d=0.06:c=white:a=0.7:s=$SR" \
  -filter_complex "[0]volume=exp(-4*t):eval=frame[a]; \
                   [1]lowpass=f=5000,aformat=cl=mono[b]; \
                   [a][b]amix=inputs=2:normalize=0:duration=longest,volume=0.9[out]" \
  -map "[out]" "$OUT/impact.wav"

# Sparkle. Three stacked harmonics with one fast decay — the "glass" accent used
# on the logo and again on the stamp.
ffmpeg -y -v error \
  -f lavfi -i "aevalsrc=0.20*sin(2*PI*1760*t)+0.16*sin(2*PI*2640*t)+0.10*sin(2*PI*3520*t):d=0.8:s=$SR" \
  -filter_complex "volume=exp(-7*t):eval=frame,highpass=f=900,volume=0.8[out]" \
  -map "[out]" "$OUT/shimmer.wav"

# ── transitions ──────────────────────────────────────────────────────────────

# Dive-through / wipe accent. Pink noise through a fixed bandpass with a
# sin(πt) envelope already reads as a whoosh; the swept sine under it supplies
# the sense of direction. Playback rate is varied per use in Sfx.tsx rather than
# baking four variants.
ffmpeg -y -v error \
  -f lavfi -i "anoisesrc=d=1.0:c=pink:a=0.6:s=$SR" \
  -f lavfi -i "aevalsrc=0.25*sin(2*PI*(260*t+520*t*t)):d=1.0:s=$SR" \
  -filter_complex "[0]bandpass=f=1400:width_type=q:w=1.2,aformat=cl=mono[n]; \
                   [n]volume=sin(PI*t):eval=frame[nv]; \
                   [1]volume=exp(-1.5*t)*sin(PI*t):eval=frame[sv]; \
                   [nv][sv]amix=inputs=2:normalize=0:duration=longest,lowpass=f=9000,volume=0.7[out]" \
  -map "[out]" "$OUT/whoosh.wav"

# The per-namespace mask wipe. Shorter and drier than whoosh so four in a row
# stay a rhythm and do not smear into one long noise.
ffmpeg -y -v error \
  -f lavfi -i "anoisesrc=d=0.42:c=white:a=0.55:s=$SR" \
  -filter_complex "bandpass=f=2200:width_type=q:w=1.0,aformat=cl=mono, \
                   volume=sin(PI*t/0.42):eval=frame,volume=0.55[out]" \
  -map "[out]" "$OUT/swish.wav"

# ── keystrokes ───────────────────────────────────────────────────────────────

# A keystroke. 40ms, no tonal content to speak of — it has to survive being
# placed thirty times without turning into a melody.
ffmpeg -y -v error \
  -f lavfi -i "aevalsrc=0.5*sin(2*PI*2600*t):d=0.04:s=$SR" \
  -filter_complex "volume=exp(-90*t):eval=frame,highpass=f=1200,volume=0.45[out]" \
  -map "[out]" "$OUT/tick.wav"

# ── the composer ─────────────────────────────────────────────────────────────

# The verb toggle. Two clicks 70ms apart with the second one higher, over a
# short rising blip: the same gesture as a switch being thrown, which is what
# tapping the verb is.
ffmpeg -y -v error \
  -f lavfi -i "aevalsrc=0.45*sin(2*PI*1700*t):d=0.05:s=$SR" \
  -f lavfi -i "aevalsrc=0.45*sin(2*PI*2400*t):d=0.08:s=$SR" \
  -f lavfi -i "aevalsrc=0.22*sin(2*PI*(900*t+1400*t*t)):d=0.45:s=$SR" \
  -filter_complex "[0]volume=exp(-80*t):eval=frame,adelay=0|0[a]; \
                   [1]volume=exp(-60*t):eval=frame,adelay=70|70[b]; \
                   [2]volume=exp(-11*t):eval=frame,adelay=70|70[c]; \
                   [a][b][c]amix=inputs=3:normalize=0:duration=longest,volume=0.8[out]" \
  -map "[out]" "$OUT/toggle.wav"

# Settle press. Click plus a 200 → 68 Hz drop: the low body is what makes it a
# press rather than a second toggle.
ffmpeg -y -v error \
  -f lavfi -i "aevalsrc=0.8*sin(2*PI*(200*t-120*t*t)):d=0.55:s=$SR" \
  -f lavfi -i "anoisesrc=d=0.03:c=white:a=0.6:s=$SR" \
  -filter_complex "[0]volume=exp(-6*t):eval=frame[a]; \
                   [1]lowpass=f=6000,aformat=cl=mono[b]; \
                   [a][b]amix=inputs=2:normalize=0:duration=longest,volume=0.85[out]" \
  -map "[out]" "$OUT/press.wav"

# The blocks leaving the button. 500 → 2.7 kHz in under half a second, decayed
# hard, with a noise tail so it has a body to travel on.
ffmpeg -y -v error \
  -f lavfi -i "aevalsrc=0.40*sin(2*PI*(500*t+2200*t*t)):d=0.5:s=$SR" \
  -f lavfi -i "anoisesrc=d=0.5:c=pink:a=0.35:s=$SR" \
  -filter_complex "[0]volume=exp(-6*t):eval=frame[a]; \
                   [1]bandpass=f=3000:width_type=q:w=1.0,aformat=cl=mono, \
                   volume=exp(-9*t):eval=frame[b]; \
                   [a][b]amix=inputs=2:normalize=0:duration=longest,volume=0.55[out]" \
  -map "[out]" "$OUT/zip.wav"

# ── confirmation ─────────────────────────────────────────────────────────────

# The stamp. Thump for the landing, then an 880/1320/1760 chime on a long decay
# — a confirmation, not a fanfare, because this is a payment and not a win.
ffmpeg -y -v error \
  -f lavfi -i "aevalsrc=0.85*sin(2*PI*(110*t-40*t*t)):d=0.45:s=$SR" \
  -f lavfi -i "aevalsrc=0.26*sin(2*PI*880*t)+0.18*sin(2*PI*1320*t)+0.11*sin(2*PI*1760*t):d=1.5:s=$SR" \
  -f lavfi -i "anoisesrc=d=0.05:c=white:a=0.5:s=$SR" \
  -filter_complex "[0]volume=exp(-7*t):eval=frame[a]; \
                   [1]volume=exp(-2.2*t):eval=frame,highpass=f=700[b]; \
                   [2]lowpass=f=7000,aformat=cl=mono[c]; \
                   [a][b][c]amix=inputs=3:normalize=0:duration=longest,volume=0.75[out]" \
  -map "[out]" "$OUT/stamp.wav"

# ── endcard ──────────────────────────────────────────────────────────────────

# Warm cadence under the logo: an A-major-ish stack (A/C#/E + octave) swelling
# for a beat and a half, with a soft low body under it. It resolves rather than
# stops.
ffmpeg -y -v error \
  -f lavfi -i "aevalsrc=0.16*sin(2*PI*220*t)+0.13*sin(2*PI*277.18*t)+0.13*sin(2*PI*329.63*t)+0.07*sin(2*PI*440*t):d=1.9:s=$SR" \
  -f lavfi -i "aevalsrc=0.5*sin(2*PI*(70*t-14*t*t)):d=0.5:s=$SR" \
  -filter_complex "[0]volume=0.9,afade=t=in:d=0.18,afade=t=out:st=1.15:d=0.75[a]; \
                   [1]volume=exp(-5*t):eval=frame[b]; \
                   [a][b]amix=inputs=2:normalize=0:duration=longest,volume=0.7[out]" \
  -map "[out]" "$OUT/resolve.wav"

echo "wrote $(ls -1 "$OUT"/*.wav | wc -l) cues to $OUT/"