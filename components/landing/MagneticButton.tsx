"use client";

import { useRef, type ReactNode, type PointerEvent } from "react";
import { motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";

// Magnetic wrapper: the child leans a few pixels toward the cursor while it's
// inside, and springs back on leave. Pull is capped small (10px) so it reads
// as weight, not a gimmick. Transform-only; honors reduced motion.
export function MagneticButton({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const springX = useSpring(x, { stiffness: 260, damping: 18, mass: 0.6 });
  const springY = useSpring(y, { stiffness: 260, damping: 18, mass: 0.6 });

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (reduced || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const dx = event.clientX - (rect.left + rect.width / 2);
    const dy = event.clientY - (rect.top + rect.height / 2);
    x.set((dx / rect.width) * 20);
    y.set((dy / rect.height) * 16);
  }

  function onPointerLeave() {
    x.set(0);
    y.set(0);
  }

  return (
    <motion.div
      className="inline-block"
      onPointerLeave={onPointerLeave}
      onPointerMove={onPointerMove}
      ref={ref}
      style={reduced ? undefined : { x: springX, y: springY }}
      whileTap={reduced ? undefined : { scale: 0.965 }}
    >
      {children}
    </motion.div>
  );
}
