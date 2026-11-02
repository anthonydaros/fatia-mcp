import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { asArray, meta, openProject, plateInstances } from '../knowledge/facts/settings.js';
import { readBoundedPrintFile, loadSafe3mfArchive } from '../safety/archive.js';
import { readProjectMesh, type Soup } from '../tuning/mesh-read.js';
import { meshFactsFromRead } from '../tuning/mesh-facts.js';
import { writeTunedProject } from '../tuning/project-writer.js';
import { spliceItemTransforms, STALE_IMAGE } from '../tuning/layout-writer.js';
import { dropRelationships } from '../tuning/project-text.js';
import { sliceFacts } from '../tuning/slice-facts.js';
import { requireMillimeters } from './geometry.js';
import {geometryFromConfig,readLayoutModel,plateRect,binFor,plateOrigin,gapBetween} from '../tuning/layout.js';
import {setImmediate} from 'node:timers/promises';
import type { ScenarioDeps } from './scenarios.js';

const rotationProperty = { type: 'number', minimum: -360, maximum: 360, default: 0, description: 'Rotation about this world axis, in degrees; default 0.' };
export const ORIENTATION_TOOLS: Tool[] = [{
  name: 'compare_print_orientations',
  description: 'Compare up to six world-space rotations of one selected printable build item in a printer-compatible multi-plate 3MF. Preserves paint, modifiers and settings; rests each candidate on the bed and slices within explicit budgets. Returns separate unsliced projects and estimated time/material, support and geometric bed-contact evidence. No physical strength or quality guarantee; prepare STL or another printer first.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['path'], properties: {
    plate_index:{type:'integer',minimum:0,maximum:999,description:'Zero-based target plate; default0. Other plates remain unchanged.'},
    item_index:{type:'integer',minimum:0,description:'Global build-item index from the object list. Required when selected plate has several printable items.'},
    allow_move_xy:{type:'boolean',description:'Explicit permission to move only the target in XY if the current center is infeasible; defaultfalse.'},
    search:{type:'string',enum:['orthogonal','sampled'],description:'orthogonal(default) or bounded deterministic256-direction surface search. Cannot combine with explicitorientations.'},
    path: { type: 'string', minLength: 1, description: 'Existing compatible 3MF; select plate_index and item_index for projects with several objects.' },
    bambu_model: { type: 'string', description: 'Selected printer model, otherwise BAMBU_MODEL or elicitation.' },
    orientations: { type: 'array', minItems: 1, maxItems: 6, description: 'World rotations applied X then Y then Z, in degrees. Defaults to the six orthogonal sides.', items: { type: 'object', additionalProperties: false, required: ['name'], properties: { name: { type: 'string', minLength: 1, maxLength: 80 }, rotation_x: rotationProperty, rotation_y: rotationProperty, rotation_z: rotationProperty } } },
    max_slices: { type: 'integer', minimum: 1, maximum: 6, default: 6, description: 'Maximum CLI attempts, including failures.' },
    max_minutes: { type: 'number', minimum: .1, maximum: 60, default: 10, description: 'Wall-clock budget in minutes, including writing and slicing.' },
  } },
}];
export type Rotation = { name: string; rotation_x: number; rotation_y: number; rotation_z: number };
const defaults = [{ name: 'original' }, { name: 'x-90', rotation_x: 90 }, { name: 'x-180', rotation_x: 180 }, { name: 'x-270', rotation_x: 270 }, { name: 'y-90', rotation_y: 90 }, { name: 'y-270', rotation_y: 270 }];
const hash = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
function range(value: unknown, fallback: number, min: number, max: number, key: string, integer = false): number {
  const n = value === undefined ? fallback : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw Error(`${key} must be ${min}..${max}${integer ? ' integer' : ' finite'}`);
  return n;
}
function rotate(v: number[], r: Rotation): number[] {
  let [x, y, z] = v;
  for (const [axis, deg] of [[0, r.rotation_x], [1, r.rotation_y], [2, r.rotation_z]]) {
    const angle = deg * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
    if (axis === 0) [y, z] = [y * c - z * s, y * s + z * c];
    if (axis === 1) [x, z] = [x * c + z * s, -x * s + z * c];
    if (axis === 2) [x, y] = [x * c - y * s, x * s + y * c];
  }
  return [x, y, z];
}
function bounds(soup: Soup, r?: Rotation) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const i of soup.idx) {
    const xyz = Array.from(soup.pos.subarray(i * 3, i * 3 + 3));
    const v = r ? rotate(xyz, r) : xyz;
    for (let j = 0; j < 3; j++) { lo[j] = Math.min(lo[j], v[j]); hi[j] = Math.max(hi[j], v[j]); }
  }
  return { lo, hi };
}

export interface OrientationCandidateOptions {plateIndex:number;itemIndex?:number;rotation:Rotation;allowMoveXY?:boolean}
async function orientationTarget(source:string,plate:number,index?:number){
 const project=await openProject(source),plates=asArray(project.modelSettings?.plate),matching=plates.filter(p=>Number(meta(p,'plater_id'))===plate+1),members=plateInstances(project.modelSettings,plate);
 if(matching.length!==1||!members?.length||members.some(k=>!/^\d+:\d+$/.test(k))||new Set(members).size!==members.length)throw Error('Plate membership is missing or ambiguous');
 if(['true','1'].includes(String(meta(matching[0],'locked'))))throw Error('Cannot rotate a locked plate');
 for(const name of(project.names??[]).filter(n=>n.toLowerCase().endsWith('.model'))){const b=await project.read!(name);if(b)requireMillimeters(b);}
 const mesh=await readProjectMesh(project,null),here=mesh.objects.filter(o=>members.includes(`${o.objectId}:${o.instance}`));
 for(const object of mesh.objects)if(plates.filter(p=>plateInstances(project.modelSettings,Number(meta(p,'plater_id'))-1)?.includes(`${object.objectId}:${object.instance}`)).length!==1)throw Error('Only one printable plate assignment per item is supported; membership is ambiguous');
 if(here.length!==members.length)throw Error('Plate membership contains missing or non-printable geometry');
 const item=index===undefined?(here.length===1?here[0]:undefined):here.find(o=>o.itemIndex===index);
 if(!item)throw Error('Select item_index: one printable target instance on this plate is required');
 if(!item.soup.pos.every(Number.isFinite))throw Error('World geometry must contain finite coordinates');
 return{project,plates,mesh,item};
}
export async function writeOrientationCandidate(source:string,output:string,options:OrientationCandidateOptions,signal?:AbortSignal):Promise<Record<string,any>>{
 signal?.throwIfAborted();
 const sourceHash=hash(await readBoundedPrintFile(source));
 const {project,plates,mesh,item}=await orientationTarget(source,options.plateIndex,options.itemIndex),r=options.rotation;
 for(const value of[r.rotation_x,r.rotation_y,r.rotation_z])if(!Number.isFinite(value)||Math.abs(value)>360)throw Error('Rotation must be finite -360..360degrees');
 const original=bounds(item.soup),rotated=bounds(item.soup,r),center=[0,1].map(i=>original.lo[i]/2+original.hi[i]/2);
 const offset=[center[0]-(rotated.lo[0]/2+rotated.hi[0]/2),center[1]-(rotated.lo[1]/2+rotated.hi[1]/2),-rotated.lo[2]];
 if(![...rotated.lo,...rotated.hi,...offset].every(Number.isFinite))throw Error('Rotated geometry must contain finite coordinates');
 const geo=geometryFromConfig(project.config??{}),layout=await readLayoutModel(project);
 const target=layout.objects.find(o=>o.itemIndex===item.itemIndex)!;
 const makeBox=()=>({x0:rotated.lo[0]+offset[0],y0:rotated.lo[1]+offset[1],x1:rotated.hi[0]+offset[0],y1:rotated.hi[1]+offset[1],z0:0,z1:rotated.hi[2]-rotated.lo[2]});
 let box=makeBox();
 if(!geo&&mesh.objects.length>1)throw Error('Target bed geometry is required for multi-item orientation');
 if(geo){
  if(plates.some((p,i)=>Number(meta(p,'plater_id'))!==i+1))throw Error('Non-contiguous plate grid is ambiguous');
  const bed=plateRect(options.plateIndex,plates.length,geo),nozzle=binFor(target.slots,geo),origin=plateOrigin(options.plateIndex,plates.length,geo);
  const limits={x0:Math.max(bed.x0,nozzle.rect.x0+origin.x)+5,y0:Math.max(bed.y0,nozzle.rect.y0+origin.y)+5,x1:Math.min(bed.x1,nozzle.rect.x1+origin.x)-5,y1:Math.min(bed.y1,nozzle.rect.y1+origin.y)-5};
  const neighbours=layout.objects.filter(o=>o.itemIndex!==item.itemIndex&&o.plates.includes(options.plateIndex));
  const gap=Math.max(8,2*(Number(project.config?.brim_width)||0)+2);
  const feasible=(b:typeof box)=>b.x0>=limits.x0-1e-6&&b.y0>=limits.y0-1e-6&&b.x1<=limits.x1+1e-6&&b.y1<=limits.y1+1e-6&&b.z1<=nozzle.height&&neighbours.every(o=>gapBetween(b,o.box)>=gap-1e-6);
  if(!feasible(box)&&options.allowMoveXY){
   const w=box.x1-box.x0,d=box.y1-box.y0,positions:number[][]=[];
   const step=Math.max(5,Math.ceil(Math.max(limits.x1-limits.x0,limits.y1-limits.y0)/99));
   for(let ix=0;ix<100;ix++)for(let iy=0;iy<100;iy++){const x=limits.x0+ix*step,y=limits.y0+iy*step;if(x+w<=limits.x1+1e-6&&y+d<=limits.y1+1e-6)positions.push([x,y]);}
   positions.sort((a,b)=>((a[0]+w/2-center[0])**2+(a[1]+d/2-center[1])**2)-((b[0]+w/2-center[0])**2+(b[1]+d/2-center[1])**2)||a[0]-b[0]||a[1]-b[1]);
   const point=positions.find(([x,y])=>feasible({...box,x0:x,y0:y,x1:x+w,y1:y+d}));
   if(point){offset[0]+=point[0]-box.x0;offset[1]+=point[1]-box.y0;box=makeBox();}
  }
  if(!feasible(box))throw Error('Orientation violates target bed/nozzle bounds or neighbour clearance');
 }
 signal?.throwIfAborted();
 const prepared=await writeTunedProject({source,output,target:{printerPreset:String(project.config?.printer_settings_id)},changes:[]});
 try{
  const zip=await loadSafe3mfArchive(await readBoundedPrintFile(prepared.path));
  const model=await zip.file('3D/3dmodel.model')!.async('string');
  zip.file('3D/3dmodel.model',spliceItemTransforms(model,new Map([[item.itemIndex!,{objectId:item.objectId!,move:tokens=>{
   const values=tokens.map(Number),next:number[]=[];if(values.length!==12||!values.every(Number.isFinite))throw Error('Invalid build transform');
   for(let i=0;i<12;i+=3)next.push(...rotate(values.slice(i,i+3),r).map((n,a)=>n+(i===9?offset[a]:0)));
   if(!next.every(Number.isFinite))throw Error('Rotated transform must contain finite coordinates');return next.map(n=>String(Number(n.toPrecision(14))));
  }}]])));
  const n=options.plateIndex+1,dropped=new Set(Object.keys(zip.files).filter(name=>new RegExp(`^Metadata/(?:plate|plate_no_light|top|pick)_${n}(?:_small)?\\.png$`).test(name)||name==='Metadata/thumbnail.png'));
  for(const name of dropped)zip.remove(name);
  let metadata=await zip.file('Metadata/model_settings.config')!.async('string');
  metadata=metadata.replace(/<plate\b[^>]*>[\s\S]*?<\/plate>/g,block=>new RegExp(`key="plater_id"\\s+value="${n}"`).test(block)?block.replace(/<metadata\s+key="(?:thumbnail_file|thumbnail_no_light_file|top_file|pick_file)"[^>]*\/>/g,''):block);
  zip.file('Metadata/model_settings.config',metadata);
  for(const name of Object.keys(zip.files).filter(n=>n.endsWith('.rels'))){const original=await zip.file(name)!.async('string'),next=dropRelationships(original,dropped);if(next===undefined)zip.remove(name);else if(next!==original)zip.file(name,next);}
  await fs.writeFile(prepared.path,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));
  const verified=await readProjectMesh(await openProject(prepared.path),null);
  if(verified.objects.length!==mesh.objects.length)throw Error('Orientation changed object count');
  for(const before of mesh.objects){
   const after=verified.objects.find(o=>o.itemIndex===before.itemIndex);if(!after||after.soup.pos.length!==before.soup.pos.length||after.soup.idx.length!==before.soup.idx.length)throw Error('Rotated geometry verification failed');
   if(!after.soup.idx.every((v,i)=>v===before.soup.idx[i]))throw Error('Orientation changed triangle topology');
   for(let i=0;i<before.soup.pos.length;i+=3){const expected=before.itemIndex===item.itemIndex?rotate(Array.from(before.soup.pos.subarray(i,i+3)),r).map((v,a)=>v+offset[a]):Array.from(before.soup.pos.subarray(i,i+3));if(expected.some((v,a)=>!Number.isFinite(after.soup.pos[i+a])||Math.abs(v-after.soup.pos[i+a])>1e-6))throw Error('Orientation changed non-target geometry or failed its transform proof');}
  }
  signal?.throwIfAborted();
  const selected=verified.objects.find(o=>o.itemIndex===item.itemIndex)!;
  const geometry=meshFactsFromRead({objects:[selected],triangles:selected.soup.idx.length/3},{signal});
  if(hash(await readBoundedPrintFile(source))!==sourceHash)throw Error('Source changed during orientation writing');
  return{path:prepared.path,source_sha256:sourceHash,item_index:item.itemIndex,plate_index:options.plateIndex,rotation:r,contact_area_mm2:geometry.facts['mesh.flat_bottom_area_mm2']??null,contact_evidence:geometry.evidence['mesh.flat_bottom_area_mm2'],placement:{bounds_mm:box,moved_xy:Math.abs(offset[0]-(center[0]-(rotated.lo[0]/2+rotated.hi[0]/2)))>1e-6||Math.abs(offset[1]-(center[1]-(rotated.lo[1]/2+rotated.hi[1]/2)))>1e-6}};
 }catch(error){await fs.rm(prepared.path,{force:true});throw error;}
}
export async function orientationRotations(source:string,plateIndex:number,itemIndex:number|undefined,search:'orthogonal'|'sampled',signal?:AbortSignal):Promise<Rotation[]>{
 if(search==='orthogonal')return defaults.map(r=>({name:r.name,rotation_x:('rotation_x'in r?r.rotation_x:0)??0,rotation_y:('rotation_y'in r?r.rotation_y:0)??0,rotation_z:0}));
 const{item}=await orientationTarget(source,plateIndex,itemIndex),{pos,idx}=item.soup;
 const sample:Array<{normal:number[];center:number[];area:number}>=[];const stride=Math.max(1,Math.ceil(idx.length/3/20000));
 for(let t=0;t<idx.length/3;t+=stride){if(t%(stride*4096)===0){await setImmediate();signal?.throwIfAborted();}const points=[0,1,2].map(j=>Array.from(pos.subarray(idx[t*3+j]*3,idx[t*3+j]*3+3))),[a,b,c]=points,u=b.map((v,i)=>v-a[i]),v=c.map((v,i)=>v-a[i]);const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],area=Math.hypot(...normal);if(area>0)sample.push({normal:normal.map(n=>n/area),center:a.map((v,i)=>(v+b[i]+c[i])/3),area});}
 const candidates:Array<{rotation:Rotation;score:number;direction:number[]}>=[];
 for(let i=0;i<256;i++){if(i%16===0){await setImmediate();signal?.throwIfAborted();}const z=1-2*(i+.5)/256,theta=i*Math.PI*(3-Math.sqrt(5)),radius=Math.sqrt(1-z*z),n=[radius*Math.cos(theta),radius*Math.sin(theta),z];let area=0,down=0,lo=Infinity,hi=-Infinity;for(const triangle of sample){area+=triangle.area;down+=Math.max(0,-triangle.normal.reduce((s,v,a)=>s+v*n[a],0))*triangle.area;const h=triangle.center.reduce((s,v,a)=>s+v*n[a],0);lo=Math.min(lo,h);hi=Math.max(hi,h);}candidates.push({direction:n,rotation:{name:`sample-${i}`,rotation_x:Math.atan2(n[1],n[2])*180/Math.PI,rotation_y:-Math.atan2(n[0],Math.hypot(n[1],n[2]))*180/Math.PI,rotation_z:0},score:down/(area||1)+(hi-lo)*1e-5});}
 candidates.sort((a,b)=>a.score-b.score||a.rotation.name.localeCompare(b.rotation.name));
 const directions=[[0,0,1]],selected:Rotation[]=[];for(const candidate of candidates){if(directions.some(d=>d.reduce((sum,v,a)=>sum+v*candidate.direction[a],0)>.96))continue;directions.push(candidate.direction);selected.push(candidate.rotation);if(selected.length===5)break;}
 return[{name:'original',rotation_x:0,rotation_y:0,rotation_z:0},...selected];
}

export async function comparePrintOrientations(args: Record<string, unknown>, deps: ScenarioDeps): Promise<Record<string, any>> {
  if (typeof args.path !== 'string' || !args.path.toLowerCase().endsWith('.3mf')) throw Error('path must be a printer-compatible 3MF; prepare STL first');
  const plate=range(args.plate_index,0,0,999,'plate_index',true);
  if(args.item_index!==undefined)range(args.item_index,0,0,9999,'item_index',true);
  if(args.allow_move_xy!==undefined&&typeof args.allow_move_xy!=='boolean')throw Error('allow_move_xy must be boolean');
  if(args.search!==undefined&&!['orthogonal','sampled'].includes(String(args.search)))throw Error('Invalid orientation search');
  if(args.search!==undefined&&args.orientations!==undefined)throw Error('Supply orientations or search, not both');
  const max = range(args.max_slices, 6, 1, 6, 'max_slices', true), minutes = range(args.max_minutes, 10, .1, 60, 'max_minutes');
  const now=deps.now??Date.now,started=now();
  const controller = new AbortController(), abort = () => controller.abort(deps.signal?.reason);
  deps.signal?.addEventListener('abort', abort, { once: true }); if (deps.signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(Error('Orientation time budget exhausted')), minutes * 60000); timer.unref();
  let work='',delivered='';
  try {
  const raw = args.orientations ?? (args.search==='sampled'?await orientationRotations(args.path,plate,args.item_index as number|undefined,'sampled',controller.signal):defaults);
  if (!Array.isArray(raw) || !raw.length || raw.length > 6) throw Error('orientations must contain 1..6 rotations');
  const rotations = raw.map((r: any): Rotation => {
    if (!r || typeof r !== 'object' || typeof r.name !== 'string' || !r.name.trim() || r.name.length > 80) throw Error('orientation name must contain 1..80 characters');
    return { name: r.name, rotation_x: range(r.rotation_x, 0, -360, 360, 'rotation_x'), rotation_y: range(r.rotation_y, 0, -360, 360, 'rotation_y'), rotation_z: range(r.rotation_z, 0, -360, 360, 'rotation_z') };
  });
  if (new Set(rotations.map(r => r.name)).size !== rotations.length) throw Error('orientation names must be unique');

  deps.signal?.throwIfAborted();
  const before = hash(await readBoundedPrintFile(args.path));
  const project = await openProject(args.path);
  if (project.config?.printer_settings_id !== deps.printerPreset) throw Error('Project must already match selected printer; run prepare_print_project first');
  await orientationTarget(args.path,plate,args.item_index as number|undefined);
  deps.signal?.throwIfAborted();
  await fs.mkdir(deps.tempDir, { recursive: true }); await fs.mkdir(deps.outputDir, { recursive: true });
  work = await fs.mkdtemp(path.join(path.resolve(deps.tempDir), 'orientation-work-'));
  delivered = await fs.mkdtemp(path.join(path.resolve(deps.outputDir), 'orientations-'));

  let slices = 0, stop = 'done';
  const records: Array<Record<string, any>> = [];
  const stopped = () => deps.signal?.aborted ? 'cancelled' : controller.signal.aborted || now() - started >= minutes * 60000 ? 'budget_minutes' : slices >= max ? 'budget_slices' : undefined;
  try {
    for (const [id, r] of rotations.entries()) {
      const record: Record<string, any> = { orientation_id: id, ...r, status: 'not_run', time_s: null, weight_g: null, support_weight_g: null, contact_area_mm2: null };
      records.push(record); const why = stopped(); if (why) { stop = why; continue; }
      try {
        const written=await writeOrientationCandidate(args.path,path.join(work,`orientation-${id}.3mf`),{plateIndex:plate,itemIndex:args.item_index as number|undefined,rotation:r,allowMoveXY:args.allow_move_xy===true},controller.signal);
        const candidate=written.path;
        record.contact_area_mm2=written.contact_area_mm2;record.contact_evidence=written.contact_evidence;
        record.item_index=written.item_index;record.placement=written.placement;
        const beforeSlice = stopped(); if (beforeSlice) { stop = beforeSlice; continue; }
        slices++; const outcome = await deps.slice(candidate, controller.signal, plate);
        if (deps.signal?.aborted || controller.signal.aborted || now() - started >= minutes * 60000) { stop = deps.signal?.aborted ? 'cancelled' : 'budget_minutes'; continue; }
        const facts = sliceFacts({ ...outcome.slice, gcode: outcome.gcode, plateIndex: plate });
        record.status = 'measured'; record.time_s = facts.facts['plate.time_s'] ?? null; record.weight_g = facts.facts['plate.weight_g'] ?? null;
        record.support_weight_g = outcome.gcode.facts['gcode.support_weight_g'] ?? null;
        record.gcode_complete = outcome.gcode.complete; record.comparable = outcome.gcode.complete;
        record.evidence = { ...facts.evidence, ...outcome.gcode.evidence }; record.blind = [...facts.blind, ...outcome.gcode.blind];
        record.output_path = path.join(delivered, `orientation-${id}.3mf`);
        await fs.copyFile(candidate, record.output_path, fs.constants.COPYFILE_EXCL);
      } catch (error) {
        if (deps.signal?.aborted || controller.signal.aborted) { stop = deps.signal?.aborted ? 'cancelled' : 'budget_minutes'; continue; }
        record.status = 'error'; record.error = error instanceof Error ? error.message : String(error);
      }
    }
    const after = hash(await readBoundedPrintFile(args.path)); if (before !== after) throw Error('Source changed during orientation comparison');
    if (deps.signal?.aborted) stop = 'cancelled'; else if (controller.signal.aborted) stop = 'budget_minutes';
    if (stop === 'cancelled' || !records.some(r => r.output_path)) {
      await fs.rm(delivered, { recursive: true, force: true });
      for (const r of records) { delete r.output_path; r.artifacts_removed = true; }
    }
    const winner = (key: string) => {
      const rows = records.filter(r => stop !== 'cancelled' && r.status === 'measured' && r.comparable && typeof r[key] === 'number' && Number.isFinite(r[key]) && r[key] >= 0);
      return rows.length ? rows.reduce((a, b) => a[key] <= b[key] ? a : b).orientation_id : null;
    };
    return { plate_index:plate, stop_reason: stop, slices, max_slices: max, minutes: (now() - started) / 60000, orientations: records, fastest: winner('time_s'), least_material: winner('weight_g'), least_support: winner('support_weight_g'), source_sha256: { before, after }, notes: ['Rotations are world-space X, then Y, then Z; XY center retained unless allow_move_xy explicitly permits a feasible target-only move; lowest printable vertex placed on Z=0.', 'Candidates are unsliced projects for Bambu Studio review. Painted geometry and modifier resources remain in the project.', 'Contact is a geometric estimate; time/material/support are slicer estimates. Adhesion, surface quality, fit and load-bearing strength require physical testing.'] };
  } catch (error) { await fs.rm(delivered, { recursive: true, force: true }); throw error; }
  finally { /* cleanup belongs to the outer deadline scope */ }
  } catch(error) {
    if(controller.signal.aborted&&!work)return {stop_reason:deps.signal?.aborted?'cancelled':'budget_minutes',slices:0,max_slices:max,minutes:(now()-started)/60000,plate_index:plate,orientations:[],fastest:null,least_material:null,least_support:null,notes:['Proposal search was interrupted before any candidate was sliced.']};
    throw error;
  } finally {clearTimeout(timer);deps.signal?.removeEventListener('abort',abort);if(work)await fs.rm(work,{recursive:true,force:true});}
}
