/* Minimal "stored" (no-compression) ZIP writer. Self-hosted, no deps.
   Exposes window.SimpleZip.makeZip(files) -> Blob.
   files: [{ name: string, data: Uint8Array }]  */
(function (global) {
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(files) {
    const enc = new TextEncoder();
    const local = [];
    const central = [];
    let offset = 0;

    for (const f of files) {
      const nameBytes = enc.encode(f.name);
      const data = f.data;
      const crc = crc32(data);

      const lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);   // local file header signature
      lh.setUint16(4, 20, true);           // version needed to extract
      lh.setUint16(6, 0x0800, true);       // flags: bit 11 = UTF-8 filename
      lh.setUint16(8, 0, true);            // compression method: 0 = stored
      lh.setUint16(10, 0, true);           // last mod time
      lh.setUint16(12, 0x21, true);        // last mod date (1980-01-01)
      lh.setUint32(14, crc, true);
      lh.setUint32(18, data.length, true); // compressed size
      lh.setUint32(22, data.length, true); // uncompressed size
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);           // extra field length
      local.push(new Uint8Array(lh.buffer), nameBytes, data);

      const ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);   // central directory header signature
      ch.setUint16(4, 20, true);           // version made by
      ch.setUint16(6, 20, true);           // version needed
      ch.setUint16(8, 0x0800, true);       // flags: UTF-8
      ch.setUint16(10, 0, true);           // compression
      ch.setUint16(12, 0, true);           // mod time
      ch.setUint16(14, 0x21, true);        // mod date
      ch.setUint32(16, crc, true);
      ch.setUint32(20, data.length, true);
      ch.setUint32(24, data.length, true);
      ch.setUint16(28, nameBytes.length, true);
      ch.setUint16(30, 0, true);           // extra len
      ch.setUint16(32, 0, true);           // comment len
      ch.setUint16(34, 0, true);           // disk number start
      ch.setUint16(36, 0, true);           // internal attrs
      ch.setUint32(38, 0, true);           // external attrs
      ch.setUint32(42, offset, true);      // local header offset
      central.push(new Uint8Array(ch.buffer), nameBytes);

      offset += 30 + nameBytes.length + data.length;
    }

    const centralStart = offset;
    let centralSize = 0;
    for (const c of central) centralSize += c.length;

    const eo = new DataView(new ArrayBuffer(22));
    eo.setUint32(0, 0x06054b50, true);     // end of central directory signature
    eo.setUint16(4, 0, true);              // disk number
    eo.setUint16(6, 0, true);              // disk with central dir
    eo.setUint16(8, files.length, true);   // entries on this disk
    eo.setUint16(10, files.length, true);  // total entries
    eo.setUint32(12, centralSize, true);
    eo.setUint32(16, centralStart, true);
    eo.setUint16(20, 0, true);             // comment length

    return new Blob([...local, ...central, new Uint8Array(eo.buffer)], { type: 'application/zip' });
  }

  global.SimpleZip = { makeZip };

  // ── Reader ────────────────────────────────────────────────────────────
  // Enough of a ZIP reader to re-open a workbook SheetJS just wrote, so a member can be
  // edited and the archive rebuilt. STORED entries only — SheetJS writes uncompressed by
  // default, and inflate is not worth carrying. Returns null if anything is compressed, so
  // callers fall back to the untouched file rather than producing a corrupt one.
  function readZip(bytes) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const files = [];
    let i = 0;
    while (i + 4 <= u8.length && dv.getUint32(i, true) === 0x04034b50) {
      const method = dv.getUint16(i + 8, true);
      const compSize = dv.getUint32(i + 18, true);
      const nameLen = dv.getUint16(i + 26, true);
      const extraLen = dv.getUint16(i + 28, true);
      const nameStart = i + 30;
      const name = new TextDecoder().decode(u8.subarray(nameStart, nameStart + nameLen));
      const dataStart = nameStart + nameLen + extraLen;
      if (method !== 0) return null;                       // compressed — give up, safely
      files.push({ name, data: u8.slice(dataStart, dataStart + compSize) });
      i = dataStart + compSize;
    }
    return files.length ? files : null;
  }

  global.SimpleZip.readZip = readZip;

})(typeof window !== 'undefined' ? window : this);
