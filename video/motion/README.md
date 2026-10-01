# Splitsy Motion Promo

Standalone 15-second motion graphics cut for the core use case: **send or request money from any handle**.

It does not use Remotion. `render.mjs` drives a headless Chrome page frame-by-frame, captures PNGs, then uses ffmpeg to encode and mix the existing synthesized sound cues.

```bash
node video/motion/render.mjs
ffprobe -v error -show_entries format=duration:stream=width,height -of default=noprint_wrappers=1 out/splitsy-any-handle.mp4
```
