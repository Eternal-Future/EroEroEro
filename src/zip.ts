// Streaming ZIP writer for "store" (no compression) entries.
// Media files on nhentai are already compressed, so store keeps CPU near zero
// and lets us stream page -> client without buffering the whole archive.

export type EntrySource = ReadableStream<Uint8Array> | Uint8Array | null;

export interface ZipEntry {
  name: string;
  /** Lazily resolve the source so pages are fetched as the archive is consumed. */
  open: () => Promise<EntrySource>;
}

interface CentralRecord {
  name: string;
  crc: number;
  size: number;
  offset: number;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array, raw = 0xffffffff): number {
  let c = raw;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

const encoder = new TextEncoder();

function dosDateTime(d = new Date()): number {
  const time =
    ((d.getHours() & 0x1f) << 11) | ((d.getMinutes() & 0x3f) << 5) | ((d.getSeconds() >> 1) & 0x1f);
  const date =
    (((d.getFullYear() - 1980) & 0x7f) << 9) |
    (((d.getMonth() + 1) & 0x0f) << 5) |
    (d.getDate() & 0x1f);
  return (time << 16) | date;
}

function putU16(dv: DataView, off: number, v: number): number {
  dv.setUint16(off, v, true);
  return off + 2;
}
function putU32(dv: DataView, off: number, v: number): number {
  dv.setUint32(off, v, true);
  return off + 4;
}

function localHeader(name: Uint8Array): Uint8Array {
  const buf = new Uint8Array(30 + name.length);
  const dv = new DataView(buf.buffer);
  let o = 0;
  o = putU32(dv, o, 0x04034b50);
  o = putU16(dv, o, 20); // version needed to extract
  o = putU16(dv, o, 0x0808); // data descriptor + UTF-8 names
  o = putU16(dv, o, 0); // method: store
  const dt = dosDateTime();
  o = putU16(dv, o, dt & 0xffff); // last mod time
  o = putU16(dv, o, (dt >>> 16) & 0xffff); // last mod date
  o = putU32(dv, o, 0); // crc (filled in data descriptor)
  o = putU32(dv, o, 0); // compressed size
  o = putU32(dv, o, 0); // uncompressed size
  o = putU16(dv, o, name.length);
  o = putU16(dv, o, 0); // extra length
  buf.set(name, o);
  return buf;
}

function dataDescriptor(crc: number, size: number): Uint8Array {
  const buf = new Uint8Array(16);
  const dv = new DataView(buf.buffer);
  let o = 0;
  o = putU32(dv, o, 0x08074b50);
  o = putU32(dv, o, crc);
  o = putU32(dv, o, size);
  o = putU32(dv, o, size);
  return buf;
}

function centralHeader(name: Uint8Array, crc: number, size: number, offset: number): Uint8Array {
  const buf = new Uint8Array(46 + name.length);
  const dv = new DataView(buf.buffer);
  let o = 0;
  o = putU32(dv, o, 0x02014b50);
  o = putU16(dv, o, 20); // version made by
  o = putU16(dv, o, 20); // version needed to extract
  o = putU16(dv, o, 0x0808); // utf-8 + descriptor
  o = putU16(dv, o, 0); // method: store
  const dt = dosDateTime();
  o = putU16(dv, o, dt & 0xffff); // last mod time
  o = putU16(dv, o, (dt >>> 16) & 0xffff); // last mod date
  o = putU32(dv, o, crc);
  o = putU32(dv, o, size);
  o = putU32(dv, o, size);
  o = putU16(dv, o, name.length);
  o = putU16(dv, o, 0); // extra
  o = putU16(dv, o, 0); // comment
  o = putU16(dv, o, 0); // disk number start
  o = putU16(dv, o, 0); // internal attrs
  o = putU32(dv, o, 0); // external attrs
  o = putU32(dv, o, offset);
  buf.set(name, o);
  return buf;
}

function endOfCentralDirectory(count: number, cdSize: number, cdOffset: number): Uint8Array {
  const buf = new Uint8Array(22);
  const dv = new DataView(buf.buffer);
  let o = 0;
  o = putU32(dv, o, 0x06054b50);
  o = putU16(dv, o, 0); // disk number
  o = putU16(dv, o, 0); // cd start disk
  o = putU16(dv, o, count); // entries this disk
  o = putU16(dv, o, count); // entries total
  o = putU32(dv, o, cdSize);
  o = putU32(dv, o, cdOffset);
  o = putU16(dv, o, 0); // comment length
  return buf;
}

async function* buildZip(
  entries: AsyncIterable<ZipEntry>,
): AsyncGenerator<Uint8Array, void, void> {
  const central: CentralRecord[] = [];
  let offset = 0;

  for await (const entry of entries) {
    const name = encoder.encode(entry.name);
    const localOffset = offset;
    const header = localHeader(name);
    offset += header.length;
    yield header;

    let rawCrc = 0xffffffff;
    let size = 0;
    const source = await entry.open();
    if (source instanceof Uint8Array) {
      rawCrc = crc32(source, rawCrc);
      size = source.length;
      offset += source.length;
      yield source;
    } else if (source) {
      const reader = source.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) {
            rawCrc = crc32(value, rawCrc);
            size += value.length;
            offset += value.length;
            yield value;
          }
        }
      } finally {
        reader.releaseLock();
      }
    }

    const crc = (rawCrc ^ 0xffffffff) >>> 0;
    const dd = dataDescriptor(crc, size);
    offset += dd.length;
    yield dd;
    central.push({ name: entry.name, crc, size, offset: localOffset });
  }

  const cdOffset = offset;
  for (const rec of central) {
    const buf = centralHeader(encoder.encode(rec.name), rec.crc, rec.size, rec.offset);
    offset += buf.length;
    yield buf;
  }
  yield endOfCentralDirectory(central.length, offset - cdOffset, cdOffset);
}

function toWebStream(iter: AsyncIterable<Uint8Array>): ReadableStream<Uint8Array> {
  const it = iter[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await it.next();
        if (done) {
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (err) {
        controller.error(err instanceof Error ? err : new Error(String(err)));
      }
    },
    cancel() {
      // Iterator has no explicit cleanup; the underlying media fetches are
      // cancelled by the runtime once the stream is dropped.
    },
  });
}

export function zipStream(entries: AsyncIterable<ZipEntry>): ReadableStream<Uint8Array> {
  return toWebStream(buildZip(entries));
}