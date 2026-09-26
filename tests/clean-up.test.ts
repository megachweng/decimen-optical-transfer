// Picture clean-up for poor captures (shared/enhance.ts) and the decode paths
// that use it (receive/decode.ts), against the real decimen-codec wasm.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import DecimenCodec from "../vendor/decimen-codec/decimen_codec.js";
import { decodeJob } from "../receive/decode.ts";
import { Enhancer, cleanUpParams } from "../shared/enhance.ts";
import { splitmix32 } from "../shared/protocol.ts";
import { rasterizeQrGrid, gridDims } from "../shared/qr-raster.ts";
import { QUIET_ZONE_MODULES, createFrameQr } from "../send/qr-frame.ts";

const wasm = readFileSync(fileURLToPath(new URL("../vendor/decimen-codec/decimen_codec.wasm", import.meta.url)));
const zx = await DecimenCodec({
  instantiateWasm: (imports: WebAssembly.Imports, done: (i: WebAssembly.Instance, m: WebAssembly.Module) => void) => {
    void WebAssembly.instantiate(wasm, imports).then((r) => done(r.instance, r.module));
    return {};
  },
} as never);

function gray(width: number, height: number, value: (x: number, y: number) => number): Uint8Array {
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const v = value(x, y);
      const p = (y * width + x) * 4;
      out[p] = out[p + 1] = out[p + 2] = v;
      out[p + 3] = 255;
    }
  return out;
}

test("level 0 is the capture itself; levels 1 and 2 sharpen, level 2 at 1.5×", () => {
  assert.deepEqual(cleanUpParams(0), { scale: 1, amount: 0, sigma: 0 });
  const e = new Enhancer();
  const src = gray(40, 30, (x) => (x < 20 ? 60 : 200));
  const one = e.process(src, 40, 30, 1);
  assert.equal(one.width, 40);
  assert.equal(one.height, 30);
  assert.equal(one.sx, 1);
  e.reset();
  const two = e.process(src, 40, 30, 2);
  assert.equal(two.width, 60);
  assert.equal(two.height, 45);
  assert.equal(two.sx, 1.5);
  assert.equal(two.sy, 1.5);
  // Gray RGBA, opaque.
  for (let p = 0; p < two.data.length; p += 4) {
    assert.equal(two.data[p], two.data[p + 1]);
    assert.equal(two.data[p], two.data[p + 2]);
    assert.equal(two.data[p + 3], 255);
  }
});

test("the unsharp mask steepens an edge and leaves flat ground alone", () => {
  const e = new Enhancer();
  const src = gray(40, 8, (x) => (x < 20 ? 60 : 200));
  const out = e.process(src, 40, 8, 1).data;
  const at = (x: number) => out[(4 * 40 + x) * 4]!;
  assert.equal(at(2), 60);
  assert.equal(at(37), 200);
  // Overshoot either side of the edge: darker than the dark side, lighter
  // than the light one — the contrast defocus took away, put back.
  assert.ok(at(19) < 60, `dark side ${at(19)}`);
  assert.ok(at(20) > 200, `light side ${at(20)}`);
});

test("level 2 reuses level 1's sharpening on the same buffer, and only there", () => {
  const e = new Enhancer();
  const a = gray(30, 30, (x, y) => ((x >> 2) + (y >> 2)) % 2 ? 40 : 220);
  const b = gray(30, 30, () => 128);
  e.process(a, 30, 30, 1);
  const reused = e.process(a, 30, 30, 2).data.slice();
  e.reset();
  const fresh = e.process(a, 30, 30, 2).data.slice();
  assert.deepEqual(reused, fresh);
  // A different buffer is sharpened afresh.
  const flat = e.process(b, 30, 30, 2).data;
  assert.ok(flat.every((v, i) => (i % 4 === 3 ? v === 255 : v === 128)));
});

/** A defocused, washed-out camera view of a 2×3 grid at 2.2 px per module:
 *  area-sampled at a slight rotation, Gaussian σ 1 px, 40…215, noise σ 5. */
function defocusedGrid(payloads: Uint8Array[]) {
  let version: number | undefined;
  const qrs = payloads.map((p) => {
    const qr = createFrameQr(p, "L", version);
    version = qr.version;
    return qr;
  });
  const n = qrs[0]!.modules.size;
  const grid = rasterizeQrGrid(n, qrs.map((q) => q.modules.data), QUIET_ZONE_MODULES);
  const { cols, rows } = gridDims(6);
  const cell = n + 2 * QUIET_ZONE_MODULES;
  const pitch = 2.2;
  const angle = (1.5 * Math.PI) / 180;
  const width = Math.round(cols * cell * pitch) + 80;
  const height = Math.round(rows * cell * pitch) + 80;
  const cx = width / 2, cy = height / 2, gw = grid.width / 2, gh = grid.height / 2;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const moduleAt = (u: number, v: number) => {
    const x = Math.floor(u), y = Math.floor(v);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return 1;
    return grid.pixels[y * grid.width + x] === 0xffffffff ? 1 : 0;
  };
  let plane = new Float32Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let sy = 0; sy < 4; sy++)
        for (let sx = 0; sx < 4; sx++) {
          const px = x + (sx + 0.5) / 4 - cx, py = y + (sy + 0.5) / 4 - cy;
          sum += moduleAt((cos * px + sin * py) / pitch + gw, (-sin * px + cos * py) / pitch + gh);
        }
      plane[y * width + x] = sum / 16;
    }
  const sigma = 1;
  const k = [-3, -2, -1, 0, 1, 2, 3].map((i) => Math.exp(-(i * i) / (2 * sigma * sigma)));
  const ks = k.reduce((a, b) => a + b, 0);
  const blur = (src: Float32Array, dx: number, dy: number) => {
    const out = new Float32Array(src.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        let acc = 0;
        for (let i = -3; i <= 3; i++) {
          const xi = Math.min(width - 1, Math.max(0, x + i * dx)), yi = Math.min(height - 1, Math.max(0, y + i * dy));
          acc += k[i + 3]! * src[yi * width + xi]!;
        }
        out[y * width + x] = acc / ks;
      }
    return out;
  };
  plane = blur(blur(plane, 1, 0), 0, 1);
  const rnd = splitmix32(0x5eed);
  const noise = () => {
    const u = Math.max(rnd() / 2 ** 32, 1e-12), v = rnd() / 2 ** 32;
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  };
  const rgba = gray(width, height, (x, y) => Math.max(0, Math.min(255, Math.round(40 + 175 * plane[y * width + x]! + 5 * noise()))));
  return { rgba, width, height };
}

test("a defocused six-code grid reads only with clean-up", () => {
  const rnd = splitmix32(6);
  const payloads = Array.from({ length: 6 }, () => Uint8Array.from({ length: 1000 }, () => rnd() & 0xff));
  const want = new Set(payloads.map((p) => Buffer.from(p).toString("base64")));
  const { rgba, width, height } = defocusedGrid(payloads);
  const e = new Enhancer();
  const read = (o: ReturnType<typeof decodeJob>) => o.symbols.map((s) => Buffer.from(s.bytes).toString("base64")).filter((b) => want.has(b));

  // The stock decode paths — exactly the receiver before clean-up — read nothing.
  const raw = decodeJob(zx, e, rgba, width, height, { ox: 0, oy: 0, full: true, cleanUp: false });
  assert.equal(read(raw).length, 0, "the capture should be past the stock decoder");

  // A full scan with clean-up finds codes; crops of them at the level that
  // read them (climbing one more on a miss) read every one.
  const scan = decodeJob(zx, e, rgba, width, height, { ox: 0, oy: 0, full: true, expected: 0, allowBlindCleanUp: true });
  assert.ok(scan.symbols.length > 0, "the clean-up full scan should acquire codes");
  assert.ok(scan.symbols.every((s) => (s.level ?? 0) > 0));
  const found = new Set(read(scan));
  const { cols, rows } = gridDims(6);
  const cw = width / cols, ch = height / rows;
  for (let i = 0; i < 6; i++) {
    const x = Math.floor((i % cols) * cw), y = Math.floor(Math.floor(i / cols) * ch);
    const w = Math.floor(cw), h = Math.floor(ch);
    const crop = new Uint8Array(w * h * 4);
    for (let r = 0; r < h; r++) crop.set(rgba.subarray(((y + r) * width + x) * 4, ((y + r) * width + x + w) * 4), r * w * 4);
    const hit = scan.symbols.find((s) => s.box.x + s.box.w / 2 >= x && s.box.x + s.box.w / 2 < x + w && s.box.y + s.box.h / 2 >= y && s.box.y + s.box.h / 2 < y + h);
    const o = decodeJob(zx, e, crop, w, h, {
      ox: x, oy: y, full: false, quad: hit?.quad, dim: hit?.modules, level: hit?.level ?? 1, escalate: true,
    });
    for (const b of read(o)) found.add(b);
  }
  assert.equal(found.size, 6);
});

test("with nothing in view the clean-up passes wait for their ration", () => {
  const e = new Enhancer();
  const flat = gray(320, 240, (x, y) => 120 + ((x * 7 + y * 13) % 16));
  const held = decodeJob(zx, e, flat, 320, 240, { ox: 0, oy: 0, full: true, expected: 0, allowBlindCleanUp: false });
  assert.equal(held.passes, 1);
  assert.equal(held.blindCleanUp, false);
  const spent = decodeJob(zx, e, flat, 320, 240, { ox: 0, oy: 0, full: true, expected: 0, allowBlindCleanUp: true });
  assert.equal(spent.passes, 3);
  assert.equal(spent.blindCleanUp, true);
});
