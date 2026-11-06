import test from 'node:test';
import assert from 'node:assert/strict';
import {createEmailSession} from '../auth-session.js';

const signedIn={ok:true,json:async()=>({authenticated:true,user:{id:'a'.repeat(32),email:'test@example.com'}})};
const signedOut={ok:true,json:async()=>({authenticated:false,user:null})};
const logoutOk={ok:true,json:async()=>({ok:true})};

test('authenticated session logs out through POST without touching local finances',async()=>{
 const calls=[];
 const session=createEmailSession(async(url,options)=>{
  calls.push({url,options});
  return url.endsWith('/me')?signedIn:logoutOk;
 });
 assert.equal(await session.refresh(),true);
 assert.equal(session.email,'test@example.com');
 assert.equal(session.userId,'a'.repeat(32));
 assert.equal(await session.logout(),true);
 assert.equal(session.email,null);
 assert.equal(session.userId,null);
 assert.equal(session.busy,false);
 assert.equal(calls.length,2);
 assert.equal(calls[0].url,'./api/auth/email/me');
 assert.deepEqual(calls[0].options,{credentials:'same-origin',cache:'no-store'});
 assert.equal(calls[1].url,'./api/auth/email/logout');
 assert.deepEqual(calls[1].options,{
  method:'POST',credentials:'same-origin',cache:'no-store',
  headers:{'Content-Type':'application/json'},body:'{}'
 });
});

test('guest and disabled API never expose a logout action',async()=>{
 let posts=0;
 const session=createEmailSession(async(url)=>{
  if(url.endsWith('/logout'))posts++;
  return {ok:false,status:403,json:async()=>({})};
 });
 assert.equal(await session.refresh(),false);
 assert.equal(session.email,null);
 assert.equal(await session.logout(),false);
 assert.equal(posts,0);
});

test('logout failure preserves the visible signed-in state for retry',async()=>{
 let denied=false;
 const session=createEmailSession(async(url)=>{
  if(url.endsWith('/me'))return signedIn;
  if(denied)return logoutOk;
  denied=true;
  return {ok:false,status:503};
 });
 await session.refresh();
 await assert.rejects(session.logout(),/Не удалось выйти/);
 assert.equal(session.email,'test@example.com');
 assert.equal(session.busy,false);
 assert.equal(await session.logout(),true);
 assert.equal(session.email,null);
});

test('a logout response without confirmation cannot hide the session',async()=>{
 const session=createEmailSession(async(url)=>url.endsWith('/me')?signedIn:{
  ok:true,json:async()=>({ok:false})
 });
 await session.refresh();
 await assert.rejects(session.logout(),/не подтвердил выход/);
 assert.equal(session.email,'test@example.com');
});

test('refresh reports signed-out status and never trusts a localStorage flag',async()=>{
 const session=createEmailSession(async()=>signedOut);
 assert.equal(await session.refresh(),true);
 assert.equal(session.email,null);
});

test('stale GET /me cannot restore a session after logout',async()=>{
 let releaseGet;
 let meCount=0;
 const session=createEmailSession(async url=>{
  if(url.endsWith('/logout'))return logoutOk;
  meCount++;
  if(meCount===1)return signedIn;
  return new Promise(resolve=>{releaseGet=resolve;});
 });
 assert.equal(await session.refresh(),true);
 const pending=session.refresh();
 assert.equal(await session.logout(),true);
 releaseGet(signedIn);
 assert.equal(await pending,false);
 assert.equal(session.email,null);
});

test('repeated logout while request is pending sends only one POST',async()=>{
 let releaseLogout,posts=0;
 const session=createEmailSession(async url=>{
  if(url.endsWith('/me'))return signedIn;
  posts++;
  return new Promise(resolve=>{releaseLogout=resolve;});
 });
 await session.refresh();
 const first=session.logout();
 assert.equal(session.busy,true);
 assert.equal(await session.logout(),false);
 assert.equal(posts,1);
 releaseLogout(logoutOk);
 assert.equal(await first,true);
 assert.equal(session.busy,false);
});
