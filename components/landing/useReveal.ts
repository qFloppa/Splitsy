"use client";

import { useEffect, useRef } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

gsap.registerPlugin(ScrollTrigger);

/**
 * The landing's one entrance. Every section used to hand-roll the same
 * useEffect — a gsap.context, two or three gsap.from()s, a ScrollTrigger start
 * picked by eye — which is how nine sections ended up entering at five
 * different speeds from four different offsets.
 *
 * Three marks, and a section only ever declares which of them a node is:
 *
 *   data-reveal="item"     rises into place.
 *   data-reveal="lead"     prints instead: the node is wiped up out of nothing,
 *                          the gesture the hero's split headline makes, for the
 *                          one or two lines per section that deserve it.
 *   data-rule              a hairline that draws itself left to right. The app's
 *                          own gesture (a lit .bill-cell-rule under a focused
 *                          figure), promoted to a section boundary.
 *   data-count             a figure that counts up to the number already written
 *                          in the markup — so the resting DOM is the true one and
 *                          the animation is the only thing that can be missing.
 *
 * Resting state is always the final state, so under prefers-reduced-motion this
 * hook returns before touching anything and the section is simply there.
 */
export function useReveal<T extends HTMLElement>(start = "top 80%") {
  const ref = useRef<T>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const root = ref.current;
    if (!root) return;

    const ctx = gsap.context(() => {
      const scrollTrigger = { trigger: root, start };
      // Not every section carries every mark — most have no rules and none has a
      // figure to count. GSAP warns on a selector that matches nothing, so ask
      // first: a console full of "target not found" is how a page stops being
      // worth reading the console of.
      const find = (selector: string) => gsap.utils.toArray<HTMLElement>(selector);

      const items = find('[data-reveal="item"]');
      if (items.length) {
        gsap.from(items, {
          y: 22,
          autoAlpha: 0,
          duration: 0.75,
          ease: "expo.out",
          stagger: 0.075,
          scrollTrigger,
        });
      }

      // A wipe, not a fade: the clip travels up from the baseline while the type
      // rises the last few pixels into it, so the line reads as printed rather
      // than as faded in.
      //
      // fromTo, not from: `clip-path: none` is the resting value and none→inset()
      // has nothing to interpolate, so GSAP would snap instead of wipe. The end
      // state is a clip that cuts nothing (negative insets clear ascenders and
      // descenders at any leading), and clearProps drops it once it is done so no
      // paint boundary is left behind on a headline.
      const leads = find('[data-reveal="lead"]');
      if (leads.length) {
        gsap.fromTo(
          leads,
          { clipPath: "inset(0% 0% 103% 0%)", y: 14 },
          {
            clipPath: "inset(-20% 0% -20% 0%)",
            y: 0,
            duration: 1.05,
            ease: "expo.out",
            stagger: 0.09,
            clearProps: "clipPath",
            scrollTrigger,
          },
        );
      }

      const rules = find("[data-rule]");
      if (rules.length) {
        gsap.from(rules, {
          scaleX: 0,
          duration: 0.95,
          ease: "expo.out",
          stagger: 0.08,
          scrollTrigger,
        });
      }

      // The figure is authored at its final value; this reads it back, counts to
      // it, and restores the exact string it started from — so a rounding
      // difference in the tween can never leave a wrong number on screen.
      find("[data-count]").forEach((node) => {
        const final = node.textContent ?? "";
        const match = final.match(/-?[\d.]+/);
        if (!match) return;
        const target = Number(match[0]);
        if (!Number.isFinite(target)) return;
        const decimals = (match[0].split(".")[1] ?? "").length;
        const proxy = { n: 0 };

        gsap.to(proxy, {
          n: target,
          duration: 1.4,
          ease: "power2.out",
          scrollTrigger,
          onUpdate: () => {
            node.textContent = final.replace(match[0], proxy.n.toFixed(decimals));
          },
          onComplete: () => {
            node.textContent = final;
          },
        });
      });
    }, root);

    return () => ctx.revert();
  }, [start]);

  return ref;
}
