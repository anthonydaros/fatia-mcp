import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { STLManipulator } from '../dist/stl/stl-manipulator.js';
import { studioRetargeter } from '../dist/tuning/retarget.js';
import { studioSlicer } from '../dist/tuning/prepare-slice.js';
import { comparePrintOrientations } from '../dist/workflows/orientations.js';
import { createCalibrationProject } from '../dist/workflows/calibration.js';
import { analyzePrintWaste } from '../dist/workflows/waste.js';
import { analyzeMeshHealth } from '../dist/workflows/mesh-health.js';
import { checkFilamentAvailability } from '../dist/workflows/inventory.js';
const root = fileURLToPath(new URL('../', import.meta.url));
const slicerPath = [process.env.SLICER_PATH, '/Applications/BambuStudio.app/Contents/MacOS/BambuStudio'].find(p => p && fsSync.existsSync(p));

test('real Studio CLI slices rotated and calibration projects and exposes analysis evidence', {
  skip: process.env.CI ? 'Installed Studio CLI is optional in CI' : !slicerPath ? 'Bambu Studio CLI absent' : false,
  timeout:300000,
}, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fatia-analysis-e2e-'));
  t.after(() => fs.rm(dir,{recursive:true,force:true}));
  const printerPreset = 'Bambu Lab X2D 0.4 nozzle', tempDir = path.join(dir,'work'), outputDir = path.join(dir,'outputs');
  const manipulator = new STLManipulator(tempDir);
  const retarget = studioRetargeter({slicerPath,tempDir,printerPreset,modelCode:'X2D',manipulator});
  const baseline = await retarget(path.join(root,'test/sample_cube.stl'));
  const file = path.join(dir,'cube.3mf'); await fs.writeFile(file,baseline.archive);
  const slice = studioSlicer({manipulator,slicerPath,printerPreset,modelCode:'X2D',plateIndex:0});
  const deps = {printerPreset,tempDir,outputDir,slice};
  const orientation = await comparePrintOrientations({path:file,orientations:[{name:'side',rotation_x:90}],max_slices:1},deps);
  assert.equal(orientation.orientations[0].status,'measured',JSON.stringify(orientation));
  assert.ok(orientation.orientations[0].time_s>0);
  const waste = await analyzePrintWaste({path:file});
  assert.equal(waste.complete,true);
  const stock = await checkFilamentAvailability({path:file,filaments:[{slot:1,available_g:1000}]});
  assert.equal(stock.status,'sufficient_estimate',JSON.stringify(stock));
  for (const [kind,value] of [['flow_ratio',.91],['temperature',210],['retraction',.6]]) {
    const result = await createCalibrationProject({path:file,kind,values:[value]},deps);
    const candidate = result.projects[0].output_path;
    const health = await analyzeMeshHealth({path:candidate});
    assert.ok(health.objects.every(o=>o.edge_closed && o.consistently_wound),JSON.stringify(health));
    const measured = await slice(candidate);
    assert.equal(measured.gcode.complete,true);
    const key = result.projects[0].setting;
    assert.equal(Number(measured.block[key]),value,`${kind}: effective G-code setting`);
    t.diagnostic(`${kind}: ${key}=${measured.block[key]}`);
  }
});
