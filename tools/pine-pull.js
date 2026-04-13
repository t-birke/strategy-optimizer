#!/usr/bin/env node
/**
 * Pull the current Pine Script source from TradingView Desktop's editor
 * and save it to a local file.
 *
 * Requires: TradingView Desktop running with --remote-debugging-port=9222
 *           Pine Editor panel must be open (bottom panel).
 *
 * Usage:
 *   node tools/pine-pull.js                          # saves to pine/jm_simple_3tp.pine (default)
 *   node tools/pine-pull.js pine/my_strategy.pine    # saves to a specific file
 *
 * Origin: tradingview-mcp-jackson/scripts/pine_pull.js (adapted for this repo)
 */
import CDP from 'chrome-remote-interface';
import { writeFileSync } from 'fs';
import { resolve } from 'path';

const DEFAULT_OUT = resolve(import.meta.dirname, '..', 'pine', 'jm_simple_3tp.pine');
const outPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_OUT;

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target found. Is TV Desktop running with --remote-debugging-port=9222?'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

// Read source from Monaco editor via React fiber traversal
const src = (await c.Runtime.evaluate({
  expression: '(function(){var c=document.querySelector(".monaco-editor.pine-editor-monaco");if(!c)return null;var el=c;var fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement}if(!fk)return null;var cur=el[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();if(eds.length>0)return eds[0].getValue()}}cur=cur.return}return null})()',
  returnByValue: true,
})).result?.value;

if (!src) { console.error('Could not read Pine editor. Is the Pine Editor panel open?'); await c.close(); process.exit(1); }

writeFileSync(outPath, src);
console.log(`Pulled ${src.split('\n').length} lines → ${outPath}`);
await c.close();
