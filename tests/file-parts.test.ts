import assert from "node:assert/strict";
import test from "node:test";
import { FILE_PART_TYPE, MAX_TRANSFER_BYTES, planFileParts, packFilePart, unpackFilePart, ReceivedFileParts, type FilePartMetadata } from "../shared/file-parts.ts";
import { HEADER_LEN, MAX_FILE_BYTES, WIRE_VERSION, fnv1a, packFrame, parseFrame, unpackFile, verifyFile, type OpticalFile } from "../shared/protocol.ts";
import { fitsInOneStream } from "../shared/frame-capacity.ts";
import { FRAME_BYTES_OPTIONS } from "../shared/send-settings.ts";
import { LTEncoder, LTDecoder } from "../shared/fountain.ts";

const source = Uint8Array.from({ length: 103 }, (_, i) => i);
const blob = new Blob([source]);
const meta: FilePartMetadata = {
  version: 1, id: "12345678-1234-1234-1234-123456789abc", name: "résumé.bin",
  type: "application/octet-stream", size: source.length, partSize: 40, count: 3, index: 0,
};
async function part(index: number): Promise<OpticalFile> {
  const packed = await packFilePart(blob, { ...meta, index });
  const file = await unpackFile(packed.container);
  assert.ok(await verifyFile(file));
  return file;
}

function altered(file: OpticalFile, changes: Record<string, unknown>): OpticalFile {
  const original = unpackFilePart(file);
  const json = new TextEncoder().encode(JSON.stringify({ ...original.meta, ...changes }));
  const bytes = new Uint8Array(4 + json.length + original.bytes.length);
  new DataView(bytes.buffer).setUint32(0, json.length, true);
  bytes.set(json, 4);
  bytes.set(original.bytes, 4 + json.length);
  return { ...file, bytes };
}

test("v3 and its original per-file ceiling stay unchanged", () => {
  assert.equal(WIRE_VERSION, 3);
  assert.equal(HEADER_LEN, 22);
  assert.equal(MAX_FILE_BYTES, 64 * 1024 ** 2);
  assert.equal(planFileParts({ name: "small", type: "", size: 1000 }, 500), null);
  assert.equal(planFileParts({ name: "old-limit", type: "", size: MAX_FILE_BYTES }, 2953), null);
  assert.throws(() => planFileParts({ name: "empty", type: "", size: 0 }, 2953), /empty/);
  assert.throws(() => planFileParts({ name: "large", type: "", size: MAX_TRANSFER_BYTES + 1 }, 2953), /1 GB/);
});

test("every frame size partitions 1 GiB with room for both envelopes", async () => {
  for (const frameBytes of FRAME_BYTES_OPTIONS) {
    const planned = planFileParts({ name: "大文件.bin", type: "application/zip", size: MAX_TRANSFER_BYTES }, frameBytes)!;
    assert.ok(planned.partSize < MAX_FILE_BYTES);
    assert.equal(planned.count, Math.ceil(MAX_TRANSFER_BYTES / planned.partSize));
    const jsonLength = new TextEncoder().encode(JSON.stringify({ ...planned, index: planned.count - 1 })).length;
    const outerName = `${planned.id}.part-${planned.count}-of-${planned.count}`;
    const outerLength = 49 + new TextEncoder().encode(outerName).length + FILE_PART_TYPE.length;
    assert.ok(planned.partSize + 4 + jsonLength <= MAX_FILE_BYTES);
    assert.ok(fitsInOneStream(planned.partSize + 4 + jsonLength + outerLength, frameBytes));
  }
  assert.ok(planFileParts({ name: "medium", type: "", size: 40 * 1024 ** 2 }, 500));
});

test("only the selected slice is read", async () => {
  let range: [number | undefined, number | undefined] | undefined;
  class ObservedBlob extends Blob {
    override slice(start?: number, end?: number): Blob {
      range = [start, end];
      return super.slice(start, end);
    }
    override arrayBuffer(): Promise<ArrayBuffer> { throw new Error("whole-file read"); }
  }
  const packed = await packFilePart(new ObservedBlob([source]), { ...meta, index: 2 });
  assert.deepEqual(range, [80, 103]);
  const decoded = unpackFilePart(await unpackFile(packed.container));
  assert.deepEqual(decoded.bytes, source.subarray(80));
});

test("out-of-order parts and duplicates assemble exactly once in order", async () => {
  const received = new ReceivedFileParts();
  await received.add(await part(2));
  assert.equal(received.nextMissing, 0);
  assert.throws(() => received.assemble(), /invalid/);
  const first = await part(0);
  await received.add(first);
  await received.add(first);
  assert.equal(received.receivedCount, 2);
  assert.equal(received.nextMissing, 1);
  await received.add(await part(1));
  assert.ok(received.complete);
  const result = received.assemble();
  assert.equal(result.size, source.length);
  assert.equal(result.type, meta.type);
  assert.deepEqual(new Uint8Array(await result.arrayBuffer()), source);
});

test("mixing transfers, changed metadata, and conflicting duplicates fail without losing parts", async () => {
  const received = new ReceivedFileParts();
  const first = await part(0);
  await received.add(first);
  for (const changes of [
    { id: "abcdefab-1234-1234-1234-123456789abc" }, { name: "other" }, { type: "text/plain" },
  ]) await assert.rejects(received.add(altered(first, changes)), /different transfer/);
  await assert.rejects(received.add({ ...first, sha256: new Uint8Array(32) }), /conflicts/);
  assert.equal(received.receivedCount, 1);
  assert.equal(received.meta?.name, meta.name);
});

test("malformed part metadata, lengths, and versions are rejected", async () => {
  const first = await part(0);
  for (const changes of [
    { version: 2 }, { id: "" }, { size: MAX_TRANSFER_BYTES + 1 }, { size: -1 },
    { partSize: 0 }, { partSize: MAX_FILE_BYTES + 1 }, { count: 1 }, { count: 4 },
    { index: -1 }, { index: 3 }, { index: 0.5 }, { name: null }, { type: 42 },
  ]) assert.throws(() => unpackFilePart(altered(first, changes)), /invalid/);
  assert.throws(() => unpackFilePart({ ...first, bytes: first.bytes.subarray(0, first.bytes.length - 1) }), /invalid/);
  assert.throws(() => unpackFilePart({ ...first, bytes: new Uint8Array([255, 255, 255, 255]) }), /invalid/);
  assert.throws(() => unpackFilePart({ ...first, type: "application/octet-stream" }), /invalid/);
  assert.equal(unpackFilePart(altered(first, { name: "../../file.bin" })).meta.name, "file.bin");
});

test("all parts survive ordinary v3 fountain frames with loss, duplicates, and SHA-256 verification", async () => {
  const received = new ReceivedFileParts();
  for (const index of [2, 0, 1]) {
    const packed = await packFilePart(blob, { ...meta, index });
    const encoder = new LTEncoder(packed.container, 37, 100 + index);
    const checksum = fnv1a(packed.container);
    let receiver: LTDecoder | undefined;
    for (let seq = 0; !receiver?.isComplete; seq++) {
      assert.ok(seq < 1000);
      if (seq % 5 === 0) continue;
      const frame = packFrame({ sessionId: 100 + index, seq, k: encoder.k, blockLen: 37,
        totalLen: packed.container.length, payloadFnv: checksum, flags: 0 }, encoder.encode(seq));
      assert.equal(frame[2], 3);
      const parsed = parseFrame(frame)!;
      receiver ??= new LTDecoder(parsed.header.k, parsed.header.blockLen, parsed.header.sessionId, parsed.header.totalLen);
      receiver.addFrame(parsed.header.seq, parsed.block);
      receiver.addFrame(parsed.header.seq, parsed.block);
    }
    const container = receiver.assemble()!;
    assert.equal(fnv1a(container), checksum);
    const file = await unpackFile(container);
    assert.ok(await verifyFile(file));
    await received.add(file);
  }
  assert.deepEqual(new Uint8Array(await received.assemble().arrayBuffer()), source);
});
