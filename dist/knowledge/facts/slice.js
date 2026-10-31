// Tier-2 facts of a sliced 3MF: what Studio recorded in slice_info.config for the chosen plate.
// plate.tool_changes is not there (only the G-code counts them), so it stays unknown until the G-code tier.
import { sliceResultsFrom } from "../../3mf_parser.js";
const PROVIDED = new Set(["plate.time_s", "plate.weight_g"]);
export const sliceProvider = {
    tier: 2,
    needs: ["3mf"],
    provides: name => PROVIDED.has(name),
    async collect(ctx, wanted) {
        const facts = {};
        let plate;
        try {
            plate = sliceResultsFrom(ctx.project?.sliceInfo).find(p => p.index === ctx.plateIndex + 1); // index is 1-based
        }
        catch {
            return facts; // a malformed slice_info.config means the plate was not sliced as far as we can tell
        }
        if (!plate)
            return facts;
        for (const name of wanted) {
            const value = name === "plate.time_s" ? plate.prediction_s : plate.weight_g;
            if (Number.isFinite(value))
                facts[name] = value;
        }
        return facts;
    },
};
