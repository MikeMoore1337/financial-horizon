import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const css=readFileSync(new URL('../styles.css',import.meta.url),'utf8');
const rule=name=>{
  const marker=name+'{';
  const start=css.indexOf(marker);
  return start<0 ? '' : css.slice(start+marker.length,css.indexOf('}',start));
};

test('desktop workspace is not capped at the old 1500px width',()=>{
 const page=rule('.page');
 const max=Number(page.match(/max-width:(\d+)px/)?.[1]);
 assert.ok(max>=2560,'Desktop page must expand on 2K displays');
 assert.match(page,/width:100%/);
 assert.match(page,/padding:34px clamp\(/);
});

test('overview uses balanced columns and aligns lower cards',()=>{
 const grid=rule('.overview-grid');
 assert.match(grid,/grid-template-columns:minmax\(0,1\.17fr\) minmax\(320px,1fr\)/);
 assert.match(css,/\.overview-column\{[^}]*display:flex;flex-direction:column/);
 assert.match(rule('.overview-column>.surface:last-child'),/flex:1/);
});

test('tablet and mobile still collapse into a single column',()=>{
 assert.match(css,/@media\(max-width:1100px\)\{\.overview-grid,\.cal-layout,\.loan-grid\{grid-template-columns:minmax\(0,1fr\)/);
 assert.match(css,/@media\(max-width:760px\)\{\.sidebar\{display:none\}/);
});
