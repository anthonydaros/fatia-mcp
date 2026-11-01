import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { analyzeMeshHealth, MESH_HEALTH_TOOLS } from '../dist/workflows/mesh-health.js';

const verts=[[0,0,0],[1,0,0],[0,1,0],[0,0,1]];
const faces=[[0,2,1],[0,1,3],[1,2,3],[2,0,3]];
async function workspace(t) { const dir=await fs.mkdtemp(path.join(os.tmpdir(),'fatia-health-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));return dir; }
async function stl(dir, tris=faces) { const file=path.join(dir,'part.stl');await fs.writeFile(file,`solid part\n${tris.map(f=>`facet normal 0 0 0\nouter loop\n${f.map(v=>`vertex ${verts[v].join(' ')}`).join('\n')}\nendloop\nendfacet`).join('\n')}\nendsolid part`);return file; }
test('mesh health schema and exact-coordinate STL welding detect a closed tetrahedron',async t=>{
 assert.equal(MESH_HEALTH_TOOLS[0].name,'analyze_mesh_health'); const dir=await workspace(t),file=await stl(dir),before=await fs.readFile(file);
 const r=await analyzeMeshHealth({path:file});const o=r.objects[0];
 assert.equal(o.unique_vertices,4);assert.equal(o.boundary_edges,0);assert.equal(o.non_manifold_edges,0);assert.equal(o.connected_components,1);assert.equal(o.edge_closed,true);assert.ok(Math.abs(o.signed_volume_mm3-1/6)<1e-12);assert.equal(r.self_intersections,'not_checked');assert.deepEqual(await fs.readFile(file),before);
});
test('open, duplicate and degenerate faces are independently reported',async t=>{
 const dir=await workspace(t);let file=await stl(dir,faces.slice(0,3));let o=(await analyzeMeshHealth({path:file})).objects[0];assert.equal(o.boundary_edges,3);assert.equal(o.edge_closed,false);assert.equal(o.signed_volume_mm3,null);
 file=await stl(dir,[...faces,faces[0],[0,0,1]]);o=(await analyzeMeshHealth({path:file})).objects[0];assert.equal(o.duplicate_faces,1);assert.equal(o.degenerate_faces,1);assert.equal(o.non_manifold_edges,3);assert.equal(o.signed_volume_mm3,null);
});
test('3MF transforms are applied and unknown plate membership cannot select arbitrary plates',async t=>{
 const dir=await workspace(t),file=path.join(dir,'part.3mf'),zip=new JSZip();
 zip.file('3D/3dmodel.model',`<model unit="millimeter"><resources><object id="1"><mesh><vertices>${verts.map(v=>`<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join('')}</vertices><triangles>${faces.map(f=>`<triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"/>`).join('')}</triangles></mesh></object></resources><build><item objectid="1" transform="-2 0 0 0 3 0 0 0 4 10 20 30"/></build></model>`);
 await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));const r=await analyzeMeshHealth({path:file});assert.equal(r.plate_membership,'unknown');assert.deepEqual(r.objects[0].bounds_mm,{min:[8,20,30],max:[10,23,34]});assert.ok(Math.abs(r.objects[0].signed_volume_mm3-4)<1e-10);
 await assert.rejects(analyzeMeshHealth({path:file,plate_index:1}),/membership/i);
 zip.file('3d/3dmodel.model','collision');await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));await assert.rejects(analyzeMeshHealth({path:file}),/collid|duplicate/i);
});
test('limits, malformed coordinates and cancellation reject without artifacts',async t=>{
 const dir=await workspace(t),file=await stl(dir);await assert.rejects(analyzeMeshHealth({path:file,max_triangles:3}),/triangles/i);await assert.rejects(analyzeMeshHealth({path:file,max_triangles:NaN}),/max_triangles/i);const c=new AbortController();c.abort();await assert.rejects(analyzeMeshHealth({path:file},c.signal),/abort/i);
 await fs.writeFile(file,'solid broken\nvertex NaN 0 0\nvertex 1 0 0\nvertex 0 1 0\nendsolid');await assert.rejects(analyzeMeshHealth({path:file}),/finite/i);assert.deepEqual(await fs.readdir(dir),['part.stl']);
});
test('disconnected shells remain distinct and opposite winding across a shared edge is checked',async t=>{
 const dir=await workspace(t),file=await stl(dir);const first=await fs.readFile(file,'utf8');const moved=first.replace(/vertex (\S+) (\S+) (\S+)/g,(_,x,y,z)=>`vertex ${Number(x)+5} ${y} ${z}`);await fs.writeFile(file,first.replace('endsolid part',moved.replace('solid part','')));
 let o=(await analyzeMeshHealth({path:file})).objects[0];assert.equal(o.connected_components,2);assert.equal(o.unique_vertices,8);assert.equal(o.edge_closed,true);
 await stl(dir,[faces[0].slice().reverse(),...faces.slice(1)]);o=(await analyzeMeshHealth({path:file})).objects[0];assert.equal(o.inconsistent_winding_edges,3);assert.equal(o.consistently_wound,false);assert.equal(o.signed_volume_mm3,null);
});
test('missing referenced component cannot yield a healthy partial model',async t=>{
 const dir=await workspace(t),file=path.join(dir,'missing.3mf'),zip=new JSZip();
 const geometry=`<mesh><vertices>${verts.map(v=>`<vertex x="${v[0]}" y="${v[1]}" z="${v[2]}"/>`).join('')}</vertices><triangles>${faces.map(f=>`<triangle v1="${f[0]}" v2="${f[1]}" v3="${f[2]}"/>`).join('')}</triangles></mesh>`;
 zip.file('3D/3dmodel.model',`<model unit="millimeter"><resources><object id="1"><components><component objectid="2"/><component objectid="3"/></components></object><object id="2">${geometry}</object></resources><build><item objectid="1"/></build></model>`);
 await fs.writeFile(file,await zip.generateAsync({type:'nodebuffer'}));
 await assert.rejects(analyzeMeshHealth({path:file}),/missing|unresolved|referenced/i);
});
