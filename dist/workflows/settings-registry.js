const numeric = { layer_height: [.05, .6], wall_loops: [1, 100, true], top_shell_layers: [0, 100, true], bottom_shell_layers: [0, 100, true], sparse_infill_density: [0, 100], brim_width: [0, 50], support_threshold_angle: [0, 90], outer_wall_speed: [0, 1000], inner_wall_speed: [0, 1000], outer_wall_acceleration: [0, 100000], inner_wall_acceleration: [0, 100000], support_object_xy_distance: [0, 10], support_interface_spacing: [0, 10], support_interface_top_layers: [0, 20, true], tree_support_branch_angle: [0, 85], support_base_pattern_spacing: [0, 50], skeleton_infill_density: [0, 100], skin_infill_density: [0, 100] };
const choices = { wall_sequence: ['inner wall/outer wall', 'outer wall/inner wall', 'inner-outer-inner wall'], support_style: ['default', 'tree_slim', 'tree_strong', 'tree_hybrid'], sparse_infill_pattern: ['grid', 'gyroid', 'rectilinear', 'honeycomb', 'line', 'cubic', 'adaptivecubic', 'supportcubic', 'lightning', '3dhoneycomb', 'triangles', 'tri-hexagon', 'concentric', 'crosshatch'], support_type: ['normal(auto)', 'tree(auto)', 'normal(manual)', 'tree(manual)'], brim_type: ['auto_brim', 'outer_only', 'inner_only', 'outer_and_inner', 'no_brim'], seam_position: ['nearest', 'aligned', 'back', 'random'], ironing_type: ['no ironing', 'top', 'topmost', 'all solid layer'] };
export const PROCESS_SETTING_PROPERTIES = Object.fromEntries([...Object.keys(numeric).map(k => [k, { type: ['number', 'string'] }]), ...Object.entries(choices).map(([k, values]) => [k, { type: 'string', enum: values }]), ['enable_support', { type: ['boolean', 'string', 'number'] }]]);
export function parseProcessSettings(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw Error('settings must be an object');
    return Object.entries(value).map(([key, raw]) => {
        let value;
        if (key in numeric) {
            const [min, max, int] = numeric[key];
            if (!['string', 'number'].includes(typeof raw) || String(raw).trim() === '')
                throw Error(`${key} setting must be finite`);
            const n = Number(String(raw).replace(/%$/, ''));
            if (!Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n)))
                throw Error(`Invalid ${key} setting: expected ${min}..${max}`);
            value = String(n) + (['sparse_infill_density', 'skeleton_infill_density', 'skin_infill_density'].includes(key) ? '%' : '');
        }
        else if (key === 'enable_support') {
            if (![true, false, 0, 1, '0', '1'].includes(raw))
                throw Error('enable_support setting must be boolean or 0/1');
            value = raw === true || raw === 1 || raw === '1' ? '1' : '0';
        }
        else if (key in choices && typeof raw === 'string' && choices[key].includes(raw))
            value = raw;
        else
            throw Error(`Unsupported setting ${key}`);
        return { key, value, scope: 'process' };
    });
}
