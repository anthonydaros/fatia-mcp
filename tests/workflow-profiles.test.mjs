import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listSlicerProfiles, PROFILE_TOOLS } from '../dist/workflows/profiles.js';

test('profile inventory resolves dependencies and reports compatibility evidence without guessing', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'inventory-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const kind of ['machine', 'process', 'filament']) await fs.mkdir(path.join(root, 'BBL', kind), {recursive:true});
  const write = (kind, name, data) => fs.writeFile(path.join(root, 'BBL', kind, `${name}.json`), JSON.stringify({name, ...data}));
  await write('machine', 'Printer', {instantiation:'true'});
  await write('process', 'base', {instantiation:'false', compatible_printers:['Printer']});
  await write('process', 'good', {instantiation:'true', inherits:'base'});
  await write('process', 'broken', {instantiation:'true', inherits:'absent'});
  await write('filament', 'condition', {instantiation:'true', compatible_printers_condition:'printer_model == "X"'});
  const result = await listSlicerProfiles({ machine_preset:'Printer' }, {profilesRoot:root});
  const byName = Object.fromEntries(result.profiles.map(p => [p.name,p]));
  assert.equal(byName.good.compatibility.status, 'compatible');
  assert.equal(byName.good.inheritance.status, 'valid');
  assert.equal(byName.broken.compatibility.status, 'unknown');
  assert.match(byName.broken.inheritance.error, /absent/);
  assert.equal(byName.condition.compatibility.status, 'unknown');
  assert.equal(byName.base, undefined);
  assert.equal(PROFILE_TOOLS[0].name, 'list_slicer_profiles');
  assert.equal(PROFILE_TOOLS[0].inputSchema.properties.slicer_path, undefined);
});

test('inventory rejects missing installation and invalid pagination', async () => {
  await assert.rejects(listSlicerProfiles({}, {profilesRoot:'/nonexistent-fatia-install'}), /profile|installation/i);
  await assert.rejects(listSlicerProfiles({limit:0}), /limit/);
});

test('inventory includes errors for cycles, missing includes and malformed files; respects pagination', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(),'inventory-'));
  t.after(() => fs.rm(root,{recursive:true,force:true}));
  for (const kind of ['machine','process','filament']) await fs.mkdir(path.join(root,'BBL',kind),{recursive:true});
  for (const data of [{name:'a',inherits:'b'},{name:'b',inherits:'a'},{name:'c',include:['absent']}]) await fs.writeFile(path.join(root,'BBL','process',`${data.name}.json`),JSON.stringify(data));
  await fs.writeFile(path.join(root,'BBL','process','invalid.json'),'{');
  const result = await listSlicerProfiles({kind:'process',limit:2},{profilesRoot:root,userProfileRoots:[]});
  assert.equal(result.profiles.length,2);
  assert.equal(result.total,3);
  assert.equal(result.malformed_profiles.length,1);
  assert.ok(result.profiles.every(p => p.inheritance.status === 'invalid'));
  const last = await listSlicerProfiles({offset:2,limit:1},{profilesRoot:root,userProfileRoots:[]});
  assert.match(last.profiles[0].inheritance.error,/absent/);
});
