// ponytail: minimal header parse for JPEG + PNG only — enough for the quality
// gate that decides whether a photo is worth paying to OCR. Returns null when
// the format is unknown; callers must treat null as "don't block on dimensions"
// rather than as a rejection. Upgrade path: an image lib, if HEIC/WebP uploads
// start showing up and the gate needs to see them.
export function imageSize(buf: Buffer): { width: number; height: number } | null {
  // PNG: 8-byte signature, then a length+"IHDR" chunk with width/height as BE u32.
  if (buf.length >= 24 && buf.toString("ascii", 12, 16) === "IHDR") {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }

  // JPEG: walk the marker segments to the start-of-frame, which carries the size.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buf[offset + 1];
      // SOF0..SOF15, excluding DHT (c4), JPG (c8) and DAC (cc) which are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
      }
      const segmentLength = buf.readUInt16BE(offset + 2);
      if (segmentLength < 2) return null; // malformed — refuse to loop forever
      offset += 2 + segmentLength;
    }
  }

  return null;
}
