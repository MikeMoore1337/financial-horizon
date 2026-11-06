/* Account registration with no external calls in guest or disabled mode. */
const $=selector=>document.querySelector(selector);
const MODES={
 login:["Войти по email","Войти"],
 register:["Создать аккаунт","Отправить подтверждение"],
 resend:["Повторная отправка письма","Отправить письмо"],
 reset:["Восстановление доступа","Отправить ссылку"],
 verify:["Подтверждение email","Подтвердить и задать пароль"],
 "reset-confirm":["Новый пароль","Сохранить пароль"]
};
const hashValues=new URLSearchParams(location.hash.replace(/^#/,""));
let token=hashValues.get("verify-email")||hashValues.get("reset-password")||null;
let mode=hashValues.has("verify-email")?"verify":hashValues.has("reset-password")?"reset-confirm":"login";
// Remove sensitive token before loading any external challenge scripts.
if(location.hash)history.replaceState(null,"",location.pathname+location.search);
const VALID_TOKEN=/^[a-zA-Z0-9_-]{32,256}$/;
if(token&&!VALID_TOKEN.test(token)){token=null;mode="login";}
let config={enabled:false,sitekey:""};
let challengeToken=null,widgetId=null,activeScript=null,renderVersion=0;
const challengeModes=new Set(["register","resend","reset"]);
const routes={
 login:"login",register:"register",resend:"resend",reset:"reset/request",
 verify:"verify","reset-confirm":"reset/confirm"
};

function feedback(text,status="info"){
 const el=$("#auth-feedback");el.textContent=text;el.dataset.status=status;
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
 if(!config.enabled)return;
 try{
  const response=await fetch('./api/auth/email/me',{cache:'no-store',credentials:'same-origin'});
  if(!response.ok)return;
  const result=await response.json();
  const authenticated=result.authenticated===true&&typeof result.user?.email==='string';
  $('#session-panel').hidden=!authenticated;
  $('#auth-form').hidden=authenticated;
  $('.auth-modes').hidden=authenticated;
  $('.auth-actions [data-mode="resend"]').hidden=authenticated;
  $('#session-email').textContent=authenticated
    ?'Вы вошли как '+result.user.email+'. Синхронизация финансовых данных ещё не включена.'
    :'';
 }catch{
  // Local-first accounting is unaffected by a temporary authorization outage.
 }
}

async function logout(){
 try{
  await request('logout',{});
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
  await request(routes[selected],payload);
  if(selected==="login"||selected==="verify"){
   token=null;
   feedback("Вы вошли в аккаунт. Пока финансовые данные остаются на этом устройстве.","success");
   await refreshSession();
  }else if(selected==="reset-confirm"){
   token=null;
   feedback("Пароль изменён. Теперь можно войти.","success");
   activate("login",{preserveFeedback:true});
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
 document.querySelectorAll("[data-mode]").forEach(button=>button.addEventListener("click",()=>activate(button.dataset.mode)));
 activate(mode);
 try{
  const res=await fetch("./api/auth/email/config",{cache:"no-store",credentials:"same-origin"});
  if(!res.ok)throw Error("disabled");
  config=await res.json();
  if(!config.enabled||!config.sitekey)throw Error("disabled");
  updateButton();await challengeFor(mode);await refreshSession();
 }catch{
  config={enabled:false,sitekey:""};
  feedback("Регистрация пока не включена. Можно пользоваться бухгалтерией без аккаунта.","info");
  updateButton();
 }
}
void init();
