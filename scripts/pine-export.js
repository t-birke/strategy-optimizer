/**
 * pine-export — load a spec, freeze it with a gene (legacy BTC winner by
 * default), run the codegen, write the .pine file, and (optionally) diff
 * against the hand-written reference indicator for entry-signal parity.
 *
 * Usage:
 *   node scripts/pine-export.js                         # default spec + BTC gene
 *   node scripts/pine-export.js --diff                  # also diff against pine/jm_3tp_alerts.pine
 *   node scripts/pine-export.js --spec <path>           # override spec file
 *   node scripts/pine-export.js --out <path>            # override output path
 *
 * Output path default:
 *   pine/generated/<spec-name>-<gene-hash12>.pine
 *
 * Gene hash: first 12 hex chars of SHA-256(canonical-JSON-of-gene). Stable
 * key-ordering so the same (spec, gene) always produces the same filename.
 *
 * This script does NOT push to TradingView. Pushing is a separate step via
 * tools/pine-push.js so the codegen can be tested/diffed without risking
 * an overwrite of live TV editor content. Per MEMORY.md, pine-push destroys
 * current editor content; a future enhancement should add a conflict check
 * there rather than auto-pushing from this script.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, basename } from 'node:path';

import * as registry from '../engine/blocks/registry.js';
import { validateSpec } from '../engine/spec.js';
import { buildParamSpace } from '../optimizer/param-space.js';
import { generateEntryAlertsPine, geneHash } from '../engine/pine-codegen.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Default spec + the BTC winner gene used by the parity gate.
const DEFAULT_SPEC = resolve(ROOT, 'strategies/20260414-001-jm-simple-3tp-legacy.json');
const REFERENCE_PINE = resolve(ROOT, 'pine/jm_3tp_alerts.pine');

const BTC_LEGACY = {
  minEntry: 2,
  stochLen: 39, stochSmth: 6,
  rsiLen: 16,
  emaFast: 14, emaSlow: 135,
  bbLen: 40, bbMult: 3,
  atrLen: 24, atrSL: 3.25,
  tp1Mult: 2.5, tp2Mult: 6, tp3Mult: 7,
  tp1Pct: 10, tp2Pct: 10,
  riskPct: 5,
  maxBars: 25,
  emergencySlPct: 25,
};

// Keep this aligned with scripts/parity-gate.js :: buildNewGene — same 18-gene
// mapping. Duplicated rather than shared because the two scripts have
// different downstream consumers and I don't want the parity gate to load
// pine-codegen as a transitive dep.
function buildBtcGene(paramSpace, p = BTC_LEGACY) {
  const g = paramSpace.randomIndividual();
  const set = (qid, v) => { if (Object.prototype.hasOwnProperty.call(g, qid)) g[qid] = v; };

  set('_meta.entries.threshold', p.minEntry);

  set('stochCross.main.stochLen',  p.stochLen);
  set('stochCross.main.stochSmth', p.stochSmth);

  set('emaTrend.main.emaFast', p.emaFast);
  set('emaTrend.main.emaSlow', p.emaSlow);

  set('bbSqueezeBreakout.main.bbLen',  p.bbLen);
  set('bbSqueezeBreakout.main.bbMult', p.bbMult);

  set('atrHardStop.main.atrLen',         p.atrLen);
  set('atrHardStop.main.atrSL',          p.atrSL);
  set('atrHardStop.main.emergencySlPct', p.emergencySlPct);

  set('atrScaleOutTarget.main.atrLen',  p.atrLen);
  set('atrScaleOutTarget.main.tp1Mult', p.tp1Mult);
  set('atrScaleOutTarget.main.tp2Mult', p.tp2Mult);
  set('atrScaleOutTarget.main.tp3Mult', p.tp3Mult);
  set('atrScaleOutTarget.main.tp1Pct',  p.tp1Pct);
  set('atrScaleOutTarget.main.tp2Pct',  p.tp2Pct);
  set('atrScaleOutTarget.main.tp3Pct',  100 - p.tp1Pct - p.tp2Pct);

  set('structuralExit.main.stochLen',  p.stochLen);
  set('structuralExit.main.stochSmth', p.stochSmth);
  set('structuralExit.main.rsiLen',    p.rsiLen);
  set('structuralExit.main.maxBars',   p.maxBars);

  set('atrRisk.main.riskPct', p.riskPct);

  return g;
}

// canonicalJson + geneHash now live in engine/pine-codegen.js so the API
// endpoint and this CLI produce byte-identical hashes for the same gene.

// Parse `close <= slPrice` style conditions out of a Pine file, return a set
// of normalized entry-signal expressions. Pretty crude — just enough to
// eyeball-diff with the generated output.
function extractEntryLines(pine) {
  const lines = pine.split('\n');
  // Keep lines that assign to `bullScore`, `bearScore`, `goLong`, or `goShort`,
  // or that define stoch/ema/bb entry-side booleans.
  const keep = /(\bbullScore\b|\bbearScore\b|\bgoLong\b|\bgoShort\b|(stoch|ema|bb)(Bull|Bear|_long|_short))/;
  return lines.filter(l => keep.test(l) && !l.trim().startsWith('//'));
}

function parseArgs(argv) {
  const out = { diff: false, spec: DEFAULT_SPEC, outPath: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--diff') out.diff = true;
    else if (a === '--spec') out.spec = resolve(argv[++i]);
    else if (a === '--out')  out.outPath = resolve(argv[++i]);
    else throw new Error(`pine-export: unknown arg "${a}"`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);

  console.log('\n=== pine-export (entries-only codegen) ===\n');
  console.log(`spec: ${args.spec}`);

  await registry.ensureLoaded();

  // Load + validate + hydrate
  const rawSpec = JSON.parse(await readFile(args.spec, 'utf8'));
  const spec = validateSpec(rawSpec, { sourcePath: args.spec });
  console.log(`spec hash: ${spec.hash}`);

  const paramSpace = buildParamSpace(spec);
  const gene = buildBtcGene(paramSpace);
  const hydrated = paramSpace.hydrate(gene);
  const ghash = geneHash(gene);
  console.log(`gene hash: ${ghash}  (${paramSpace.PARAMS.length} genes)`);

  // Generate Pine source
  const { source, title, shortTitle } = generateEntryAlertsPine({
    spec,
    hydrated,
    meta: {
      ticker:    'BTCUSDT',
      timeframe: '4H',
      source:    'scripts/pine-export.js  (BTC-4H tuned winner)',
    },
  });

  // Write it
  const outDir = resolve(ROOT, 'pine/generated');
  await mkdir(outDir, { recursive: true });
  const outPath = args.outPath ?? resolve(outDir, `${spec.name}-${ghash}.pine`);
  await writeFile(outPath, source, 'utf8');
  console.log(`\nwrote: ${outPath}  (${source.length} bytes, ${source.split('\n').length} lines)`);
  console.log(`title:       "${title}"`);
  console.log(`shortTitle:  "${shortTitle}"`);

  // Parity diff against reference (jm_3tp_alerts.pine)
  if (args.diff) {
    console.log('\n--- Entry-logic parity diff vs pine/jm_3tp_alerts.pine ---');
    let ref = null;
    try { ref = await readFile(REFERENCE_PINE, 'utf8'); }
    catch (e) { console.log(`(reference file not found: ${REFERENCE_PINE})`); }
    if (ref) {
      const genLines = extractEntryLines(source);
      const refLines = extractEntryLines(ref);
      console.log('\n[ reference — jm_3tp_alerts.pine ]');
      refLines.forEach(l => console.log('  ' + l.trim()));
      console.log('\n[ generated — ' + basename(outPath) + ' ]');
      genLines.forEach(l => console.log('  ' + l.trim()));
      console.log('\n(Numeric literals should match: stochLen=30→39, emaFast=10→14, etc.,');
      console.log(' — the reference uses Run #36/SOLUSDT inputs; the generated uses BTC winner.)');
    }
  }

  console.log('\nNext step:');
  console.log(`  - Review ${outPath}`);
  console.log('  - Push to TV manually via tools/pine-push.js (check script-name conflicts FIRST — see MEMORY.md)');
  console.log('  - Fire alerts on BTCUSDT/4H and cross-check against runtime entry timestamps.\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
