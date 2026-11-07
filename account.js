/* Account registration with no external calls in guest or disabled mode. */
const $=selector=>document.querySelector(selector);
const MODES={
 login:["Войти по email","Войти по email"],
 register:["Создать аккаунт","Отправить подтверждение"],
 resend:["Повторная отправка письма","Отправить письмо"],
 reset:["Восстановление доступа","Отправить ссылку"],
 verify:["Подтверждение email","Подтвердить и задать пароль"],
 "reset-confirm":["Новый пароль","Сохранить пароль"]
};
const hashValues=new URLSearchParams(location.hash.replace(/^#/,""));
let token=hashValues.get("verify-email")||hashValues.get("reset-password")||null;
let changeToken=hashValues.get("confirm-email-change")||null;
let mode=hashValues.has("verify-email")?"verify":hashValues.has("reset-password")?"reset-confirm":"login";
// Remove sensitive token before loading any external challenge scripts.
if(location.hash)history.replaceState(null,"",location.pathname+location.search);
const VALID_TOKEN=/^[a-zA-Z0-9_-]{32,256}$/;
if(token&&!VALID_TOKEN.test(token)){token=null;mode="login";}
if(changeToken&&!VALID_TOKEN.test(changeToken))changeToken=null;
let config={enabled:false,sitekey:""};
let activeAccountId=null;
let challengeToken=null,widgetId=null,activeScript=null,renderVersion=0;
let changeChallengeToken=null,changeWidgetId=null;
const challengeModes=new Set(["register","resend","reset"]);
const routes={
 login:"login",register:"register",resend:"resend",reset:"reset/request",
 verify:"verify","reset-confirm":"reset/confirm"
};

function feedback(text,status="info",title=""){
 const el=$("#auth-feedback");
 el.replaceChildren();
 if(title){
  const heading=document.createElement("strong");
  heading.textContent=title;
  el.append(heading);
 }
 if(text){
  const detail=document.createElement("span");
  detail.textContent=text;
  el.append(detail);
 }
 el.dataset.status=status;
}

function updateButton(){
 $("#auth-submit").disabled=!config.enabled||
  (challengeModes.has(mode)&&!challengeToken);
}

function challengeReady(){
 if(activeScript)return activeScript;
 activeScript=new Promise((resolve,reject)=>{
  if(window.turnstile){resolve();return;}
  const s=document.createElement("script");
  s.src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
  s.async=true;
  s.onload=()=>{if(window.turnstile)resolve();else{s.remove();reject(Error("Не удалось загрузить защиту"));}};
  s.onerror=()=>{s.remove();reject(Error("Не удалось загрузить защиту"));};
  document.head.append(s);
 });
 // A failed CDN request must not permanently poison all subsequent attempts.
 activeScript=activeScript.catch(error=>{activeScript=null;throw error;});
 return activeScript;
}

async function challengeFor(currentMode){
 const version=++renderVersion;
 challengeToken=null;
 if(widgetId!==null&&window.turnstile){window.turnstile.remove(widgetId);widgetId=null;}
 const place=$("#turnstile-container");place.replaceChildren();
 place.hidden=!challengeModes.has(currentMode);
 updateButton();
 if(!challengeModes.has(currentMode)||!config.enabled)return;
 try {
  await challengeReady();
  if(version!==renderVersion||mode!==currentMode)return;
  const action=currentMode==="reset"?"reset":currentMode;
  widgetId=window.turnstile.render(place,{
   sitekey:config.sitekey,action,theme:"auto",
   callback:value=>{if(version===renderVersion&&mode===currentMode){challengeToken=value;feedback("");updateButton();}},
   "expired-callback":()=>{
    if(version===renderVersion&&mode===currentMode){
     challengeToken=null;updateButton();
     feedback("Срок защитной проверки истёк. Выберите действие ещё раз.","error");
    }
   },
   "timeout-callback":()=>{
    if(version===renderVersion&&mode===currentMode){
     challengeToken=null;updateButton();
     feedback("Проверка не завершена. Выберите действие ещё раз.","error");
    }
   },
   "error-callback":()=>{
    if(version===renderVersion&&mode===currentMode){
     challengeToken=null;updateButton();
     feedback("Не удалось пройти защитную проверку. Повторите попытку.","error");
    }
    return true;
   }
  });
 }catch{
  if(version===renderVersion)feedback("Защитная проверка недоступна. Попробуйте позже.","error");
 }
}

async function renderChangeEmailChallenge(){
 if(!config.enabled||config.capabilities?.email_change!==true||changeWidgetId!==null)return;
 try{
  await challengeReady();
  if(changeWidgetId!==null||$("#change-email-panel").hidden)return;
  changeWidgetId=window.turnstile.render($("#change-email-challenge"),{
   sitekey:config.sitekey,action:"change-email",theme:"auto",
   callback:value=>{changeChallengeToken=value;$("#change-email-submit").disabled=false;},
   "expired-callback":()=>{changeChallengeToken=null;$("#change-email-submit").disabled=true;},
   "error-callback":()=>{changeChallengeToken=null;$("#change-email-submit").disabled=true;return true;}
  });
 }catch{
  feedback("Не удалось загрузить защитную проверку смены email.","error");
 }
}
async function requestEmailChange(event){
 event.preventDefault();
 if(!config.enabled||config.capabilities?.email_change!==true||!changeChallengeToken)return;
 const button=$("#change-email-submit");
 if(button.disabled)return;
 button.disabled=true;
 try{
  await request("change/request",{
   email:$("#change-email").value.trim(),
   password:$("#change-email-password").value,
   challenge:changeChallengeToken
  });
  $("#change-email-password").value="";
  feedback("Если новый адрес доступен, письмо со ссылкой для подтверждения будет отправлено. Проверьте «Входящие» и «Спам». Подтверждение выполняется в течение часа из авторизованного аккаунта.","success","Проверьте новый email");
 }catch(error){
  feedback(error instanceof Error?error.message:"Не удалось запросить смену email","error");
 }finally{
  changeChallengeToken=null;
  if(changeWidgetId!==null&&window.turnstile)window.turnstile.reset(changeWidgetId);
  button.disabled=true;
 }
}
async function confirmEmailChange(){
 if(!changeToken||!config.enabled||config.capabilities?.email_change!==true)return;
 const result=await request("change/confirm",{token:changeToken});
 if(result.ok!==true)throw Error("Сервер не подтвердил изменение email");
 changeToken=null;
 await refreshSession();
 feedback("Новый адрес подтверждён. Другие сеансы завершены, а текущий сохранён.","success","Email изменён");
}

function activate(next,{preserveFeedback=false}={}){
 if(!(next in MODES))return;
 mode=next;$("#form-heading").textContent=MODES[next][0];$("#auth-submit").textContent=MODES[next][1];
 if(!preserveFeedback)feedback("");
 const needsEmail=!["verify","reset-confirm"].includes(next);
 const needsPassword=["login","verify","reset-confirm"].includes(next);
 $("#email-label").hidden=!needsEmail;
 $("#email").required=needsEmail;
 $("#password-label").hidden=!needsPassword;
 $("#password").required=needsPassword;
 $("#password").autocomplete=next==="login"?"current-password":"new-password";
 $("#password").minLength=next==="login"?1:12;
 $("#password").value="";
 document.querySelectorAll("[data-mode]").forEach(el=>el.setAttribute("aria-current",el.dataset.mode===next?"page":"false"));
 // The resend endpoint is for email verification, never password recovery.
 $('.auth-actions [data-mode="resend"]').hidden=!["register","resend","verify"].includes(next);
 $('.auth-actions [data-mode="reset"]').hidden=next!=="login";
 $("#oauth-login").hidden=next!=="login"||$("#oauth-login").dataset.ready!=="true";
 void challengeFor(next);
}

async function request(path,body){
 const response=await fetch("./api/auth/email/"+path,{
  method:"POST",credentials:"same-origin",cache:"no-store",
  headers:{"Content-Type":"application/json"},body:JSON.stringify(body)
 });
 let data={};
 try {data=await response.json();}catch{}
 if(!response.ok)throw Error(typeof data.detail==="string"?data.detail:"Операция не выполнена");
 return data;
}

async function refreshSession(){
 if(!config.enabled)return false;
 try{
  const response=await fetch('./api/auth/email/me',{cache:'no-store',credentials:'same-origin'});
  if(!response.ok)return false;
  const result=await response.json();
  const authenticated=result.authenticated===true&&typeof result.user?.id==='string'&&/^[a-f0-9]{32}$/.test(result.user.id)&&(result.user.email===null||typeof result.user.email==='string');
  activeAccountId=authenticated&&typeof result.user?.id==='string'&&/^[a-f0-9]{32}$/.test(result.user.id)
   ?result.user.id:null;
  if(authenticated){
   try{sessionStorage.removeItem('fh-guest-session-v2');}catch{}
  }
  $('#session-panel').hidden=!authenticated;
  $('#change-email-panel').hidden=!authenticated||typeof result.user?.email!=='string'||config.capabilities?.email_change!==true;
  if(authenticated&&config.capabilities?.email_change===true)void renderChangeEmailChallenge();
  $('#auth-form').hidden=authenticated;
  $("#oauth-login").hidden=authenticated||mode!=="login"||$("#oauth-login").dataset.ready!=="true";
  $('.auth-modes').hidden=authenticated;
  $('.auth-actions').hidden=authenticated;
  $('.auth-actions [data-mode="resend"]').hidden=authenticated||mode==="reset"||mode==="reset-confirm";
  $('#form-heading').textContent=authenticated?"Аккаунт":MODES[mode][0];
  $('#form-description').textContent=authenticated
    ?"Вы вошли в Финансовый горизонт."
    :"Для доступа к аккаунту нужен подтверждённый email.";
  $('#session-email').textContent=authenticated
    ?(result.user.email?'Вы вошли как '+result.user.email+'. ':'Вы вошли через внешний сервис. ')+'Синхронизация финансовых данных ещё не включена.'
    :'';
  return authenticated;
 }catch{
  // Local-first accounting is unaffected by a temporary authorization outage.
  return false;
 }
}

async function logoutOthers(){
 const button=$("#auth-logout-others");
 if(button.disabled||button.hidden)return;
 button.disabled=true;
 try{
  const result=await request("logout-others",{});
  if(result.ok!==true)throw Error("Сервер не подтвердил завершение других сеансов");
  feedback("Вход на остальных устройствах завершён. Здесь вы остались в аккаунте.","success");
 }catch(error){
  feedback(error instanceof Error?error.message:"Не удалось завершить другие сеансы","error");
 }finally{
  button.disabled=false;
 }
}

async function logout(){
 try{
  const formerId=activeAccountId;
  const result=await request('logout',{});
  if(result.ok!==true)throw Error('Сервер не подтвердил выход');
  if(formerId){
   try{
    const channel=new BroadcastChannel('fh-auth-session-v2');
    channel.postMessage({type:'logout',userId:formerId});
    channel.close();
   }catch{}
  }
  changeChallengeToken=null;
  if(changeWidgetId!==null&&window.turnstile){
   window.turnstile.remove(changeWidgetId);
   changeWidgetId=null;
  }
  $("#change-email-submit").disabled=true;
  $("#change-email-password").value="";
  await refreshSession();
  activate('login');
  feedback('Сеанс завершён. Локальная бухгалтерия сохранена.','success');
 }catch(error){
  feedback(error instanceof Error?error.message:'Не удалось выйти','error');
 }
}

async function submit(event){
 event.preventDefault();
 if(!config.enabled)return;
 const selected=mode;
 const button=$("#auth-submit");
 button.disabled=true;
 feedback("Проверяем данные...");
 const email=$("#email").value.trim(),password=$("#password").value;
 const payload=selected==="verify"||selected==="reset-confirm"
    ?{token,password}
    :selected==="login"?{email,password}
    :{email,challenge:challengeToken};
 try{
  const result=await request(routes[selected],payload);
  if(selected==="login"||selected==="verify"){
   if(result.authenticated!==true)throw Error("Не удалось подтвердить вход. Повторите попытку.");
   // Do not navigate to the ledger until the browser can read its new session.
   if(!await refreshSession()){
    throw Error("Вход выполнен, но браузер не подтвердил сессию. Проверьте настройки cookies и повторите вход.");
   }
   token=null;
   if(changeToken){
    await confirmEmailChange();
    return;
   }
   // Re-enter the authenticated ledger instead of reusing an earlier guest tab.
   try{sessionStorage.removeItem('fh-guest-session-v2');}catch{}
   location.assign("./");
  }else if(selected==="reset-confirm"){
   token=null;
   feedback("Пароль изменён. Теперь можно войти.","success");
   activate("login",{preserveFeedback:true});
  }else if(selected==="reset"){
   feedback(
    "Если с этим адресом связан аккаунт, письмо со ссылкой на смену пароля будет отправлено. Проверьте папки «Входящие» и «Спам». Письмо может прийти через несколько минут. Если его нет, пройдите защитную проверку и отправьте запрос повторно.",
    "success","Запрос принят. Проверьте почту"
   );
  }else{
   feedback("Если адрес допускает действие, письмо с инструкцией будет отправлено.","success");
  }
 }catch(error){
  feedback(error instanceof Error?error.message:"Не удалось выполнить действие","error");
 }finally{
  if(challengeModes.has(selected)&&mode===selected){
    challengeToken=null;
    if(widgetId!==null&&window.turnstile){window.turnstile.reset(widgetId);}
  }
  updateButton();
 }
}

async function init(){
 try {
  const chosen=localStorage.getItem("fh-theme");
  if(chosen==="dark")document.body.dataset.theme="dark";
 }catch{}
 $("#auth-form").addEventListener("submit",submit);
 $("#auth-logout").addEventListener("click",logout);
 $("#auth-logout-others").addEventListener("click",logoutOthers);
 $("#change-email-form").addEventListener("submit",requestEmailChange);
 window.addEventListener("hashchange",()=>{
  const params=new URLSearchParams(location.hash.replace(/^#/,""));
  const candidate=params.get("confirm-email-change");
  if(!candidate)return;
  history.replaceState(null,"",location.pathname+location.search);
  if(!VALID_TOKEN.test(candidate)){
   feedback("Ссылка подтверждения email недействительна.","error");
   return;
  }
  changeToken=candidate;
  void (async()=>{
   if(await refreshSession()){
    try{await confirmEmailChange();}catch(error){
     feedback(error instanceof Error?error.message:"Не удалось подтвердить новый email","error");
    }
   }else{
    feedback("Сначала войдите по прежнему email, затем повторите подтверждение.","info");
   }
  })();
 });
 document.querySelectorAll("[data-mode]").forEach(button=>button.addEventListener("click",()=>activate(button.dataset.mode)));
 activate(mode);
 const oauthOutcome=new URLSearchParams(location.search);
 const oauthStatus=oauthOutcome.get('oauth');
 if(['failed','denied','linked'].includes(oauthStatus)){
  oauthOutcome.delete('oauth');
  const tail=oauthOutcome.toString();
  history.replaceState(null,'',location.pathname+(tail?'?'+tail:''));
  if(oauthStatus==='linked'){
   feedback('Новый способ входа привязан к вашему аккаунту.','success');
  }else if(oauthStatus==='denied'){
   feedback('Вход отменён. Вы можете выбрать другой способ.','error');
  }else{
   feedback('Не удалось войти через выбранный сервис. Повторите попытку.','error');
  }
 }
 try{
  const res=await fetch("./api/auth/email/config",{cache:"no-store",credentials:"same-origin"});
  if(!res.ok)throw Error("disabled");
  config=await res.json();
  if(!config.enabled||!config.sitekey)throw Error("disabled");
  $("#auth-logout-others").hidden=config.capabilities?.revoke_other_sessions!==true;
  updateButton();await challengeFor(mode);
  const authenticated=await refreshSession();
  if(changeToken){
   if(authenticated){
    try{await confirmEmailChange();}catch(error){
     feedback(error instanceof Error?error.message:"Не удалось подтвердить новый email","error");
    }
   }else{
    feedback("Для подтверждения нового адреса сначала войдите в существующий аккаунт по старому email. После входа подтверждение продолжится автоматически.","info");
   }
  }
 }catch{
  config={enabled:false,sitekey:""};
  feedback("Регистрация пока не включена. Можно пользоваться бухгалтерией без аккаунта.","info");
  updateButton();
 }
}
void init();
