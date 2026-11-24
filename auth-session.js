/* Only the auth API controls session state. Financial records stay in IndexedDB. */
export function createEmailSession(request=fetch){
 let email=null,userId=null,revision=0,busy=false,lastRefreshFailure=null;
 return {
  get email(){return email;},
  get userId(){return userId;},
  get busy(){return busy;},
  get lastRefreshFailure(){return lastRefreshFailure;},
  async refresh(){
   if(busy)return false;
   const current=++revision;
   let response;
   try{
    response=await request('./api/auth/email/me',{credentials:'same-origin',cache:'no-store'});
   }catch{
    if(current===revision)lastRefreshFailure='network';
    return false;
   }
   try{
    if(!response.ok){if(current===revision)lastRefreshFailure='http';return false;}
    const result=await response.json();
    if(current!==revision)return false;
    lastRefreshFailure=null;
    const valid=result?.authenticated===true&&typeof result.user?.id==='string'&&/^[a-f0-9]{32}$/.test(result.user.id)&&(result.user.email===null||typeof result.user.email==='string');
    email=valid?result.user.email:null;
    userId=valid?result.user.id:null;
    return true;
   }catch{
    if(current===revision)lastRefreshFailure='invalid';
    return false;
   }
  },
  async logout(){
   if(busy||!userId)return false;
   busy=true;
   ++revision; // Invalidate any previously started /me request.
   try{
    const response=await request('./api/auth/email/logout',{
     method:'POST',credentials:'same-origin',cache:'no-store',
     headers:{'Content-Type':'application/json'},body:'{}'
    });
    if(!response.ok)throw Error('Не удалось выйти из аккаунта. Повторите попытку.');
    const result=await response.json();
    if(result?.ok!==true)throw Error('Сервер не подтвердил выход. Повторите попытку.');
    email=null;
    userId=null;
    return true;
   }finally{busy=false;}
  }
 };
}
