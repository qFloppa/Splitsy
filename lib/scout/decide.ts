// Scout's autonomous decision logic. Pure so the behavior is fully testable.
export const CONFIDENCE_THRESHOLD = 0.8;

const MIN_BYTES = 8 * 1024; // < 8KB is almost certainly not a legible receipt
const MIN_EDGE = 200; // px; below this OCR is a waste of a payment

export function assessImage(
  bytes: number,
  width: number,
  height: number,
): { ok: boolean; reason?: string } {
  if (bytes < MIN_BYTES) return { ok: false, reason: "Image too small to read — use a clearer photo." };
  if (width < MIN_EDGE || height < MIN_EDGE) return { ok: false, reason: "Image resolution too low to read." };
  return { ok: true };
}

export function shouldPayAgain(confidence: number, canAfford: boolean): boolean {
  return confidence < CONFIDENCE_THRESHOLD && canAfford;
}

export function pickBetterParse<T extends { confidence: number }>(a: T, b: T): T {
  return b.confidence > a.confidence ? b : a;
}
