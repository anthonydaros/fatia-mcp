import type { RunData } from "./prepare.js";
export type Verdict = "ready" | "ready_with_caveats" | "not_ready";
export declare const READY_MEANS = "\"Pronto\" aqui significa: no \u00FAltimo fatiamento medido o motor n\u00E3o achou mais nenhum problema que consiga ver e nada do que ele aplicou ficou sem verifica\u00E7\u00E3o. N\u00E3o \u00E9 garantia de impress\u00E3o: nenhuma impressora foi usada para validar, regras fracas (relato, hip\u00F3tese) s\u00E3o palpites do guia, e o que o motor n\u00E3o enxerga est\u00E1 na lista UNSEEN.";
export declare function buildReport(run: RunData): Record<string, unknown>;
