// Renders a payer's personalized identity-NFT image: the public/nft.jpg
// template (Splitsy medallion with a clear band across the bottom) with the
// agent's facts stamped into that band. Text is converted to vector paths via
// the bundled font (fontkit) instead of SVG <text>, because serverless hosts
// ship no system fonts and librsvg would render empty boxes.
import { readFileSync } from "node:fs";
import path from "node:path";
import * as fontkit from "fontkit";
import sharp from "sharp";

const SIZE = 1254; // template is 1254×1254; the band below y≈1050 is clear

let cachedFont: fontkit.Font | null = null;
let cachedTemplate: Buffer | null = null;

function loadFont(): fontkit.Font {
  cachedFont ??= fontkit.create(
    readFileSync(path.join(process.cwd(), "public", "fonts", "JetBrainsMono-Medium.ttf")),
  ) as fontkit.Font;
  return cachedFont;
}

function loadTemplate(): Buffer {
  cachedTemplate ??= readFileSync(path.join(process.cwd(), "public", "nft.jpg"));
  return cachedTemplate;
}

// One horizontally centered line of text as a filled SVG path element.
// Glyph outlines are in font units with a y-up axis, so each glyph is scaled
// to fontSize and flipped into SVG's y-down space at the baseline.
// letterSpacing is in em, like CSS.
function line(
  font: fontkit.Font,
  text: string,
  baselineY: number,
  fontSize: number,
  fill: string,
  letterSpacing = 0,
): string {
  const scale = fontSize / font.unitsPerEm;
  const spacing = letterSpacing * fontSize;
  const run = font.layout(text);
  const width = run.glyphs.reduce((w, g) => w + g.advanceWidth * scale + spacing, -spacing);
  let x = (SIZE - width) / 2;
  let d = "";
  for (const glyph of run.glyphs) {
    const transformed = glyph.path.scale(scale, -scale).translate(x, baselineY);
    d += transformed.toSVG();
    x += glyph.advanceWidth * scale + spacing;
  }
  return `<path d="${d}" fill="${fill}"/>`;
}

export type AgentImageInput = {
  walletAddress: string;
  registeredAt: Date;
};

export async function composeAgentImage(input: AgentImageInput): Promise<Buffer> {
  const font = loadFont();
  const date = input.registeredAt.toISOString().slice(0, 10);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">` +
    line(font, "SPLITSY · PAYER AGENT", 1090, 34, "#8fb4ff", 0.28) +
    line(font, input.walletAddress.toLowerCase(), 1150, 36, "#eaf2ff") +
    line(font, `REGISTERED ${date} · ARC TESTNET`, 1204, 24, "#5f7bb0", 0.12) +
    "</svg>";
  return sharp(loadTemplate())
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .jpeg({ quality: 90 })
    .toBuffer();
}
