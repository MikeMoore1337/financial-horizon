import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

const read=(name)=>readFileSync(new URL('../'+name,import.meta.url));
const utf8=(name)=>read(name).toString('utf8');
const gitBlobSha=(bytes)=>createHash('sha1')
  .update(Buffer.from('blob '+bytes.length+'\0')).update(bytes).digest('hex');

const authenticAssets=Object.freeze({
  'google.svg':'c0669b38ff8d0b21fd6a0edbc1d2fddbe576d60f',
  'vk.svg':'03e50bd8914df1aea2fef2914e3258562aa5aa3d',
  'telegram.svg':'ae107ff4bc7e4e889a94b1fb2cf57c5ac6bf6c6d',
  'yandex.webp':'476663bcacd848b86ecb4e7ae5141bec097d2af7',
});

test('branded icons match independently pinned source byte hashes',()=>{
  for(const [filename,sourceHash] of Object.entries(authenticAssets)){
    const bytes=read('assets/providers/'+filename);
    assert.equal(gitBlobSha(bytes),sourceHash,filename);
    assert.ok(bytes.length>200&&bytes.length<32000,filename);
    if(filename.endsWith('.svg')){
      const xml=bytes.toString('utf8');
      assert.match(xml,/^<svg\b[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
      assert.match(xml,/<path\b/);
      assert.doesNotMatch(xml,/<(?:script|foreignObject|image|iframe)\b|onload=|onerror=|xlink:href|(?:href|src)=["\x27]https?:\/\//i);
    }else{
      assert.equal(bytes.toString('ascii',0,4),'RIFF');
      assert.equal(bytes.toString('ascii',8,12),'WEBP');
    }
  }
});

test('approved OAuth labels, destinations, order and original-brand resources remain local',()=>{
  const js=utf8('auth-ui.js');
  const expected=[
    ['google','google.svg'],
    ['yandex','yandex.webp'],
    ['vk','vk.svg'],
    ['telegram','telegram.svg'],
  ];
  for(const [id,asset] of expected){
    assert.match(js,new RegExp(id+":'\\./assets/providers/"+asset.replace('.','\\.')+"'"));
  }
  assert.doesNotMatch(js,/assets\/providers\/yandex\.svg/);
  assert.match(js,/return '\.\/api\/auth\/oauth\/' \+ id \+ '\/start'/);
  assert.match(js,/allowedProviderIds\(await response\.json\(\)\)/);
});

test('all four official brand assets are part of offline shell without caching API',()=>{
  const account=utf8('account.html');
  const bridge=utf8('account-oauth.js');
  const worker=utf8('sw.js');
  const style=utf8('account.css');
  assert.match(account,/account-oauth\.js\?rev=oauth-brand-originals-v1/);
  assert.match(bridge,/auth-ui\.js\?rev=oauth-brand-originals-v1/);
  for(const filename of Object.keys(authenticAssets)){
    assert.ok(worker.includes("'./assets/providers/"+filename+"'"),filename);
  }
  assert.match(worker,/auth-ui\.js\?rev=oauth-brand-originals-v1/);
  assert.match(worker,/url\.pathname\.startsWith\('\/api\/'\)/);
  assert.match(style,/\.oauth-provider-icon\[src\$="\/google\.svg"\]\{[^}]*background:#fff/);
});

test('future backend-only OAuth releases validate the real Yandex WebP too',()=>{
  const script=utf8('scripts/fh_oauth_production_release.py');
  assert.match(script,/"assets\/providers\/yandex\.webp"/);
  assert.match(script,/verify_predeployed_four_provider_ui/);
});
