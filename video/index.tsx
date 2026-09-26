import React from "react";
import { Composition, registerRoot } from "remotion";

import { Promo } from "./Promo";
import "./theme";

/**
 * 1920×1080 at 60fps — landscape for the X timeline, and 60 because the whole
 * piece is typography in motion, where 30 shows its seams on long slides.
 *
 * 1080 frames is 18.0s, which at 120bpm is exactly 36 beats. See Promo.tsx.
 */
const Root: React.FC = () => (
  <Composition
    id="Promo"
    component={Promo}
    durationInFrames={1080}
    fps={60}
    width={1920}
    height={1080}
  />
);

registerRoot(Root);
