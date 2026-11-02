import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import { studioAllPlatesSlicer, studioSlicer } from '../dist/tuning/prepare-slice.js';

// A complete executable tail beyond the bounded config prefix catches early stream termination.
const code = '; CONFIG_BLOCK_START\n; wall_loops = 4\n; CONFIG_BLOCK_END\n; EXECUTABLE_BLOCK_START\n; MACHINE_START_GCODE_END\n'
  + '; padding\n'.repeat(450000) + '; MACHINE_END_GCODE_START\n; EXECUTABLE_BLOCK_END\n';

async function fixture(t, { truncated = false, corruptOnScan = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatia-scan-io-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const zip = new JSZip();
  zip.file('Metadata/project_settings.config', '{}');
  zip.file('Metadata/filament_sequence.json', '{"sequence":[1]}');
  zip.file('Metadata/slice_info.config', '<config>' + [1, 2].map(i => `<plate><metadata key="index" value="${i}"/><metadata key="prediction" value="90"/><metadata key="weight" value="1"/></plate>`).join('') + '</config>');
  const text = truncated ? code.replace('; EXECUTABLE_BLOCK_END\n', '') : code;
  for (const i of [1, 2]) zip.file(`Metadata/plate_${i}.gcode`, text);
  const output = path.join(dir, 'result.3mf');
  const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: corruptOnScan ? 'STORE' : 'DEFLATE' });
  await fs.writeFile(output, bytes);
  const open = fs.open;
  let reads = 0;
  const spy = t.mock.method(fs, 'open', async (...args) => {
    if (args[0] === output) {
      reads++;
      if (reads === 2 && corruptOnScan) {
        // Change a payload byte after the metadata reader verified the original archive.
        const tail = bytes.indexOf(Buffer.from('; MACHINE_END_GCODE_START'));
        assert.ok(tail > 4 * 2 ** 20);
        bytes[tail + 2] ^= 1;
        await fs.writeFile(output, bytes);
      }
    }
    return open(...args);
  });
  syncBuiltinESMExports();
  t.after(() => { spy.mock.restore(); syncBuiltinESMExports(); });
  const options = {
    manipulator: { planProjectSettings: async () => undefined, sliceSTL: async () => output },
    slicerPath: 'fake-slicer', printerPreset: 'Bambu Lab X2D 0.4 nozzle', modelCode: 'X2D', plateIndex: 0,
  };
  return { output, options, text, reads: () => reads };
}

test('one plate reads the archive twice while scanning its entire G-code and config', async t => {
  const f = await fixture(t);
  const result = await studioSlicer(f.options)('candidate.3mf');
  assert.equal(result.gcode.complete, true);
  assert.equal(result.gcode.stats.bytes, Buffer.byteLength(f.text));
  assert.equal(result.block.wall_loops, '4');
  assert.deepEqual(result.slice.filamentSequence, { sequence: [1] });
  assert.equal(f.reads(), 2, 'one metadata read and one full verified G-code read');
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
});

test('two plates need three archive reads and retain per-plate measurements', async t => {
  const f = await fixture(t);
  const results = await studioAllPlatesSlicer(f.options)('candidate.3mf');
  assert.deepEqual(results.map(r => [r.plate, r.gcode_complete, r.block.wall_loops, r.time_s, r.weight_g]), [[1, true, '4', 90, 1], [2, true, '4', 90, 1]]);
  assert.equal(f.reads(), 3, 'one metadata read plus one verified read per plate');
});

test('the merged config read does not certify a truncated executable tail', async t => {
  const f = await fixture(t, { truncated: true });
  const result = await studioSlicer(f.options)('candidate.3mf');
  assert.equal(result.block.wall_loops, '4');
  assert.equal(result.gcode.complete, false);
  assert.equal(result.gcode.stats.bytes, Buffer.byteLength(f.text));
});

test('cancelled scanning rejects and still removes the temporary slice', async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort(new Error('scan cancelled'));
  await assert.rejects(studioSlicer(f.options)('candidate.3mf', controller.signal), /scan cancelled/);
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
});

test('corruption beyond the captured prefix still fails the full stream CRC', async t => {
  const f = await fixture(t, { corruptOnScan: true });
  await assert.rejects(studioSlicer(f.options)('candidate.3mf'), /CRC mismatch/);
  await assert.rejects(fs.stat(f.output), { code: 'ENOENT' });
});
