import assert from "node:assert/strict";
import test from "node:test";

import {
  CUES,
  FPS,
  PHASES,
  RAIL_LEGS,
  TOTAL_FRAMES,
  easeInOut,
  easeOut,
  mix,
  phaseAt,
  progress,
  range,
} from "./timeline.mjs";

test("the cut is exactly 15 seconds at 60fps", () => {
  assert.equal(FPS, 60);
  assert.equal(TOTAL_FRAMES, 900);
  assert.equal(TOTAL_FRAMES / FPS, 15);
});

test("the phases tile the whole timeline with no gap and no overlap", () => {
  assert.equal(PHASES[0].start, 0);
  assert.equal(PHASES.at(-1).end, TOTAL_FRAMES);
  for (const [i, phase] of PHASES.entries()) {
    assert.ok(phase.end > phase.start, `${phase.name} is empty`);
    if (i > 0) assert.equal(phase.start, PHASES[i - 1].end, `${phase.name} does not butt against ${PHASES[i - 1].name}`);
  }
});

test("phaseAt covers every frame exactly once, and nothing past the end", () => {
  for (let f = 0; f < TOTAL_FRAMES; f++) assert.ok(phaseAt(f), `no phase at frame ${f}`);
  assert.equal(phaseAt(TOTAL_FRAMES - 1).name, PHASES.at(-1).name);
  assert.equal(phaseAt(-1), null);
  assert.equal(phaseAt(TOTAL_FRAMES), null);
});

test("a phase's first frame is progress 0 and its last is fractionally under 1", () => {
  for (const phase of PHASES) {
    assert.equal(progress(phase.start, phase), 0);
    assert.ok(progress(phase.end - 1, phase) < 1);
    assert.equal(progress(phase.end, phase), 1);
  }
});

test("the rail shows the money going both ways, not just out", () => {
  const legs = RAIL_LEGS.map((leg) => leg.direction);
  assert.ok(legs.includes("send"), "the rail never sends");
  assert.ok(legs.includes("request"), "the rail never requests");
  assert.deepEqual(legs, ["send", "request"]);
  for (const [i, leg] of RAIL_LEGS.entries()) {
    if (i > 0) assert.equal(leg.start, RAIL_LEGS[i - 1].end, "rail legs must be contiguous");
  }
});

test("every sound cue lands inside the cut, in order", () => {
  assert.ok(CUES.length > 0);
  for (const [i, cue] of CUES.entries()) {
    assert.ok(cue.frame >= 0 && cue.frame < TOTAL_FRAMES, `${cue.src} at ${cue.frame} is off the timeline`);
    if (i > 0) assert.ok(cue.frame >= CUES[i - 1].frame, `${cue.src} is out of order`);
  }
});

test("the easing helpers are pinned at both ends and never run backwards", () => {
  for (const ease of [easeOut, easeInOut]) {
    assert.equal(ease(0), 0);
    assert.equal(ease(1), 1);
    let last = -1;
    for (let t = 0; t <= 1; t += 0.01) {
      const v = ease(t);
      assert.ok(v >= last, `easing went backwards at ${t}`);
      assert.ok(v >= 0 && v <= 1, `easing left 0..1 at ${t}`);
      last = v;
    }
  }
});

test("range clamps outside its window and is the fraction inside it", () => {
  assert.equal(range(10, 20, 40), 0);
  assert.equal(range(20, 20, 40), 0);
  assert.equal(range(30, 20, 40), 0.5);
  assert.equal(range(40, 20, 40), 1);
  assert.equal(range(99, 20, 40), 1);
});

test("mix interpolates and does not overshoot", () => {
  assert.equal(mix(0, 10, 0), 0);
  assert.equal(mix(0, 10, 1), 10);
  assert.equal(mix(0, 10, 0.25), 2.5);
  assert.equal(mix(-5, 5, 0.5), 0);
});