import { test } from "node:test";
import assert from "node:assert/strict";
import { imageSize } from "./image-size.ts";

function png(width: number, height: number): Buffer {
  const buf = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.write("IHDR", 12, "ascii");
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

// SOI, an APP0 segment to be skipped, then SOF0 carrying the dimensions.
function jpeg(width: number, height: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, ...Array(14).fill(0)]);
  const sof0 = Buffer.alloc(11);
  sof0.writeUInt8(0xff, 0);
  sof0.writeUInt8(0xc0, 1);
  sof0.writeUInt16BE(8, 2); // segment length
  sof0.writeUInt8(8, 4); // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof0, Buffer.alloc(8)]);
}

test("reads PNG dimensions", () => {
  assert.deepEqual(imageSize(png(1200, 1600)), { width: 1200, height: 1600 });
});

test("reads JPEG dimensions past a skipped segment", () => {
  assert.deepEqual(imageSize(jpeg(640, 480)), { width: 640, height: 480 });
});

test("returns null for an unknown format", () => {
  assert.equal(imageSize(Buffer.from("not an image at all, just text")), null);
});

test("returns null instead of looping on a truncated JPEG", () => {
  assert.equal(imageSize(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])), null);
});
