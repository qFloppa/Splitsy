/**
 * The cut's picture, as page-side code.
 *
 * This file runs in the headless browser, so it is read as text by render.mjs
 * and inlined into the page rather than imported. Everything it draws is a pure
 * function of the frame number: there are no CSS animations, transitions or
 * timers anywhere, so frame 731 looks the same on every render and a re-encode
 * can never drift from the last one.
 *
 * The timing comes from window.__TIMELINE__, which render.mjs builds from
 * timeline.mjs. Shot boundaries are never written twice.
 */
(() => {
  const T = window.__TIMELINE__;
  const PHASE = Object.fromEntries(T.PHASES.map((phase) => [phase.name, phase]));
  const LEG = Object.fromEntries(T.RAIL_LEGS.map((leg) => [leg.direction, leg]));

  const $ = (id) => document.getElementById(id);
  const nodes = [...document.querySelectorAll(".node")];
  const ghosts = [...document.querySelectorAll(".ghost")];
  const wires = [...document.querySelectorAll(".wire-line")];
  const words = [...document.querySelectorAll(".word")];

  /** 0 → 1 inside an absolute frame window, clamped. */
  const at = (frame, from, to) => Math.max(0, Math.min(1, (frame - from) / (to - from)));
  /** 0 → 1 across a phase. */
  const through = (frame, phase) =>
    Math.max(0, Math.min(1, (frame - phase.start) / (phase.end - phase.start)));

  const out = (t) => 1 - Math.pow(1 - t, 3);
  const inOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  /** Overshoots past 1 and settles — the pop that makes a snap read as a snap. */
  const back = (t) => {
    const c = 1.9;
    const p = t - 1;
    return 1 + (c + 1) * p * p * p + c * p * p;
  };
  const mix = (a, b, t) => a + (b - a) * t;

  /** Where each namespace sits on the right half. Staggered so they read in order. */
  const SLOTS = {
    x: [1420, 372],
    discord: [1740, 372],
    email: [1420, 760],
    wallet: [1740, 760],
  };

  /**
   * The rail the money rides. `left` is the chip's own left edge inside the
   * 1680px rail, so the chip at 1.0 has cleared the counter rather than
   * squashing word-space against it.
   */
  const RAIL_W = 1680;
  const CHIP_W = 132;
  const TRAVEL = RAIL_W - CHIP_W;

  /** The whole piece carries one slow camera push, so no two frames are identical. */
  const camera = (frame) => 1 + at(frame, 0, T.TOTAL_FRAMES) * 0.026;

  window.renderFrame = (frame) => {
    const hook = through(frame, PHASE.hook);
    const anywhere = through(frame, PHASE.anywhere);
    const send = through(frame, PHASE.send);
    const request = through(frame, PHASE.request);
    const end = through(frame, PHASE.endcard);

    const timecode = (frame / T.FPS).toFixed(2).padStart(5, "0");
    $("readout").textContent = `00:${timecode}`;
    $("meter").style.transform = `scaleX(${at(frame, 6, 118)})`;

    // ── the ground: a slowly breathing floor and a dark vignette that the
    //    money's glow sits inside of.
    const push = camera(frame);
    $("stage").style.transform = `scale(${push})`;
    $("floor").style.transform = `perspective(1100px) rotateX(64deg) translateY(${
      300 + Math.sin(frame / 80) * 16
    }px) translateX(${Math.sin(frame / 150) * 40}px) scale(1.9)`;
    $("sweep").style.transform = `translateX(${mix(-700, 2600, at(frame, 30, 150))}px)`;
    $("sweep").style.opacity = `${Math.sin(at(frame, 30, 150) * Math.PI) * 0.5}`;

    // ── 01 · hook. The headline is the only thing moving; it scales down and
    //    settles as the eyebrow slides up under it. Words are staggered so the
    //    line assembles left to right instead of arriving as a block.
    words.forEach((word, i) => {
      const t = out(at(frame, 8 + i * 7, 44 + i * 7));
      word.style.transform = `translateY(${(1 - t) * 105}%) rotate(${(1 - t) * 3}deg)`;
      word.style.opacity = `${t}`;
    });
    $("eyebrow").style.transform = `translateY(${(1 - out(at(frame, 2, 30))) * 26}px)`;
    $("eyebrow").style.opacity = `${out(at(frame, 2, 30))}`;
    $("sub").style.opacity = `${out(at(frame, 46, 84)) * (1 - anywhere)}`;
    $("sub").style.transform = `translateY(${(1 - out(at(frame, 46, 84))) * 20}px)`;

    // The copy leaves the moment the namespaces need the frame — a 40px lift and
    // a fade, both quick, so the namespaces arrive into an already-cleared stage.
    const leaving = inOut(anywhere);
    $("copy").style.transform = `translate3d(${-leaving * 120}px, ${-leaving * 40}px, 0)`;
    $("copy").style.opacity = `${1 - leaving * 1.15}`;
    $("copy").style.filter = `blur(${leaving * 7}px)`;

    // ── 02 · anywhere. Four namespaces land on a back-out so each snaps into
    //    place; their rings counter-scale, which is what sells the impact as
    //    an arrival rather than a fade-in.
    const arriving = at(frame, PHASE.anywhere.start, PHASE.anywhere.start + 96);
    const departing = at(frame, 282, 322);
    nodes.forEach((node, i) => {
      const [slotX, slotY] = SLOTS[node.dataset.key];
      const t = back(at(frame, 140 + i * 22, 196 + i * 22));
      const floatX = Math.sin(frame / 26 + i * 1.7) * 11;
      const floatY = Math.cos(frame / 33 + i * 1.3) * 8;
      node.style.left = `${slotX + floatX}px`;
      node.style.top = `${slotY + floatY + (1 - t) * 60}px`;
      node.style.transform = `translate(-50%, -50%) scale(${clampScale(t)})`;
      node.style.opacity = `${arriving * (1 - departing)}`;
      const ring = node.querySelector(".ring");
      ring.style.transform = `scale(${1 + at(frame, 150 + i * 22, 214 + i * 22) * 0.22})`;
      ring.style.opacity = `${(1 - at(frame, 150 + i * 22, 214 + i * 22)) * 0.55}`;
    });
    $("orbit").style.transform = `rotate(${frame * 0.05}deg) scale(${1 + Math.sin(frame / 95) * 0.03})`;
    $("orbit").style.opacity = `${arriving * (1 - departing) * 0.85}`;
    document.querySelector(".orbit2").style.transform = `rotate(${-frame * 0.08}deg)`;
    $("wire").style.opacity = `${arriving * (1 - departing) * 0.6}`;
    // The dash crawl lives on the paths; setting it on the <svg> element does
    // nothing at all, which is how this read as a dead wire the first time.
    wires.forEach((line) => {
      line.style.strokeDashoffset = `${-frame * 1.8}`;
    });

    // ── 03/04 · the rail, run both ways. One geometry, flipped by `direction`:
    //    that the same rail carries money out and back is the entire claim, so
    //    it is drawn once and reversed rather than authored twice.
    const railLive = 1 - end;
    const reverse = request > 0.15;
    const leg = LEG[reverse ? "request" : "send"];
    const run = at(frame, leg.start + 26, leg.end - 44);
    // The request is the same journey played backwards, so the chip starts at
    // the far end and comes home. Reversing the value rather than the geometry
    // keeps one set of numbers and one arrowhead.
    const eased = out(reverse ? 1 - run : run);

    // Declared before the chip reads it. Order matters here — this is the
    // temporal-dead-zone throw that killed every frame on the first pass.
    const amount = Math.round(mix(0, 42, out(at(frame, leg.start + 32, leg.start + 104))));

    $("railwrap").style.opacity = `${railLive}`;
    $("railwrap").style.transform = `translateY(${(1 - out(at(frame, 318, 352))) * 60 + end * 120}px)`;
    $("verb").textContent = reverse ? "REQUEST" : "SEND";
    $("verb").style.color = reverse ? "#3ee6d6" : "#f7f3ea";
    $("prep").textContent = reverse ? "from anyone" : "to anyone";
    $("railpath").style.transform = `scaleX(${reverse ? -1 : 1}) scaleY(${at(frame, 330, 372)})`;
    $("chip").style.transform = `translateX(${eased * TRAVEL}px)`;
    $("chip").style.opacity = `${Math.sin(run * Math.PI) * 0.9 + 0.1}`;
    // Direction is stated by the arrowhead, not just by the travel. The chip
    // itself must NOT be mirrored — the amount inside it would read backwards —
    // so the class only moves the arrowhead to the leading edge.
    $("chip").classList.toggle("is-reversed", reverse);
    $("chip").querySelector("b").textContent = `$${amount}`;

    // The wake. Each ghost trails the chip by a fixed fraction, so the streak is
    // derived from the chip's own position rather than animated separately and
    // left to drift out of register with it.
    ghosts.forEach((ghost, i) => {
      const lag = out(Math.max(0, Math.min(1, (reverse ? 1 - run : run) - 0.03 * (i + 1))));
      ghost.style.transform = `translateX(${lag * TRAVEL}px)`;
      ghost.style.opacity = `${Math.sin(run * Math.PI) * 0.42 / (i + 1) * railLive}`;
    });

    // The figure counts up as the money crosses, so the number and the movement
    // are the same event.
    $("amount").textContent = `$${amount}`;
    $("amount").style.opacity = `${out(at(frame, leg.start + 8, leg.start + 40)) * railLive}`;
    $("counterlabel").textContent = reverse ? "requested" : "sent";

    // ── the stamp. A settle is a fact landing, so it hits oversized and
    //    snaps down rather than fading in.
    const stamped = at(frame, leg.end - 42, leg.end - 18);
    $("stamp").textContent = reverse ? "requested · arc" : "settled · arc";
    $("stamp").style.opacity = `${stamped * railLive}`;
    $("stamp").style.transform = `rotate(-6deg) scale(${mix(1.9, 1, out(stamped))})`;

    $("caption").textContent = reverse
      ? "Ask for it. They tap once."
      : "Money moves at the speed of a mention.";
    $("caption").style.opacity = `${out(at(frame, leg.start + 60, leg.start + 110)) * railLive}`;
    $("caption").style.transform = `translateY(${(1 - out(at(frame, leg.start + 60, leg.start + 110))) * 26}px)`;

    // ── 05 · endcard. Comes up out of a blur so the cut reads as one continuous
    //    camera move rather than as a slide change.
    const arrive = inOut(end);
    $("endcard").style.opacity = `${arrive}`;
    $("endcard").style.visibility = arrive < 0.01 ? "hidden" : "visible";
    $("endcard").style.transform = `scale(${mix(1.1, 1, arrive)})`;
    $("endcard").style.filter = `blur(${(1 - arrive) * 16}px)`;
    $("endmark").style.transform = `translateY(${(1 - out(at(frame, 694, 728))) * 30}px)`;
    $("endtitle").style.transform = `translateY(${(1 - out(at(frame, 706, 744))) * 34}px)`;
    $("endtitle").style.opacity = `${out(at(frame, 706, 744))}`;
    $("endsub").style.opacity = `${out(at(frame, 734, 770))}`;
    $("endurl").style.opacity = `${out(at(frame, 754, 790))}`;
  };

  /** Keeps the back-out overshoot from flipping a node inside out at t<0. */
  const clampScale = (t) => Math.max(0.4, t);
})();