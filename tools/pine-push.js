#!/usr/bin/env node
/**
 * Push a local .pine file into the TradingView Desktop Pine editor, compile,
 * and report any errors.
 *
 * Requires: TradingView Desktop running with --remote-debugging-port=9222
 *           Pine Editor panel must be open (bottom panel).
 *
 * Usage:
 *   node tools/pine-push.js                          # pushes pine/jm_simple_3tp.pine (default)
 *   node tools/pine-push.js pine/jm_simple.pine      # pushes a specific file
 *
 * Origin: tradingview-mcp-jackson/scripts/pine_push.js (adapted for this repo)
 */
import CDP from 'chrome-remote-interface';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const DEFAULT_PINE = resolve(import.meta.dirname, '..', 'pine', 'jm_simple_3tp.pine');
const srcPath = process.argv[2] ? resolve(process.argv[2]) : DEFAULT_PINE;
const src = readFileSync(srcPath, 'utf-8');

console.log(`Source: ${srcPath} (${src.split('\n').length} lines, ${src.length} chars)`);

const targets = await (await fetch('http://localhost:9222/json/list')).json();
const t = targets.find(t => t.url?.includes('tradingview.com'));
if (!t) { console.error('No TradingView target found. Is TV Desktop running with --remote-debugging-port=9222?'); process.exit(1); }
const c = await CDP({ host: 'localhost', port: 9222, target: t.id });
await c.Runtime.enable();

// Inject source into Monaco editor via React fiber traversal
const escaped = JSON.stringify(src);
const set = (await c.Runtime.evaluate({
  expression: `(function(){var c=document.querySelector(".monaco-editor.pine-editor-monaco");if(!c)return false;var el=c;var fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement}if(!fk)return false;var cur=el[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();if(eds.length>0){eds[0].setValue(${escaped});return true}}}cur=cur.return}return false})()`,
  returnByValue: true,
})).result?.value;

if (!set) { console.error('Could not inject into Pine editor. Is the Pine Editor panel open?'); await c.close(); process.exit(1); }
console.log(`Pushed ${src.split('\n').length} lines → Pine editor`);

// Click compile/save button
const clicked = (await c.Runtime.evaluate({
  expression: '(function(){var btns=document.querySelectorAll("button");for(var i=0;i<btns.length;i++){var t=btns[i].textContent.trim();if(/save and add to chart/i.test(t)){btns[i].click();return t}if(/^(Add to chart|Update on chart)/i.test(t)){btns[i].click();return t}}for(var i=0;i<btns.length;i++){if(btns[i].className.indexOf("saveButton")!==-1&&btns[i].offsetParent!==null){btns[i].click();return "Pine Save"}}return null})()',
  returnByValue: true,
})).result?.value;

console.log('Compile:', clicked || 'keyboard fallback');
if (!clicked) {
  await c.Input.dispatchKeyEvent({ type: 'keyDown', modifiers: 2, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await c.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter' });
}

// Wait for compilation, then check for errors
await new Promise(r => setTimeout(r, 3000));
const errors = (await c.Runtime.evaluate({
  expression: '(function(){var c=document.querySelector(".monaco-editor.pine-editor-monaco");if(!c)return[];var el=c;var fk;for(var i=0;i<20;i++){if(!el)break;fk=Object.keys(el).find(function(k){return k.startsWith("__reactFiber$")});if(fk)break;el=el.parentElement}if(!fk)return[];var cur=el[fk];for(var d=0;d<15;d++){if(!cur)break;if(cur.memoizedProps&&cur.memoizedProps.value&&cur.memoizedProps.value.monacoEnv){var env=cur.memoizedProps.value.monacoEnv;if(env.editor&&typeof env.editor.getEditors==="function"){var eds=env.editor.getEditors();if(eds.length>0){var model=eds[0].getModel();var markers=env.editor.getModelMarkers({resource:model.uri});return markers.map(function(m){return{line:m.startLineNumber,msg:m.message}})}}}cur=cur.return}return[]})()',
  returnByValue: true,
})).result?.value || [];

if (errors.length === 0) {
  console.log('Compiled clean — 0 errors');
} else {
  console.log(`${errors.length} errors:`);
  errors.forEach(e => console.log(`  Line ${e.line}: ${e.msg}`));
}

await c.close();
