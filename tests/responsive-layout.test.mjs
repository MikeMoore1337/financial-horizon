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

test('mobile floating navigation stays compact above the iPhone safe area',()=>{
 const mobile=css.slice(css.indexOf('@media(max-width:760px)'));
 const mobileRule=selector=>{
  const marker=selector+'{';
  const start=mobile.indexOf(marker);
  assert.ok(start>=0,'Missing mobile '+selector);
  return mobile.slice(start+marker.length,mobile.indexOf('}',start));
 };
 const dock=mobileRule('.bottom-nav');
 assert.match(dock,/bottom:var\(--fh-dock-bottom\)/);
 assert.match(dock,/padding:8px 6px(?:;|$)/);
 assert.doesNotMatch(dock,/padding:[^;]*safe-area-inset-bottom/,'Safe area must stay outside the floating panel');
 assert.match(mobileRule('.bottom-nav button'),/min-height:49px/);
 assert.match(mobileRule('.page'),/padding:23px 16px calc\(78px \+ var\(--fh-dock-bottom\)\)/);
 assert.match(mobileRule('.toast'),/bottom:calc\(76px \+ var\(--fh-dock-bottom\)\)/);
});

test('mobile dock uses the YFC-style safe-area correction and preserves symmetric button padding',()=>{
 const mobile=css.slice(css.indexOf('@media(max-width:760px)'));
 assert.match(mobile,/body\{--fh-dock-bottom:max\(12px,calc\(env\(safe-area-inset-bottom,0px\) - 14px\)\)\}/);
 assert.match(mobile,/\.bottom-nav\{[^}]*padding:8px 6px;border-radius:24px/);
 for(const inset of [0,20,34,47]) {
  const dockGap=Math.max(12,inset-14);
  const dockHeight=49+8+8+2;
  assert.ok(78+dockGap>=dockGap+dockHeight+10,'Page content must clear dock');
  assert.ok(76+dockGap>=dockGap+dockHeight+8,'Toast must clear dock');
 }
});


test('mobile filter strip wraps to two columns without horizontal overflow',()=>{
 assert.match(css, /@media\(max-width:380px\)\{\.filter-bar \.segment\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\);width:100%;max-width:100%/);
 assert.match(css, /\.filter-bar \.segment button\{min-width:0;overflow-wrap:anywhere;text-align:center/);
});


test('narrow headers wrap by 430px on systems with wider font metrics',()=>{
 assert.match(css, /@media\(max-width:430px\)\{\.page-header\{flex-wrap:wrap\}\.page-header \.header-tools\{margin-left:auto\}\}/);
});
