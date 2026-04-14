/**
 * 18-gene parameter space for JM Simple 3TP strategy.
 * Extracted from optimize-full.js — standalone, no TradingView dependencies.
 */

export const PARAMS = [
  { id: 'minEntry',  type: 'int',   min: 1,    max: 3,    step: 1    },
  { id: 'stochLen',  type: 'int',   min: 5,    max: 40,   step: 1    },
  { id: 'stochSmth', type: 'int',   min: 1,    max: 8,    step: 1    },
  { id: 'rsiLen',    type: 'int',   min: 5,    max: 25,   step: 1    },
  { id: 'emaFast',   type: 'int',   min: 8,    max: 40,   step: 1    },
  { id: 'emaSlow',   type: 'int',   min: 30,   max: 150,  step: 5    },
  { id: 'bbLen',     type: 'int',   min: 10,   max: 40,   step: 1    },
  { id: 'bbMult',    type: 'float', min: 1.0,  max: 3.5,  step: 0.5  },
  { id: 'atrLen',    type: 'int',   min: 5,    max: 30,   step: 1    },
  { id: 'atrSL',     type: 'float', min: 0.5,  max: 4.0,  step: 0.25 },
  { id: 'tp1Mult',   type: 'float', min: 1.5,  max: 3.0,  step: 0.25 },
  { id: 'tp2Mult',   type: 'float', min: 1.5,  max: 6.0,  step: 0.25 },
  { id: 'tp3Mult',   type: 'float', min: 3.0,  max: 12.0, step: 0.5  },
  { id: 'tp1Pct',    type: 'int',   min: 10,   max: 50,   step: 5    },
  { id: 'tp2Pct',    type: 'int',   min: 10,   max: 50,   step: 5    },
  { id: 'riskPct',      type: 'float', min: 0.5,  max: 5.0,  step: 0.5  },
  { id: 'maxBars',      type: 'int',   min: 5,    max: 40,   step: 5    },
  { id: 'emergencySlPct', type: 'int', min: 5,    max: 25,   step: 1    },
];

const P = id => PARAMS.find(p => p.id === id);

export function clamp(val, p) {
  const clamped = Math.max(p.min, Math.min(p.max, val));
  const snapped = Math.round((clamped - p.min) / p.step) * p.step + p.min;
  return p.type === 'int' ? Math.round(snapped) : Math.round(snapped * 100) / 100;
}

export function enforceConstraints(gene) {
  if (gene.emaFast >= gene.emaSlow) gene.emaSlow = clamp(gene.emaFast + 10, P('emaSlow'));
  if (gene.tp1Mult >= gene.tp2Mult) gene.tp2Mult = clamp(gene.tp1Mult + 0.5, P('tp2Mult'));
  if (gene.tp2Mult >= gene.tp3Mult) gene.tp3Mult = clamp(gene.tp2Mult + 1.0, P('tp3Mult'));
  if (gene.tp1Pct + gene.tp2Pct > 90) gene.tp2Pct = clamp(90 - gene.tp1Pct, P('tp2Pct'));
}

export function randomParam(p) {
  const steps = Math.round((p.max - p.min) / p.step);
  const val = p.min + Math.floor(Math.random() * (steps + 1)) * p.step;
  return p.type === 'int' ? Math.round(val) : Math.round(val * 100) / 100;
}

export function randomIndividual() {
  const gene = {};
  for (const p of PARAMS) gene[p.id] = randomParam(p);
  enforceConstraints(gene);
  return gene;
}

export function mutate(input, output) {
  for (const p of PARAMS) {
    if (Math.random() < 0.2) { // PER_GENE_MUT
      const dir = Math.random() < 0.5 ? -1 : 1;
      const magnitude = 1 + Math.floor(Math.random() * 3);
      output[p.id] = clamp(input[p.id] + dir * magnitude * p.step, p);
    } else {
      output[p.id] = input[p.id];
    }
  }
  enforceConstraints(output);
}

export function crossover(a, b, child) {
  for (const p of PARAMS) {
    child[p.id] = Math.random() < 0.5 ? a[p.id] : b[p.id];
  }
  enforceConstraints(child);
}

/**
 * Gene knockout support — force a subset of genes to fixed values across
 * an entire population. Used by planet-level ablation experiments: planet p
 * freezes gene X so the GA explores the rest of the space around X's fixed
 * value. Fitness delta vs. the unfrozen control planet reveals importance.
 *
 * `frozenGenes` is a plain object { geneId: value }. Missing = not frozen.
 * Caller is responsible for enforceConstraints AFTER (frozen values win
 * over mutation / crossover / random output; constraint repair then only
 * adjusts non-frozen genes).
 */
export function applyFrozen(gene, frozenGenes) {
  if (!frozenGenes) return gene;
  for (const id in frozenGenes) gene[id] = frozenGenes[id];
  return gene;
}

/**
 * Name-friendly label for a frozen-gene set, used in UI badges and logs.
 * Returns e.g. "rsiLen=14" or "rsiLen=14, emaFast=20" or "" for control.
 */
export function frozenLabel(frozenGenes) {
  if (!frozenGenes) return '';
  const keys = Object.keys(frozenGenes);
  if (keys.length === 0) return '';
  return keys.map(k => `${k}=${frozenGenes[k]}`).join(', ');
}

export function geneKey(gene) {
  return PARAMS.map(p => gene[p.id]).join(',');
}

export function geneShort(gene) {
  const tp3Pct = 100 - gene.tp1Pct - gene.tp2Pct;
  return [
    `E${gene.minEntry}`,
    `St${gene.stochLen}/${gene.stochSmth}`,
    `R${gene.rsiLen}`,
    `EMA${gene.emaFast}/${gene.emaSlow}`,
    `BB${gene.bbLen}x${gene.bbMult}`,
    `ATR${gene.atrLen}`,
    `SL${gene.atrSL}`,
    `TP${gene.tp1Mult}/${gene.tp2Mult}/${gene.tp3Mult}`,
    `@${gene.tp1Pct}/${gene.tp2Pct}/${tp3Pct}%`,
    `R${gene.riskPct}%`,
    `T${gene.maxBars}b`,
    `ESL${gene.emergencySlPct}%`,
  ].join(' ');
}
