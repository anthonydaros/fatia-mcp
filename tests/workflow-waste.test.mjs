import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { analyzePrintWaste, WASTE_TOOLS } from '../dist/workflows/waste.js';

function gcode(extra=[],complete=true) { return ['; CONFIG_BLOCK_START','; filament_map = 1','; filament_diameter = 1.75','; filament_density = 1.26','; retraction_minimum_travel = 1','; enable_support = 0','; enable_prime_tower = 0','; brim_type = no_brim','; CONFIG_BLOCK_END','; EXECUTABLE_BLOCK_START','M83','G90','; MACHINE_START_GCODE_END','; CHANGE_LAYER','; Z_HEIGHT: 0.2','; LAYER_HEIGHT: 0.2','G1 Z0.2','; FEATURE: Outer wall','; LINE_WIDTH: 0.42','G1 X10 Y0 E1 F1200',...extra,...(complete?['; MACHINE_END_GCODE_START','; EXECUTABLE_BLOCK_END']:[])].join('\n')+'\n'; }
async function workspace(t){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatia-waste-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir;}
test('single-filament complete scan gives role weights without double counting',async t=>{
 const dir=await workspace(t),file=path.join(dir,'part.gcode');await fs.writeFile(file,gcode());const before=await fs.readFile(file);const r=await analyzePrintWaste({path:file});assert.equal(WASTE_TOOLS[0].name,'analyze_print_waste');assert.equal(r.complete,true);assert.ok(r.weights_g.part>0);assert.equal(r.weights_g.support,0);assert.equal(r.weights_g.prime_tower,0);assert.equal(r.weights_g.purge,0);assert.equal(r.total_waste_g,0);assert.equal(r.waste_percentage,0);assert.deepEqual(await fs.readFile(file),before);
});
test('unvalidated purge commands stay estimates and prevent exact total/percentage',async t=>{
 const dir=await workspace(t),file=path.join(dir,'part.gcode');await fs.writeFile(file,gcode(['M620.10 A0 L10','M620.10 A1 L10']));const r=await analyzePrintWaste({path:file});assert.equal(r.weights_g.purge,null);assert.ok(r.purge_estimate_g>0);assert.equal(r.total_waste_g,null);assert.equal(r.waste_percentage,null);assert.match(r.unknown.join(' '),/purge/i);
});
test('partial files never claim full-file role weights or waste percentages',async t=>{
 const dir=await workspace(t),file=path.join(dir,'part.gcode');await fs.writeFile(file,gcode([],false));const r=await analyzePrintWaste({path:file});assert.equal(r.complete,false);assert.equal(r.weights_g.part,null);assert.equal(r.total_waste_g,null);assert.equal(r.waste_percentage,null);assert.ok(r.observed_features['Outer wall'].weight_g>0);
});
test('3MF selection uses safe archive reader and missing plate errors',async t=>{
 const dir=await workspace(t),file=path.join(dir,'part.3mf'),zip=new JSZip();zip.file('Metadata/plate_1.gcode',gcode());await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));assert.equal((await analyzePrintWaste({path:file})).complete,true);await assert.rejects(analyzePrintWaste({path:file,plate_index:1}));zip.file('metadata/PLATE_1.GCODE','collision');await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));await assert.rejects(analyzePrintWaste({path:file}),/collid|duplicate/i);
 const c=new AbortController();c.abort();await assert.rejects(analyzePrintWaste({path:file},c.signal),/abort/i);await assert.rejects(analyzePrintWaste({path:file,plate_index:NaN}),/plate_index/i);
});
test('support interface is counted once and unknown Custom extrusion prevents a precise breakdown',async t=>{
 const dir=await workspace(t),file=path.join(dir,'part.gcode');await fs.writeFile(file,gcode(['; FEATURE: Support interface','G1 X20 Y0 E1','; FEATURE: Prime tower','G1 X30 Y0 E1']));let r=await analyzePrintWaste({path:file});assert.ok(r.weights_g.support>0);assert.ok(r.weights_g.prime_tower>0);assert.equal(r.total_waste_g,r.weights_g.support+r.weights_g.prime_tower);assert.ok(r.waste_percentage>60 && r.waste_percentage<70);
 await fs.writeFile(file,gcode(['; FEATURE: Custom','G1 X20 Y0 E1']));r=await analyzePrintWaste({path:file});assert.equal(r.weights_g.part,null);assert.equal(r.total_waste_g,null);assert.match(r.unknown.join(' '),/Custom/);
});
