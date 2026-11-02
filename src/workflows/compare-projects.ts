import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openProject, asArray, meta, plateInstances, savedVersion } from '../knowledge/facts/settings.js';
import { readProjectMesh, MeshReadError } from '../tuning/mesh-read.js';
import { requireMillimeters } from './geometry.js';
import { loadPrinterIdentities, printerEvidence, type PrinterIdentity } from '../slicer/printer-identity.js';
export interface CompareProjectDeps { profilesRoot?: string; targetModel?: string; signal?: AbortSignal }

export const COMPARE_PROJECT_TOOLS: Tool[] = [{
  name: 'compare_projects',
  description: 'Read-only comparison of two 3MF projects: saved settings, filament assignments, plates, object geometry, dimensions and world placement. Missing evidence remains unknown.',
  inputSchema: { type: 'object', properties: {
    bambu_model: { type: 'string', description: 'Optional chosen target for identity checks; otherwise the configured model. Read-only: no slicing.' },
    project_a: { type: 'string', description: 'Path to the first 3MF.' },
    project_b: { type: 'string', description: 'Path to the second 3MF.' },
  }, required: ['project_a', 'project_b'], additionalProperties: false },
}];

// Object key ordering is not a setting change; array order (especially filament slots) is.
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map(key => [key, v[key]])) : v);
}
function delta(a: Record<string, unknown>, b: Record<string, unknown>) {
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter(key => canonical(a[key]) !== canonical(b[key]))
    .map(key => ({ key, before: a[key] ?? null, after: b[key] ?? null }));
}
async function snapshot(file: string, identities: PrinterIdentity[], target?: string) {
  const p = await openProject(file);
  const modelContent: Record<string, string> = {};
  // The shared mesh reader returns raw coordinates; reject units it cannot normalize.
  for (const name of p.names ?? []) if (/^3D\/.*\.model$/i.test(name)) {
    const bytes = await p.read!(name);
    if (!bytes) throw new Error('Missing 3MF model');
    requireMillimeters(bytes);
    modelContent[name] = createHash('sha256').update(bytes).digest('hex');
  }
  const objects: Record<string, unknown>[] = [];
  let geometryProblem: string | null = null;
  try {
    const mesh = await readProjectMesh(p, null);
    for (const o of mesh.objects) {
      const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
      for (const index of o.soup.idx) for (let axis = 0; axis < 3; axis++) {
        const v = o.soup.pos[index * 3 + axis];
        if (!Number.isFinite(v)) throw new Error('Transformed geometry is not finite');
        min[axis] = Math.min(min[axis], v); max[axis] = Math.max(max[axis], v);
      }
      const dimensions = max.map((v, i) => v - min[i]);
      if (!dimensions.every(Number.isFinite)) throw new Error('Geometry dimensions exceed finite bounds');
      const digest = createHash('sha256').update(Buffer.from(o.soup.pos.buffer, o.soup.pos.byteOffset, o.soup.pos.byteLength)).update(Buffer.from(o.soup.idx.buffer, o.soup.idx.byteOffset, o.soup.idx.byteLength)).digest('hex');
      const settings = asArray(p.modelSettings?.object).find(n => String(n.id) === o.objectId);
      objects.push({ item_index: o.itemIndex, object_id: o.objectId, instance: o.instance, name: o.name, dimensions_mm: dimensions, bounds_mm: {min,max}, triangles: o.soup.idx.length / 3, geometry_sha256: digest, painted: o.painted ?? false, settings: settings ?? null });
    }
  } catch (error) {
    if (!(error instanceof MeshReadError) || error.code !== 'no_geometry') throw error;
    geometryProblem = error.message;
  }
  const materials = Object.fromEntries(Object.entries(p.config ?? {}).filter(([key]) => /^(filament_|default_filament|support_filament|support_interface_filament)/.test(key)));
  const plates = asArray(p.modelSettings?.plate).map(plate => {
    const id = Number(meta(plate, 'plater_id'));
    return { id: Number.isFinite(id) ? id : null, instances: Number.isInteger(id) && id > 0 ? plateInstances(p.modelSettings, id - 1) : null, settings: plate };
  });
  const slicedPlates=asArray(p.sliceInfo?.plate);
  const expected=plates.filter(p=>p.instances?.length).map(p=>p.id);
  const recorded=slicedPlates.map(p=>Number(meta(p,'index')));
  const header=asArray(p.sliceInfo?.header?.header_item);
  const conditions={printer:printerEvidence(p.config??{},p.sliceInfo,identities,target), studio:{saved:savedVersion(p)??null,sliced:header.find(h=>h.key==='X-BBL-Client-Version')?.value??null}, nozzle:p.config?.nozzle_diameter??null,filament_types:p.config?.filament_type??null,plate_coverage:expected.length&&recorded.length&&expected.length===recorded.length&&expected.every(id=>id!==null&&recorded.includes(id))?'complete':'unknown_or_partial'};
  return { conditions, path: file, model_content: modelContent, settings: p.config ?? null, settings_problem: p.configProblem ?? null, materials, plates, objects, geometry_problem: geometryProblem, metadata_problem: p.modelSettings ? null : 'Model settings metadata is absent or unreadable; plate membership and object material assignments are unknown' };
}

export async function compareProjects(args: Record<string, unknown>, deps: CompareProjectDeps = {}): Promise<Record<string, unknown>> {
  deps.signal?.throwIfAborted();
  let identities: PrinterIdentity[]=[];
  let identityProblem:string|null=null;
  if(deps.profilesRoot) {try{identities=await loadPrinterIdentities(deps.profilesRoot);}catch{identityProblem="Perfis de identificação da instalação indisponíveis";}}
  else identityProblem="Instalação de perfis não informada; identificadores permanecem desconhecidos";
  const files = ['project_a', 'project_b'].map(key => {
    const file = args[key];
    if (typeof file !== 'string' || !file.trim() || path.extname(file).toLowerCase() !== '.3mf') throw new Error(`${key} must be a 3MF file path`);
    return path.resolve(file);
  });
  const a = await snapshot(files[0],identities,deps.targetModel), b = await snapshot(files[1],identities,deps.targetModel);
  deps.signal?.throwIfAborted();
  const conditionIssues:string[]=[];
  if(identityProblem)conditionIssues.push(identityProblem);
  const machines=[a,b].flatMap(p=>p.conditions.printer.sliced.map(v=>v.canonical_model));
  if(!a.conditions.printer.sliced.length||!b.conditions.printer.sliced.length||machines.some(m=>!m))conditionIssues.push("Identidade do fatiamento desconhecida em pelo menos um projeto");
  else if(new Set(machines).size!==1)conditionIssues.push("Os fatiamentos usam impressoras diferentes");
  for(const key of ["nozzle","filament_types","studio"] as const) if(canonical(a.conditions[key])!==canonical(b.conditions[key]))conditionIssues.push(`Condições diferentes: ${key}`);
  if([a,b].some(p=>p.conditions.printer.sliced.some(v=>v.matches_target===false)))conditionIssues.push("Um fatiamento não corresponde à impressora escolhida");
  if(!a.conditions.filament_types||!b.conditions.filament_types)conditionIssues.push("Materiais do fatiamento desconhecidos");
  if(!a.conditions.nozzle||!b.conditions.nozzle)conditionIssues.push("Diâmetro do bico desconhecido");
  if(!a.conditions.studio.sliced||!b.conditions.studio.sliced)conditionIssues.push("Versão do Studio no fatiamento desconhecida");
  if([a,b].some(p=>p.conditions.plate_coverage!=="complete"))conditionIssues.push("Cobertura de mesas desconhecida ou parcial");
  const changed = a.objects.flatMap((before, i) => b.objects[i] && canonical(before) !== canonical(b.objects[i]) ? [{ item_index: before.item_index, before, after: b.objects[i] }] : []);
  const changes = {
    model_content: delta(a.model_content, b.model_content),
    settings: delta(a.settings ?? {}, b.settings ?? {}), materials: delta(a.materials, b.materials),
    plates: delta(Object.fromEntries(a.plates.map((v, i) => [String(i), v])), Object.fromEntries(b.plates.map((v, i) => [String(i), v]))),
    objects: { added: b.objects.slice(a.objects.length), removed: a.objects.slice(b.objects.length), changed },
  };
  const complete = !!a.settings && !!b.settings && !a.geometry_problem && !b.geometry_problem && !a.metadata_problem && !b.metadata_problem;
  return { comparability:{ comparable:conditionIssues.length===0, issues:conditionIssues,geometry_verified:!a.geometry_problem&&!b.geometry_problem, note:"Mesmo hardware e configurações não garantem qualidade física equivalente; tempos e material são estimativas."}, projects: [a,b], changes, identical: complete ? !changes.model_content.length && !changes.settings.length && !changes.materials.length && !changes.plates.length && !changed.length && a.objects.length === b.objects.length : null, comparison_complete: complete, evidence: 'Saved project data and bounded transformed mesh geometry. Objects are paired by build order; geometry and model-content hashes are representation-sensitive. Model-content hashes also detect paint assignments and modifier geometry excluded from printable meshes. No slicing or physical print evidence.' };
}
