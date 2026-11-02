import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import JSZip from 'jszip';
import {prepareProject} from '../dist/tuning/prepare.js';
import {parsePrepareArgs} from '../dist/tuning/prepare-tool.js';
const preset='Bambu Lab A1 0.4 nozzle';
async function fixture(t,extra={}) {
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatia-opt-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));const file=path.join(dir,'source.3mf');const z=new JSZip();
 z.file('Metadata/project_settings.config',JSON.stringify({printer_settings_id:preset,print_settings_id:'Process',filament_settings_id:['PLA'],print_extruder_id:['1'],print_extruder_variant:['Standard'],sparse_infill_pattern:'grid',sparse_infill_density:'10%',wall_loops:'2',top_shell_layers:'5',bottom_shell_layers:'3',layer_height:'0.2',outer_wall_speed:['200'],outer_wall_acceleration:['5000'],different_settings_to_system:['','',''],...extra}));
 z.file('Metadata/model_settings.config','<config><plate><metadata key="plater_id" value="1"/><model_instance><metadata key="object_id" value="1"/></model_instance></plate><plate><metadata key="plater_id" value="2"/><model_instance><metadata key="object_id" value="2"/></model_instance></plate></config>');z.file('3D/3dmodel.model','<model><resources/><build/></model>');await fs.writeFile(file,await z.generateAsync({type:'nodebuffer'}));
 const input={path:file,plateIndex:0,model:'a1',layout:{mode:'off'},maxSlices:12,maxMinutes:20,outputDir:path.join(dir,'outputs'),openInStudio:false,apply:'recommended',dryRun:false,optimization:{}};
 let calls=0;const deps={printerPreset:preset,tempDir:path.join(dir,'work'),tuning:{actions:[],noAction:[]},installedStudio:async()=> '2.8.4',preflight:async()=>({findings:[],unchecked:{total:0}}),openInStudio:async()=>{throw Error('No GUI')},slice:async()=>{throw Error('all-plate required')},sliceAll:async file=>{calls++;const z=await JSZip.loadAsync(await fs.readFile(file));const c=JSON.parse(await z.file('Metadata/project_settings.config').async('string'));const time=c.sparse_infill_pattern==='adaptivecubic'?80:100,weight=c.sparse_infill_pattern==='adaptivecubic'?8:10;return [1,2].map(plate=>({plate,time_s:time,weight_g:weight,crossing:0,warnings:[],gcode_complete:true,metrics:{},block:Object.fromEntries(Object.entries(c).map(([k,v])=>[k,Array.isArray(v)?v.join(';'):String(v)]))}));}};
 return {dir,file,input,deps,calls:()=>calls};
}
test('optimization parser is explicit, conservative and rejects unknown constraints',()=>{
 const a=parsePrepareArgs({path:'part.3mf',optimization:{}});assert.equal(a.optimization.objective,'balanced');assert.equal(a.optimization.allow_reorientation,false);
 assert.throws(()=>parsePrepareArgs({path:'part.3mf',optimization:{constraints:{made_up:1}}}),/constraint/i);
});
test('optimization measures all plates and selects balanced Pareto candidate without changing source',async t=>{
 const {file,input,deps,calls}=await fixture(t);const before=await fs.readFile(file);const r=await prepareProject(input,deps);
 assert.equal(r.optimization.objective,'balanced');assert.equal(r.optimization.selected,'settings-1');assert.equal(r.optimization.baseline.time_s,200);assert.equal(r.optimization.baseline.weight_g,20);assert.ok(r.delivered.path);assert.ok(await fs.stat(r.delivered.path));assert.equal(r.optimization.selected_estimates.time_s,160);assert.equal(r.stop.slices,calls());assert.deepEqual(await fs.readFile(file),before);
});
test('optimization preserves original floors and reports 3 percent ties as no improvement',async t=>{
 const {input,deps}=await fixture(t);input.optimization={candidates:[{name:'too thin',settings:{wall_loops:1}},{name:'too sparse',settings:{sparse_infill_density:8}}]};let calls=0;const original=deps.sliceAll;deps.sliceAll=async(...args)=>{calls++;return original(...args)};const r=await prepareProject(input,deps);assert.equal(calls,1);assert.equal(r.optimization.status,'no_improvement');assert.ok(r.optimization.candidates.filter(c=>c.kind!=='baseline').every(c=>!c.eligible));
});
test('optimization counts failed slice attempts and stops before exceeding global budget',async t=>{
 const {input,deps,calls}=await fixture(t);input.maxSlices=2;const original=deps.sliceAll;let attempts=0;deps.sliceAll=async(...args)=>{if(++attempts===2)throw Error('CLI failed');return original(...args)};const r=await prepareProject(input,deps);assert.equal(attempts,2);assert.equal(r.stop.slices,2);assert.equal(r.stop.reason,'budget_slices');assert.ok(r.optimization.candidates.some(c=>c.status==='error'));assert.ok(r.delivered.path);
});
test('optimization excludes incomplete plate coverage and missing metrics',async t=>{
 const {input,deps}=await fixture(t);deps.sliceAll=async()=>[{plate:1,time_s:100,weight_g:10,gcode_complete:true,block:{},metrics:{},warnings:[],crossing:0}];const r=await prepareProject(input,deps);assert.equal(r.delivered,null);assert.equal(r.optimization.selected,null);assert.equal(r.verdict,'not_ready');
});
test('cancellation during measurement or final preflight removes only owned outputs',async t=>{
 const {dir,input,deps}=await fixture(t);await fs.mkdir(input.outputDir);await fs.writeFile(path.join(input.outputDir,'keep'),'keep');const c=new AbortController();input.signal=c.signal;const measure=deps.sliceAll;deps.sliceAll=async(...args)=>{const r=await measure(...args);c.abort();return r};const r=await prepareProject(input,deps);assert.equal(r.stop.reason,'cancelled');assert.equal(r.delivered,null);assert.deepEqual(await fs.readdir(input.outputDir),['keep']);
});
test('global budget includes retarget and failed attempts but not export-only work',async t=>{
 const f=await fixture(t);const z=await JSZip.loadAsync(await fs.readFile(f.file));const c=JSON.parse(await z.file('Metadata/project_settings.config').async('string'));c.printer_settings_id='Foreign';z.file('Metadata/project_settings.config',JSON.stringify(c));await fs.writeFile(f.file,await z.generateAsync({type:'nodebuffer'}));let reservations=0;
 f.deps.retarget=async(file,context)=>{context.beforeSlice();reservations++;const z=await JSZip.loadAsync(await fs.readFile(file));const c=JSON.parse(await z.file('Metadata/project_settings.config').async('string'));c.printer_settings_id=preset;z.file('Metadata/project_settings.config',JSON.stringify(c));return {archive:await z.generateAsync({type:'nodebuffer'}),report:null,slices:1};};f.input.maxSlices=2;const r=await prepareProject(f.input,f.deps);assert.equal(reservations,1);assert.equal(f.calls(),1);assert.equal(r.stop.slices,2);assert.ok(r.delivered.path);
});
test('global time budget cancels the running all-plate slicer',async t=>{
 const {input,deps}=await fixture(t);let now=0;deps.now=()=>now;deps.sliceAll=async()=>{now=61000;return [{plate:1,time_s:1,weight_g:1,gcode_complete:true,block:{},metrics:{},warnings:[],crossing:0}]};input.maxMinutes=1;const r=await prepareProject(input,deps);assert.equal(r.stop.reason,'budget_minutes');assert.equal(r.stop.slices,1);assert.equal(r.delivered,null);
});
test('protected settings must be verified in actual G-code, not just saved JSON',async t=>{
 const {input,deps}=await fixture(t);const all=deps.sliceAll;deps.sliceAll=async(...a)=>(await all(...a)).map(p=>({...p,block:{...p.block,outer_wall_speed:'900'}}));const r=await prepareProject(input,deps);assert.equal(r.delivered,null);assert.ok(r.optimization.candidates.every(c=>!c.eligible));
});
test('three-percent ties prefer the original and explicit floors permit bounded economy',async t=>{
 const {input,deps}=await fixture(t);const all=deps.sliceAll;deps.sliceAll=async(...a)=>(await all(...a)).map(p=>({...p,time_s:p.time_s===80?98:100,weight_g:p.weight_g===8?9.8:10}));let r=await prepareProject(input,deps);assert.equal(r.optimization.selected,'baseline');
 input.optimization={constraints:{min_infill_density:8},candidates:[{name:'declared floor',settings:{sparse_infill_density:8}}]};deps.sliceAll=async file=>{const rows=await all(file);const z=await JSZip.loadAsync(await fs.readFile(file));const cfg=JSON.parse(await z.file('Metadata/project_settings.config').async('string'));return rows.map(p=>({...p,weight_g:cfg.sparse_infill_density==='8%'?5:10}))};r=await prepareProject(input,deps);assert.equal(r.optimization.selected,'settings-1');
});
test('dry-run creates no delivered files and cleans scratch',async t=>{
 const {input,deps,dir,calls}=await fixture(t);input.dryRun=true;const r=await prepareProject(input,deps);assert.equal(r.stop.reason,'dry_run');assert.equal(calls(),0);assert.deepEqual(await fs.readdir(deps.tempDir),[]);
});
test('final cancellation and source tampering cannot deliver or open GUI',async t=>{
 const f=await fixture(t);const c=new AbortController();f.input.signal=c.signal;f.input.openInStudio=true;let opened=0;f.deps.openInStudio=async()=>{opened++};let checks=0;f.deps.preflight=async()=>{if(++checks===2)c.abort();return {findings:[]}};let r=await prepareProject(f.input,f.deps);assert.equal(r.delivered,null);assert.equal(opened,0);
 const g=await fixture(t);const all=g.deps.sliceAll;g.deps.sliceAll=async(...a)=>{const rows=await all(...a);await fs.appendFile(g.file,'tampered');return rows};await assert.rejects(prepareProject(g.input,g.deps),/Source changed/);
});
test('layout measurements share the global budget and cannot spend a separate allowance',async t=>{
 const {buildLayoutProject,x2dConfig,X2D}=await import('./fixtures/layout-project.mjs');const {openProject,asArray,meta}=await import('../dist/knowledge/facts/settings.js');const f=await fixture(t);await fs.writeFile(f.file,await buildLayoutProject({objects:[{id:2,name:'A',size:[20,20,20],at:[100,100]},{id:4,name:'B',size:[20,20,20],at:[407.2,100]}],plates:[['2:0'],['4:0']],config:x2dConfig({sparse_infill_density:'10%'})}));f.input.layout={mode:'auto',maxSlices:20};f.input.model='x2d';f.input.maxSlices=3;f.deps.printerPreset=X2D;let calls=0;f.deps.sliceAll=async file=>{calls++;const p=await openProject(file);return asArray(p.modelSettings.plate).filter(p=>asArray(p.model_instance).length).map(plate=>({plate:Number(meta(plate,'plater_id')),time_s:100,weight_g:10,crossing:0,warnings:[],gcode_complete:true,metrics:{},block:Object.fromEntries(Object.entries(p.config).map(([k,v])=>[k,Array.isArray(v)?v.join(';'):String(v)]))}));};const r=await prepareProject(f.input,f.deps);assert.ok(calls<=3);assert.equal(r.stop.slices,calls);assert.ok(r.layout);assert.equal(r.stop.reason,'budget_slices');
});
test('authorized target reorientation integrates all-plate measurements and produces combined candidates',async t=>{
 const {buildLayoutProject,x2dConfig,X2D}=await import('./fixtures/layout-project.mjs');const {openProject}=await import('../dist/knowledge/facts/settings.js');const f=await fixture(t);await fs.writeFile(f.file,await buildLayoutProject({objects:[{id:2,name:'Target',size:[10,15,20],at:[100,100]}],plates:[['2:0']],config:x2dConfig({sparse_infill_density:'10%'})}));f.input.model='x2d';f.input.maxSlices=10;f.input.optimization={allow_reorientation:true,targets:[{plate_index:0,item_index:0}],candidates:[{name:'adaptive',settings:{sparse_infill_pattern:'adaptivecubic'}}]};f.deps.printerPreset=X2D;let calls=0;f.deps.sliceAll=async file=>{calls++;const p=await openProject(file);const n=path.basename(file);return [{plate:1,time_s:n.startsWith('orientation')?70:n.startsWith('combined')?60:n.startsWith('settings')?90:100,weight_g:10,crossing:0,warnings:[],gcode_complete:true,metrics:{},block:Object.fromEntries(Object.entries(p.config).map(([k,v])=>[k,Array.isArray(v)?v.join(';'):String(v)]))}];};const r=await prepareProject(f.input,f.deps);assert.ok(r.optimization.candidates.some(c=>c.kind==='orientation'&&c.eligible),JSON.stringify(r.optimization));assert.equal(r.optimization.selected,'combined');assert.equal(r.stop.slices,calls);
});
test('retargeting cannot silently drop the original variable layer profile',async t=>{
 const f=await fixture(t);const z=await JSZip.loadAsync(await fs.readFile(f.file));z.file('Metadata/layer_heights_profile.txt','object_id=1|0.0;0.2;');const c=JSON.parse(await z.file('Metadata/project_settings.config').async('string'));c.printer_settings_id='Foreign';z.remove('Metadata/project_settings.config');await fs.writeFile(f.file,await z.generateAsync({type:'nodebuffer'}));f.deps.retarget=async()=>{const q=await JSZip.loadAsync(await fs.readFile(f.file));q.remove('Metadata/layer_heights_profile.txt');c.printer_settings_id=preset;q.file('Metadata/project_settings.config',JSON.stringify(c));return {archive:await q.generateAsync({type:'nodebuffer'}),report:null,slices:0}};const r=await prepareProject(f.input,f.deps);assert.equal(r.delivered,null);assert.ok(r.optimization.candidates.every(c=>c.ineligible_reasons.some(r=>r.includes('layer_profile'))));
});
test('ineligible baseline remains a measured reference for stricter explicit constraints',async t=>{
 const f=await fixture(t);f.input.optimization={constraints:{min_wall_loops:3},candidates:[{name:'three walls',settings:{wall_loops:3}}]};const r=await prepareProject(f.input,f.deps);assert.equal(r.optimization.baseline.time_s,200);assert.equal(r.optimization.candidates[0].eligible,false);assert.equal(r.optimization.selected,'settings-1');assert.ok(r.delivered.path);
});
test('preflight receives the shared cancellation signal',async t=>{
 const f=await fixture(t);let received;f.deps.preflight=async(a,signal)=>{received=signal;return {findings:[]}};await prepareProject(f.input,f.deps);assert.ok(received instanceof AbortSignal);
});
test('failed Studio opening preserves verified output and records a warning',async t=>{
 const f=await fixture(t);f.input.openInStudio=true;f.deps.openInStudio=async()=>{throw Error('launch failed')};const r=await prepareProject(f.input,f.deps);assert.equal(r.delivered.opened_in_studio,false);assert.ok(await fs.stat(r.delivered.path));assert.ok(r.warnings.some(w=>w.includes('launch failed')));
});
test('orientation target follows its stable instance after automatic plate consolidation',async t=>{
 const {buildLayoutProject,x2dConfig,X2D}=await import('./fixtures/layout-project.mjs');const {openProject,asArray,meta}=await import('../dist/knowledge/facts/settings.js');const f=await fixture(t);await fs.writeFile(f.file,await buildLayoutProject({objects:[{id:2,name:'A',size:[10,15,20],at:[100,100]},{id:4,name:'Target',size:[10,15,20],at:[407.2,100]}],plates:[['2:0'],['4:0']],config:x2dConfig({sparse_infill_density:'10%'})}));f.input.model='x2d';f.input.layout={mode:'auto',marginMm:30,gapMm:30};f.input.maxSlices=12;f.input.optimization={allow_reorientation:true,targets:[{plate_index:1,item_index:1}],candidates:[{name:'same',settings:{wall_loops:2}}]};f.deps.printerPreset=X2D;f.deps.sliceAll=async file=>{const p=await openProject(file);return asArray(p.modelSettings.plate).filter(p=>asArray(p.model_instance).length).map(plate=>({plate:Number(meta(plate,'plater_id')),time_s:100,weight_g:10,crossing:0,warnings:[],gcode_complete:true,metrics:{},block:Object.fromEntries(Object.entries(p.config).map(([k,v])=>[k,Array.isArray(v)?v.join(';'):String(v)]))}));};const r=await prepareProject(f.input,f.deps);assert.ok(r.optimization.candidates.some(c=>c.kind==='orientation'&&c.eligible),JSON.stringify(r));assert.ok(r.optimization.candidates.filter(c=>c.kind==='orientation'&&c.eligible).every(c=>c.orientation.steps[0].plate_index===0));
});
test('known baseline blockers exclude delivery without preventing eligible alternatives',async t=>{
 const f=await fixture(t);f.input.optimization={candidates:[{name:'three walls',settings:{wall_loops:3}}]};f.deps.preflight=async({file_path})=>({findings:path.basename(file_path)==='baseline.3mf'?[{severity:'blocker',message:'baseline only'}]:[]});const r=await prepareProject(f.input,f.deps);assert.equal(r.optimization.candidates[0].eligible,false);assert.equal(r.optimization.baseline.time_s,200);assert.equal(r.optimization.selected,'settings-1');
});
test('cancellation reaches an in-flight preflight and removes owned artifacts',async t=>{
 const f=await fixture(t);const controller=new AbortController();f.input.signal=controller.signal;f.deps.preflight=async(a,signal)=>{assert.ok(signal);return new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(signal.reason),{once:true});queueMicrotask(()=>controller.abort(Error('stop preflight')));})};const r=await prepareProject(f.input,f.deps);assert.equal(r.stop.reason,'cancelled');assert.equal(r.delivered,null);
});
