/* Only the auth API controls session state. Financial records stay in IndexedDB. */
export function createEmailSession(request=fetch){
 let email=null,revision=0,busy=false;
 return {
  get email(){return email;},
  get busy(){return busy;},
  async refresh(){
   if(busy)return false;
   const current=++revision;
   try{
    const response=await request('./api/auth/email/me',{credentials:'same-origin',cache:'no-store'});
    if(!response.ok)return false;
    const result=await response.json();
    if(current!==revision)return false;
    email=result?.authenticated===true&&typeof result.user?.email==='string'?result.user.email:null;
    return true;
   }catch{
    // The local-first ledger remains available when auth is offline or gated.
    return false;
   }
  },
  async logout(){
   if(busy||!email)return false;
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
    return true;
   }finally{busy=false;}
  }
 };
}
