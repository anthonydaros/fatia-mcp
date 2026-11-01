import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import JSZip from 'jszip';
import * as inventory from '../dist/workflows/inventory.js';

async function fixture(t, partial = false, missing = false) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatia-stock-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const zip = new JSZip();
  zip.file('Metadata/model_settings.config', `<config><plate><metadata key="plater_id" value="1"/><model_instance/></plate>${partial ? '<plate><metadata key="plater_id" value="2"/><model_instance/></plate>' : ''}</config>`);
  zip.file('Metadata/slice_info.config', `<config><plate><metadata key="index" value="1"/><metadata key="weight" value="30"/>${missing ? '' : '<filament id="1" used_g="10"/><filament id="2" used_g="20"/>'}</plate></config>`);
  const file = path.join(dir, 'input.3mf');
  await fs.writeFile(file, await zip.generateAsync({type:'nodebuffer'}));
  return file;
}
test('inventory checks each slot with project copies and explicit reserve', async t => {
  assert.equal(typeof inventory.checkFilamentAvailability, 'function');
  const file = await fixture(t);
  const args = {path:file, copies:2, safety_margin_percent:10, filaments:[{slot:1,available_g:25},{slot:2,available_g:43}]};
  const r = await inventory.checkFilamentAvailability(args);
  assert.equal(r.status, 'insufficient');
  assert.equal(r.filaments[0].required_g, 22);
  assert.equal(r.filaments[1].required_g, 44);
  assert.equal(r.filaments[1].shortage_g, 1);
  args.filaments[1].available_g = 45;
  assert.equal((await inventory.checkFilamentAvailability(args)).status, 'sufficient_estimate');
});
test('inventory never infers sufficiency from missing slots or incomplete plate consumption', async t => {
  const file = await fixture(t, true);
  const r = await inventory.checkFilamentAvailability({path:file, filaments:[{slot:1,available_g:100},{slot:2,available_g:100}]});
  assert.equal(r.status, 'unknown');
  assert.equal(r.filaments[0].required_g, null);
  assert.equal(r.filaments[0].known_subset_required_g, 11);
  const complete = await fixture(t);
  assert.equal((await inventory.checkFilamentAvailability({path:complete,filaments:[{slot:1,available_g:100}]})).status, 'unknown');
  const missing = await fixture(t,false,true);
  assert.equal((await inventory.checkFilamentAvailability({path:missing,filaments:[{slot:1,available_g:100}]})).status, 'unknown');
});
test('inventory rejects invalid weights, duplicated slots and cancelled work', async t => {
  const file = await fixture(t);
  for (const filaments of [[],[{slot:1,available_g:NaN}],[{slot:0,available_g:10}],[{slot:1,available_g:2},{slot:1,available_g:3}]]) {
    await assert.rejects(inventory.checkFilamentAvailability({path:file,filaments}), /filament|slot|finite/i);
  }
  await assert.rejects(inventory.checkFilamentAvailability({path:file,filaments:[{slot:1,available_g:1}],copies:0}), /copies/i);
  await assert.rejects(inventory.checkFilamentAvailability({path:file,filaments:[{slot:1,available_g:1}]}, AbortSignal.abort()), /abort/i);
});
test('inventory does not call unallocated plate weight sufficient', async t => {
  const file = await fixture(t);
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const entry = 'Metadata/slice_info.config';
  zip.file(entry, (await zip.file(entry).async('string')).replace('<filament id="2" used_g="20"/>',''));
  await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
  const r = await inventory.checkFilamentAvailability({path:file,filaments:[{slot:1,available_g:11}]});
  assert.equal(r.status,'unknown');
  assert.equal(r.filaments[0].required_g,null);
  assert.ok(r.unknown.some(s=>/weight|consumption/i.test(s)));
});
