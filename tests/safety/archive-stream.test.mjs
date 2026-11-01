// streamSafe3mfEntry: one entry of a verified archive as a stream of inflated chunks (the 41 MB plate G-code of a sliced X2D project is never
// one buffer). Every check of loadSafe3mfArchive applies, and inflation past the declared size or a wrong CRC errors the stream.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { streamSafe3mfEntry, streamSafe3mfEntryFromFile } from '../../dist/safety/archive.js';

const text = Array.from({ length: 60000 }, (_, i) => `G1 X${i % 250} Y${(i * 7) % 250} E.04644`).join('\n') + '\n';
async function zipOf(compression, entries = { 'Metadata/plate_1.gcode': text, 'Metadata/other.txt': 'x' }) {
  const zip = new JSZip();
  for (const [name, value] of Object.entries(entries)) zip.file(name, value, { createFolders: false });
  return zip.generateAsync({ type: 'nodebuffer', compression });
}
async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

for (const compression of ['DEFLATE', 'STORE']) {
  test(`${compression} entry streams in chunks and equals the original`, async () => {
    const chunks = await collect(streamSafe3mfEntry(await zipOf(compression), 'Metadata/plate_1.gcode'));
    assert.ok(chunks.length > 1, 'more than one chunk');
    assert.ok(chunks.every(chunk => chunk.length <= 64 * 1024), 'chunks stay at 64 KB');
    assert.equal(Buffer.concat(chunks).toString('utf8'), text);
  });
}

test('a missing entry is refused', async () => {
  assert.throws(() => streamSafe3mfEntry(Buffer.from('nope'), 'Metadata/plate_1.gcode'), /ZIP|archive/i);
  assert.throws(() => streamSafe3mfEntry(Buffer.from([]), 'x'), /ZIP|archive/i);
  const bytes = await zipOf('DEFLATE');
  assert.throws(() => streamSafe3mfEntry(bytes, 'Metadata/plate_2.gcode'), /no entry 'Metadata\/plate_2.gcode'/);
});

test('a corrupt stored entry fails on the CRC at the end of the stream', async () => {
  const bytes = Buffer.from(await zipOf('STORE'));
  const at = bytes.indexOf(Buffer.from('G1 X5 Y35'));
  assert.ok(at > 0);
  bytes[at + 3] ^= 1;
  await assert.rejects(collect(streamSafe3mfEntry(bytes, 'Metadata/plate_1.gcode')), /CRC mismatch/);
});

test('an entry that inflates past its declared size errors the stream instead of growing', async () => {
  const bytes = Buffer.from(await zipOf('DEFLATE', { 'Metadata/plate_1.gcode': 'A'.repeat(2 * 1024 * 1024) }));
  // lie in both the local header and the central directory: 100 bytes
  const local = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bytes.writeUInt32LE(100, local + 22);
  bytes.writeUInt32LE(100, central + 24);
  await assert.rejects(collect(streamSafe3mfEntry(bytes, 'Metadata/plate_1.gcode')), /declared size|size mismatch/);
});

test('a consumer that stops early does not hang', async () => {
  const stream = streamSafe3mfEntry(await zipOf('DEFLATE'), 'Metadata/plate_1.gcode');
  for await (const chunk of stream) { assert.ok(chunk.length > 0); break; }
  await new Promise(resolve => (stream.destroyed ? resolve() : stream.once('close', resolve)));
  assert.equal(stream.destroyed, true);
});

test('streamSafe3mfEntryFromFile reads a file on disk', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bambu-stream-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'sliced.3mf');
  await fs.writeFile(file, await zipOf('DEFLATE'));
  assert.equal(Buffer.concat(await collect(await streamSafe3mfEntryFromFile(file, 'Metadata/plate_1.gcode'))).toString('utf8'), text);
});
