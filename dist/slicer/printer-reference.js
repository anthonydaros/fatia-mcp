/** Official Bambu Studio machine_model references, checked 2026-11-02. Recognition only; never a slicing preset. */
export const PRINTER_REFERENCE_VERSION = '2026-11-02';
const officialSource = (name) => `https://github.com/bambulab/BambuStudio/blob/master/resources/profiles/BBL/machine/${encodeURIComponent(name + '.json')}`;
export const PRINTER_REFERENCE = [
    ['A1 mini', 'N1', 'a1mini'],
    ['A1', 'N2S', 'a1'],
    ['A2L', 'N9', 'a2l'],
    ['H2C', 'O1C2', 'h2c'],
    ['H2D Pro', 'O1E', 'h2dpro'],
    ['H2D', 'O1D', 'h2d'],
    ['H2S', 'O1S', 'h2s'],
    ['P1P', 'C11', 'p1p'],
    ['P1S', 'C12', 'p1s'],
    ['P2S', 'N7', 'p2s'],
    ['X1 Carbon', 'BL-P001', 'x1c'],
    ['X1', 'BL-P002', 'x1'],
    ['X1E', 'C13', 'x1e'],
    ['X2D', 'N6', 'x2d'],
].map(([model, model_id, model_key]) => {
    const name = `Bambu Lab ${model}`;
    return { name, model_id, model_key, source: officialSource(name) };
});
