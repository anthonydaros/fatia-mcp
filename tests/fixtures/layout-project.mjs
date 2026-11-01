// Synthetic Studio-style multi-plate projects for the layout tests: box objects with a build-item transform (optionally tilted), a model_settings.config with
// plates in Studio's layout, plate pictures, and X2D-like project settings. Nothing here needs Bambu Studio.
import JSZip from "jszip";

export const X2D = "Bambu Lab X2D 0.4 nozzle";
const variants = ["Direct Drive Standard", "Direct Drive High Flow", "Bowden Standard"];

/** Project settings of an X2D project: 256 x 256 bed, nozzle 2 cannot reach x < 20.5, both filaments on nozzle 1 unless `filament_map` says otherwise. */
export const x2dConfig = (extra = {}) => ({
  printer_settings_id: X2D, print_settings_id: "0.20mm Standard @BBL X2D", printer_model: "Bambu Lab X2D",
  printable_area: ["0x0", "256x0", "256x256", "0x256"], printable_height: "261",
  extruder_printable_area: ["0x0,256x0,256x256,0x256", "20.5x0,256x0,256x256,20.5x256"], extruder_printable_height: ["261", "256"],
  filament_map: ["1", "1"], filament_map_mode: "Auto For Flush", filament_colour: ["#000000", "#9B9EA0"], filament_settings_id: ["Generic PLA @BBL X2D 0.4 nozzle", "Generic PLA @BBL X2D 0.4 nozzle"],
  filament_type: ["PLA", "PLA"], nozzle_diameter: ["0.4", "0.4"], brim_type: "no_brim", brim_width: "0", enable_prime_tower: "0",
  print_extruder_variant: variants, print_extruder_id: ["1", "1", "2"], printer_extruder_variant: variants, printer_extruder_id: ["1", "1", "2"],
  sparse_infill_pattern: "grid", wall_loops: "2", different_settings_to_system: ["", "", "", ""], ...extra,
});

/** The H2D's bed and nozzle areas (350 x 320), for a "source printer was bigger" case. */
export const h2dConfig = (extra = {}) => x2dConfig({
  printer_settings_id: "Bambu Lab H2D 0.4 nozzle", printer_model: "Bambu Lab H2D", printable_area: ["0x0", "350x0", "350x320", "0x320"], printable_height: "325",
  extruder_printable_area: ["0x0,350x0,350x320,0x320", "0x0,350x0,350x320,0x320"], extruder_printable_height: ["325", "325"], ...extra,
});

const NS = 'xmlns="http://schemas.microsoft.com/3dmanufacturing/2015/02" xmlns:p="http://schemas.microsoft.com/3dmanufacturing/production/2015/06"';
const num = n => String(Number(n.toPrecision(12)));

function box(w, d, h, painted) {
  const v = [[0, 0, 0], [w, 0, 0], [w, d, 0], [0, d, 0], [0, 0, h], [w, 0, h], [w, d, h], [0, d, h]];
  const t = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return `<mesh><vertices>${v.map(p => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join("")}</vertices><triangles>${t.map((p, i) => `<triangle v1="${p[0]}" v2="${p[1]}" v3="${p[2]}"${painted && i === 0 ? ' paint_color="4"' : ""}/>`).join("")}</triangles></mesh>`;
}
/** Row-vector rotation about X by `deg`: m = [1 0 0; 0 c s; 0 -s c]. */
export const tiltX = deg => { const a = (deg * Math.PI) / 180; return [1, 0, 0, 0, Math.cos(a), Math.sin(a), 0, -Math.sin(a), Math.cos(a)]; };
const apply = (m, [x, y, z]) => [x * m[0] + y * m[3] + z * m[6], x * m[1] + y * m[4] + z * m[7], x * m[2] + y * m[5] + z * m[8]];

/**
 * objects: [{ id, name, size: [w, d, h] (before the matrix), at: [cx, cy] (world centre of the box after the matrix), extruder = 1, parts = [extruder, ...]?,
 *             matrix? (9 numbers, default identity), painted?, printable = true }]
 * plates: lists of "id:instance" keys (instance 0 for each object), in plate order. locked: plate numbers (1-based) that are locked.
 */
export async function buildLayoutProject({ objects, plates, locked = [], config = x2dConfig(), images = true, extraEntries = {}, gcode = false, names = [] }) {
  const zip = new JSZip();
  zip.file("[Content_Types].xml", '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="png" ContentType="image/png"/></Types>');
  const resources = [];
  const items = [];
  for (const o of objects) {
    const [w, d, h] = o.size;
    const m = o.matrix ?? [1, 0, 0, 0, 1, 0, 0, 0, 1];
    const corners = [0, w].flatMap(x => [0, d].flatMap(y => [0, h].map(z => apply(m, [x, y, z]))));
    const lo = [0, 1, 2].map(i => Math.min(...corners.map(c => c[i])));
    const hi = [0, 1, 2].map(i => Math.max(...corners.map(c => c[i])));
    const t = [o.at[0] - (lo[0] + hi[0]) / 2, o.at[1] - (lo[1] + hi[1]) / 2, -lo[2]];
    resources.push(`<object id="${o.id}" type="model">${box(w, d, h, o.painted)}</object>`);
    items.push(`<item objectid="${o.id}" p:UUID="0000000${o.id}-b1ec-4553-aec9-835e5b724bb4" transform="${[...m.map(num), ...t.map(num)].join(" ")}" printable="${o.printable === false ? 0 : 1}" />`);
  }
  zip.file("3D/3dmodel.model", `<?xml version="1.0" encoding="UTF-8"?>\n<model ${NS} unit="millimeter">\n <metadata name="Thumbnail_Middle">/Metadata/plate_1.png</metadata>\n <resources>\n  ${resources.join("\n  ")}\n </resources>\n <build>\n  ${items.join("\n  ")}\n </build>\n</model>`);
  const objectXml = objects.map(o => `  <object id="${o.id}">
    <metadata key="name" value="${o.name}"/>
    <metadata key="extruder" value="${o.extruder ?? 1}"/>
${(o.parts ?? [undefined]).map((e, i) => `    <part id="${o.id * 100 + i}" subtype="normal_part">
      <metadata key="name" value="${o.name}"/>${e === undefined ? "" : `\n      <metadata key="extruder" value="${e}"/>`}
    </part>`).join("\n")}
  </object>`).join("\n");
  const plateXml = plates.map((keys, i) => `  <plate>
    <metadata key="plater_id" value="${i + 1}"/>
    <metadata key="plater_name" value="${names[i] ?? ""}"/>
    <metadata key="locked" value="${locked.includes(i + 1)}"/>
    <metadata key="filament_map_mode" value="Auto For Flush"/>
    <metadata key="thumbnail_file" value="Metadata/plate_${i + 1}.png"/>
    <metadata key="thumbnail_no_light_file" value="Metadata/plate_no_light_${i + 1}.png"/>
    <metadata key="top_file" value="Metadata/top_${i + 1}.png"/>
    <metadata key="pick_file" value="Metadata/pick_${i + 1}.png"/>
${keys.map((k, j) => { const [id, inst = "0"] = k.split(":"); return `    <model_instance>
      <metadata key="object_id" value="${id}"/>
      <metadata key="instance_id" value="${inst}"/>
      <metadata key="identify_id" value="${400 + i * 10 + j}"/>
    </model_instance>`; }).join("\n")}
  </plate>`).join("\n");
  zip.file("Metadata/project_settings.config", JSON.stringify(config, null, 4));
  zip.file("Metadata/model_settings.config", `<?xml version="1.0" encoding="UTF-8"?>\n<config>\n${objectXml}\n${plateXml}\n  <assemble>\n   <assemble_item object_id="${objects[0].id}" instance_id="0" transform="1 0 0 0 1 0 0 0 1 0 0 0" offset="0 0 0" />\n  </assemble>\n</config>\n`);
  zip.file("Metadata/slice_info.config", '<?xml version="1.0" encoding="UTF-8"?>\n<config>\n  <header>\n    <header_item key="X-BBL-Client-Type" value="slicer"/>\n    <header_item key="X-BBL-Client-Version" value="02.08.04.57"/>\n  </header>\n</config>\n');
  zip.file("Metadata/filament_sequence.json", `{${plates.map((_, i) => `"plate_${i + 1}":{"nozzle_sequence":[],"optimal_assignment":[],"sequence":[]}`).join(",")}}`);
  if (images) {
    plates.forEach((_, i) => {
      for (const n of [`plate_${i + 1}.png`, `plate_no_light_${i + 1}.png`, `top_${i + 1}.png`, `pick_${i + 1}.png`, `plate_${i + 1}_small.png`]) zip.file(`Metadata/${n}`, Buffer.from(`png ${n}`));
    });
  }
  if (gcode) zip.file("Metadata/plate_1.gcode", "G1 X1\n");
  for (const [name, data] of Object.entries(extraEntries)) zip.file(name, data);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

/** The world position of a plate's local point on the Studio grid (for the tests' own arithmetic, independent of src/). */
export const gridOrigin = (index, count, bed = [256, 256]) => {
  const cols = Math.ceil(Math.sqrt(count));
  return { x: (index % cols) * bed[0] * 1.2, y: -Math.floor(index / cols) * bed[1] * 1.2 };
};

/** A Frame (slot 1) and eight grey boxes (slot 2), one per plate and placed on the H2D grid, which the X2D does not have: nine plates, most objects off their plate. */
export function scatteredSpec(extra = {}) {
  const objects = [{ id: 2, name: "Frame", size: [120, 120, 60], at: [175, 160], extruder: 1 }];
  for (let i = 0; i < 8; i++) {
    const n = i + 1;
    objects.push({ id: 4 + 2 * i, name: `Grey ${i + 1}`, size: [100, 100, 50], at: [175 + 420 * (n % 5), 160 - 384 * Math.floor(n / 5)], extruder: 2 });
  }
  return { objects, plates: objects.map(o => [`${o.id}:0`]), config: x2dConfig({ brim_type: "no_brim" }), ...extra };
}
