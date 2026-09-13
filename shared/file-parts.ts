// Application-level file parts carried as ordinary files by wire v3.
import { blockLength, MAX_SOURCE_BLOCKS } from "./frame-capacity";
import { MAX_FILE_BYTES, packFile, safeFileName, type OpticalFile } from "./protocol";
import { OpticalError } from "./optical-error";

export const MAX_TRANSFER_BYTES = 1024 ** 3;
export const MAX_TRANSFER_LABEL = "1 GB";
export const FILE_PART_TYPE = "application/vnd.decimen.file-part";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export interface FilePartMetadata {
  version: 1;
  id: string;
  name: string;
  type: string;
  size: number;
  partSize: number;
  index: number;
  count: number;
}

function partName(meta: FilePartMetadata): string {
  return `${meta.id}.part-${meta.index + 1}-of-${meta.count}`;
}

/** Freeze the partition for this file selection; changing frame size needs a new selection. */
export function planFileParts(file: Pick<File, "name" | "type" | "size">, frameBytes: number): FilePartMetadata | null {
  if (!Number.isSafeInteger(file.size) || file.size < 1) throw new OpticalError("fileEmpty");
  if (file.size > MAX_TRANSFER_BYTES) throw new OpticalError("fileOverLimit", { limit: MAX_TRANSFER_LABEL });
  if (!Number.isSafeInteger(frameBytes) || blockLength(frameBytes) < 1) throw new OpticalError("partInvalid");
  const name = safeFileName(file.name);
  const type = file.type || "application/octet-stream";
  if (encoder.encode(name).length > 0xffff || encoder.encode(type).length > 0xffff) throw new OpticalError("fileNameTooLong");
  const wireCapacity = MAX_SOURCE_BLOCKS * blockLength(frameBytes);
  if (file.size <= MAX_FILE_BYTES && file.size + 49 + encoder.encode(name).length + encoder.encode(type).length <= wireCapacity) return null;
  const meta: FilePartMetadata = {
    version: 1, id: crypto.randomUUID(), name, type, size: file.size,
    partSize: MAX_TRANSFER_BYTES, index: MAX_TRANSFER_BYTES, count: MAX_TRANSFER_BYTES,
  };
  // Reserve metadata using the longest possible numeric fields. Compression is
  // optional, so even incompressible parts must fit the selected frame size.
  const envelope = 4 + encoder.encode(JSON.stringify(meta)).length;
  if (envelope > 4 + 256 * 1024) throw new OpticalError("fileNameTooLong");
  const containerOverhead = 49 + encoder.encode(partName(meta)).length + encoder.encode(FILE_PART_TYPE).length;
  meta.partSize = Math.min(MAX_FILE_BYTES, wireCapacity - containerOverhead) - envelope;
  if (meta.partSize < 1) throw new OpticalError("partInvalid");
  meta.index = 0;
  meta.count = Math.ceil(file.size / meta.partSize);
  return meta;
}

export async function packFilePart(file: Blob, meta: FilePartMetadata) {
  if (file.size !== meta.size || !Number.isSafeInteger(meta.index) || meta.index < 0 || meta.index >= meta.count ||
      !Number.isSafeInteger(meta.partSize) || meta.partSize < 1 || meta.partSize > MAX_FILE_BYTES ||
      meta.count !== Math.ceil(meta.size / meta.partSize)) throw new OpticalError("partInvalid");
  const header = encoder.encode(JSON.stringify(meta));
  const start = meta.index * meta.partSize;
  const data = new Uint8Array(await file.slice(start, Math.min(start + meta.partSize, file.size)).arrayBuffer());
  const envelope = new Uint8Array(4 + header.length + data.length);
  new DataView(envelope.buffer).setUint32(0, header.length, true);
  envelope.set(header, 4);
  envelope.set(data, 4 + header.length);
  return packFile(partName(meta), FILE_PART_TYPE, envelope);
}

export function unpackFilePart(file: OpticalFile): { meta: FilePartMetadata; bytes: Uint8Array } {
  try {
    if (file.type !== FILE_PART_TYPE || file.bytes.length < 4) throw new Error();
    const length = new DataView(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength).getUint32(0, true);
    if (length === 0 || length > 256 * 1024 || 4 + length >= file.bytes.length) throw new Error();
    const meta: FilePartMetadata = JSON.parse(decoder.decode(file.bytes.subarray(4, 4 + length)));
    if (!meta || meta.version !== 1 || typeof meta.id !== "string" || !/^[0-9a-f-]{36}$/.test(meta.id) ||
        typeof meta.name !== "string" || typeof meta.type !== "string" ||
        !Number.isSafeInteger(meta.size) || meta.size < 1 || meta.size > MAX_TRANSFER_BYTES ||
        !Number.isSafeInteger(meta.partSize) || meta.partSize < 1 || meta.partSize > MAX_FILE_BYTES ||
        !Number.isSafeInteger(meta.count) || meta.count < 2 || meta.count !== Math.ceil(meta.size / meta.partSize) ||
        !Number.isSafeInteger(meta.index) || meta.index < 0 || meta.index >= meta.count) throw new Error();
    const bytes = file.bytes.subarray(4 + length);
    if (bytes.length !== Math.min(meta.partSize, meta.size - meta.index * meta.partSize)) throw new Error();
    meta.name = safeFileName(meta.name);
    return { meta, bytes };
  } catch {
    throw new OpticalError("partInvalid");
  }
}

/** Only verified parts enter this collection. Blobs avoid a final full-size byte-array copy. */
export class ReceivedFileParts {
  private readonly parts = new Map<number, { blob: Blob; digest: Uint8Array }>();
  meta: FilePartMetadata | null = null;
  get receivedCount(): number { return this.parts.size; }
  get complete(): boolean { return this.meta !== null && this.parts.size === this.meta.count; }
  get nextMissing(): number {
    let index = 0;
    while (this.parts.has(index)) index++;
    return index;
  }

  async add(file: OpticalFile): Promise<void> {
    const { meta, bytes } = unpackFilePart(file);
    const previous = this.meta;
    if (previous && (meta.id !== previous.id || meta.name !== previous.name || meta.type !== previous.type ||
        meta.size !== previous.size || meta.partSize !== previous.partSize || meta.count !== previous.count)) {
      throw new OpticalError("partMismatch");
    }
    const existing = this.parts.get(meta.index);
    if (existing) {
      if (!file.sha256.every((byte, i) => byte === existing.digest[i])) throw new OpticalError("partConflict");
      return;
    }
    const blob = await new Response(bytes as Uint8Array<ArrayBuffer>).blob();
    this.parts.set(meta.index, { blob, digest: file.sha256.slice() });
    this.meta = meta;
  }

  assemble(): Blob {
    if (!this.complete || !this.meta) throw new OpticalError("partInvalid");
    const blobs = Array.from({ length: this.meta.count }, (_, index) => this.parts.get(index)!.blob);
    const blob = new Blob(blobs, { type: this.meta.type });
    if (blob.size !== this.meta.size) throw new OpticalError("partInvalid");
    return blob;
  }
}
