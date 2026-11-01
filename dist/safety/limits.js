/** Printable volume (X, Y, Z in mm) per model; preflight_check judges an STL or OBJ against it.
 * Manufacturer references (verified 2026-09-27):
 * P1P: https://public-cdn.bambulab.com/store/bambulab-P1P-tech-specs.pdf
 * P1S: https://cdn1.bambulab.com/documentation/quick-start-59b0cefdc0fc4/P1S/English%20version-Quick%20Start%20Guide%20for%20P1S.pdf
 * A1: https://bambulab.com/en/a1/tech-specs
 * A1 mini: https://us.store.bambulab.com/products/a1-mini
 * X1/X1C: https://cdn1.bambulab.com/documentation/Quick%20Start%20Guide%20for%20X1%20Combo%26X1-Carbon%20Combo-v1.pdf
 * X1E: https://cdn1.bambulab.com/x1e/spec/Bambu%20Lab%20X1E%20Technical%20Specification.pdf
 * H2D: https://cdn1.bambulab.com/documentation/h2d/en/H2D_Laser_Full_Combo_20250305.pdf
 * H2D Pro: https://bambulab.com/en/h2d-pro/tech-specs
 * H2C: https://csm.bblcdn.com/hub/eca403f48aee405393afc97adbbf6422.pdf
 * H2S: https://bambulab.com/it/support/buying-guide
 * P2S: https://blog.bambulab.com/the-icon-redefined-meet-the-p2s-a-completely-reengineered-version-of-the-ultra-productive-p1-series/
 * X2D: https://csm.bblcdn.com/hub/7c58718aaa2e40edab56efb87419a96a.pdf
 */
export const MACHINE_LIMITS = {
    p1p: { volume: [256, 256, 256] },
    p1s: { volume: [256, 256, 256] },
    p2s: { volume: [256, 256, 256] },
    a1: { volume: [256, 256, 256] },
    a1mini: { volume: [180, 180, 180] },
    x1: { volume: [256, 256, 256] },
    x1c: { volume: [256, 256, 256] },
    x1e: { volume: [256, 256, 256] },
    h2d: { volume: [350, 320, 325] },
    h2dpro: { volume: [350, 320, 325] },
    h2c: { volume: [330, 320, 325] },
    h2s: { volume: [340, 320, 340] },
    x2d: { volume: [256, 256, 260] },
};
export function normalizeModel(value) {
    if (typeof value !== 'string')
        return undefined;
    let model = value.trim().toLowerCase().replace(/^bambu\s*(?:lab\s*)?/, '').replace(/[\s_-]/g, '');
    if (model === 'x1carbon')
        model = 'x1c';
    return Object.prototype.hasOwnProperty.call(MACHINE_LIMITS, model) ? model : undefined;
}
