// plate.* and slicer.* facts from what the Studio CLI wrote for one plate: slice_info.config (parsed with xml2js, explicitArray:false and
// mergeAttrs:true like src/3mf_parser.ts), result.json and filament_sequence.json, with the G-code header as the last fallback.
// Spec: kb/tuning/out/analyzer-spec.md section 4. Same rule as the G-code scan: a fact that cannot be stood behind is left out and
// named in `blind` with the reason in evidence; every file is data, nothing in it is obeyed.
import { sliceResultsFrom } from "../3mf_parser.js";
import type { GcodeScan, ScanEvidence, ScanValue } from "./gcode-scan.js";

export interface SliceArtifacts {
  /** 0-based plate. */
  plateIndex: number;
  /** Root <config> of Metadata/slice_info.config. */
  sliceInfo?: any;
  /** Parsed result.json of the CLI run (outside the zip). */
  result?: any;
  /** Parsed Metadata/filament_sequence.json. */
  filamentSequence?: any;
  /** The scan of the same plate's G-code: fallbacks for time and weight. */
  gcode?: GcodeScan;
  /** Label for the evidence map. */
  source?: string;
}
export interface SliceFacts { facts: Record<string, ScanValue>; evidence: Record<string, ScanEvidence>; blind: string[] }

const list = <T>(value: T | T[] | undefined): T[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]);
const finite = (v: unknown): number | undefined => { const n = typeof v === "string" && v.trim() === "" ? Number.NaN : Number(v); return Number.isFinite(n) ? n : undefined; };
const GROUPING = /more than optimal grouping|grouping.*not (optimal|ideal)|not (optimal|ideal).*grouping/i; // the two texts found in the Studio binary

function plateNode(sliceInfo: any, index1: number): { plate: any; meta: Record<string, string> } | undefined {
  for (const plate of list<any>(sliceInfo?.plate)) {
    const meta: Record<string, string> = Object.fromEntries(list<any>(plate?.metadata).map(item => [item?.key, item?.value]));
    if (Number(meta.index) === index1) return { plate, meta };
  }
  return undefined;
}
const resultPlate = (result: any, index1: number): any => {
  const plates = list<any>(result?.sliced_plates);
  return plates.find(p => Number(p?.id) === index1) ?? (plates.length === 1 && Number(result?.plate_index) === index1 ? plates[0] : undefined);
};

/** What slice_info says that lets the G-code scan call a zero known: support unused, and no used filament on extruder 2 (the Bowden aux nozzle). */
export function scanHints(sliceInfo: any, plateIndex: number): { supportUsed?: boolean; auxExtruderUsed?: boolean } {
  const node = plateNode(sliceInfo, plateIndex + 1);
  if (!node) return {};
  const filaments = list<any>(node.plate.filament);
  const hints: { supportUsed?: boolean; auxExtruderUsed?: boolean } = {};
  if (node.meta.support_used === "false" && filaments.every(f => f?.used_for_support !== "true")) hints.supportUsed = false;
  else if (node.meta.support_used === "true") hints.supportUsed = true;
  const maps = (node.meta.filament_maps ?? "").trim().split(/\s+/).map(Number);
  if (maps.length && maps.every(Number.isFinite)) hints.auxExtruderUsed = filaments.some(f => (finite(f?.used_g) ?? 0) > 0 && maps[Number(f?.id) - 1] === 2);
  return hints;
}

export function sliceFacts(a: SliceArtifacts): SliceFacts {
  const facts: Record<string, ScanValue> = {};
  const evidence: Record<string, ScanEvidence> = {};
  const blind: string[] = [];
  const index1 = a.plateIndex + 1;
  const src = a.source ?? "slice result";
  const put = (name: string, value: ScanValue, source: string, method: string, approx = false, notes = "") => {
    facts[name] = value;
    evidence[name] = { source: `${src} (${source})`, method, approx, notes };
  };
  const skip = (name: string, reason: string) => {
    blind.push(name);
    evidence[name] = { source: `${src} (not measured)`, method: "not measured", approx: false, notes: reason };
  };

  let info: ReturnType<typeof sliceResultsFrom>[number] | undefined;
  try { info = sliceResultsFrom(a.sliceInfo).find(p => p.index === index1); } catch { /* a malformed slice_info means the plate was not sliced as far as we can tell */ }
  const node = plateNode(a.sliceInfo, index1);
  const res = resultPlate(a.result, index1);
  const header = a.gcode?.details.header;

  // plate.time_s: the Studio's estimate (not a measurement), in the order the spec gives
  const timeFrom: [number | undefined, string, string][] = [
    [info?.prediction_s, "slice_info.config", "<metadata prediction> of the plate"],
    [finite(res?.total_predication), "result.json", "sliced_plates[].total_predication"],
    [header?.estimatedTimeS, "G-code header", "'total estimated time' of the header (whole seconds)"],
  ];
  const time = timeFrom.find(([v]) => v !== undefined && Number.isFinite(v) && v >= 0);
  if (time) put("plate.time_s", Math.round(time[0] as number), time[1], time[2], false, "estimate by the slicer, includes filament load and purge");
  else skip("plate.time_s", "no sliced plate in slice_info.config, result.json or the G-code header");

  // plate.weight_g: whether the purge and the tower are in it is not known (spec 4), so compare it only between rounds of one project
  const usedSum = info && info.filaments.length ? info.filaments.reduce((t, f) => t + (Number.isFinite(f.used_g) ? f.used_g : 0), 0) : undefined;
  const resultSum = finite(res?.filaments && list<any>(res.filaments).reduce((t, f) => t + (finite(f?.total_used_g) ?? 0), 0));
  const weightFrom: [number | undefined, string, string][] = [
    [info?.weight_g, "slice_info.config", "<metadata weight> of the plate"],
    [usedSum, "slice_info.config", "sum of <filament used_g>"],
    [resultSum, "result.json", "sum of sliced_plates[].filaments[].total_used_g"],
    [header?.weightG, "G-code header", "'total filament weight [g]'"],
  ];
  const weight = weightFrom.find(([v]) => v !== undefined && Number.isFinite(v) && v >= 0);
  if (weight) put("plate.weight_g", weight[0] as number, weight[1], weight[2], false, "may or may not include purge and tower; compare only between rounds of the same project");
  else skip("plate.weight_g", "no sliced plate in slice_info.config, result.json or the G-code header");

  // plate.tool_changes: the G-code count when the scan read the whole file; result.json's number only as a fallback
  const fromGcode = a.gcode?.facts["plate.tool_changes"];
  const fromResult = finite(res?.filament_change_times);
  if (typeof fromGcode === "number") {
    const e = a.gcode!.evidence["plate.tool_changes"];
    const disagree = fromResult !== undefined && fromResult !== fromGcode;
    put("plate.tool_changes", fromGcode, e.source, e.method, e.approx || disagree, disagree ? `${e.notes}; result.json says ${fromResult}` : e.notes);
  } else if (fromResult !== undefined && fromResult >= 0) put("plate.tool_changes", fromResult, "result.json", "sliced_plates[].filament_change_times", true, "the meaning of this counter in a multi-filament plate was never checked");
  else skip("plate.tool_changes", a.gcode?.evidence["plate.tool_changes"]?.notes ?? "no complete G-code scan and no result.json");

  // plate.waste_weight_g comes only from the G-code (purge + tower)
  const waste = a.gcode?.facts["plate.waste_weight_g"];
  if (typeof waste === "number") put("plate.waste_weight_g", waste, a.gcode!.evidence["plate.waste_weight_g"].source, a.gcode!.evidence["plate.waste_weight_g"].method, a.gcode!.evidence["plate.waste_weight_g"].approx, a.gcode!.evidence["plate.waste_weight_g"].notes);
  else skip("plate.waste_weight_g", a.gcode?.evidence["plate.waste_weight_g"]?.notes ?? "no G-code scan");

  // warnings the CLI reported
  const messages = [...(info?.warnings.map(w => String(w.msg ?? "")) ?? []), ...(typeof res?.warning_message === "string" && res.warning_message.trim() ? [res.warning_message.trim()] : [])].filter(Boolean);
  if (info || res) {
    put("slicer.warning_count", messages.length, info ? "slice_info.config" : "result.json", "<warning> entries of the plate plus result.json warning_message", false, "the real format of a slicing warning has never been seen: an empty list means the CLI reported none");
    put("slicer.warnings", messages, info ? "slice_info.config" : "result.json", "<warning msg> entries of the plate plus result.json warning_message");
  } else { skip("slicer.warning_count", "no sliced plate in slice_info.config or result.json"); skip("slicer.warnings", "no sliced plate in slice_info.config or result.json"); }

  // slicer.grouping_not_ideal_warning: the warning text if there is one; else a proxy; else blind (the true branch was never seen)
  const usedFilaments = list<any>(node?.plate.filament).filter(f => (finite(f?.used_g) ?? 0) > 0).length;
  const maps = (node?.meta.filament_maps ?? "").trim().split(/\s+/).map(n => Number(n) - 1);
  const optimal = a.filamentSequence?.[`plate_${index1}`]?.optimal_assignment;
  if (messages.some(m => GROUPING.test(m))) put("slicer.grouping_not_ideal_warning", true, info ? "slice_info.config" : "result.json", "grouping warning text in the slicing warnings");
  else if (!info && !res) skip("slicer.grouping_not_ideal_warning", "no sliced plate in slice_info.config or result.json");
  else if (node && usedFilaments === 1) put("slicer.grouping_not_ideal_warning", false, "slice_info.config", "the plate uses one filament, so there is no grouping to be non-ideal");
  else if (node && Array.isArray(optimal) && optimal.length === maps.length && maps.length > 0 && maps.every(Number.isFinite)) {
    const same = optimal.every((v: unknown, i: number) => Number(v) === maps[i]);
    put("slicer.grouping_not_ideal_warning", !same, "slice_info.config + filament_sequence.json", "plate filament_maps against filament_sequence.json optimal_assignment", true, "proxy: the Studio's own warning was never seen in a CLI result, so this is inferred");
  } else skip("slicer.grouping_not_ideal_warning", "no grouping warning in the slicing result and no filament_sequence.json optimal assignment to compare: the true branch of this warning was never observed");

  return { facts, evidence, blind: blind.sort() };
}
