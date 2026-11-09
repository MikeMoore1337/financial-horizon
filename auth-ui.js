/** Optional account area. Never sends IndexedDB data; guest mode is default. */
const PROVIDER_LABELS = Object.freeze({
  google: 'Войти через Google',
  yandex: 'Войти через Яндекс ID',
  vk: 'Войти через VK ID',
  telegram: 'Войти через Telegram',
});
const PROVIDER_ORDER = Object.keys(PROVIDER_LABELS);

export function allowedProviderIds(payload) {
  if (!payload || payload.enabled !== true || !Array.isArray(payload.providers)) return [];
  return PROVIDER_ORDER.filter(id => payload.providers.includes(id));
}

export function providerHref(id) {
  if (!Object.prototype.hasOwnProperty.call(PROVIDER_LABELS,id)) throw Error('Неизвестный способ входа');
  return './api/auth/oauth/' + id + '/start';
}

export function providerLabel(id) {
  return PROVIDER_LABELS[id] ?? null;
}

export async function showCloudAuth(section, {fetcher=fetch}={}) {
  if (!section?.isConnected) return;
  try {
    const r=await fetcher('./api/auth/providers',{cache:'no-store',credentials:'same-origin'});
    if (!r.ok) return;
    const data=await r.json(), providers=allowedProviderIds(data);
    if (!providers.length||!section.isConnected) return;
    section.hidden=false;
    section.replaceChildren();
    const title=document.createElement('h2');
    title.textContent='Способы входа';
    const info=document.createElement('p');
    info.textContent='Вы можете войти через выбранный сервис. Без входа бухгалтерия продолжает работать локально на этом устройстве.';
    section.append(title,info);
    const me=await fetcher('./api/auth/email/me',{cache:'no-store',credentials:'same-origin'});
    if (!me.ok || !section.isConnected) return;
    const session=await me.json();
    const actions=document.createElement('div');
    actions.className='setting-actions oauth-actions';
    if(session.authenticated===true){
      const signed=document.createElement('p');
      signed.textContent='Вы вошли в аккаунт. Финансовые данные синхронизируются только после отдельного включения облачного режима.';
      const button=document.createElement('button');
      button.className='button-secondary';
      button.type='button';
      button.dataset.action='cloud-logout';
      button.textContent='Выйти из аккаунта';
      section.append(signed);
      actions.append(button);
    }else{
      for(const id of providers){
        const a=document.createElement('a');
        a.className='button-secondary oauth-button';
        a.href=providerHref(id);
        a.textContent=providerLabel(id);
        actions.append(a);
      }
    }
    section.append(actions);
  }catch{
    // Offline-first and local-only modes must not reveal remote errors as app errors.
    if(section?.isConnected) section.hidden=true;
  }
}

export async function cloudLogout({fetcher=fetch}={}) {
  const res=await fetcher('./api/auth/email/logout',{method:'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},body:'{}'});
  if(!res.ok) throw Error('Не удалось завершить сеанс');
}


/** Approved design C - fail-closed OAuth choices below the existing email form. */
const PROVIDER_ICONS=Object.freeze({
  google:'./assets/providers/google.svg',
  yandex:'./assets/providers/yandex.svg',
  vk:'./assets/providers/vk.svg',
  telegram:'./assets/providers/telegram.svg'
});

/**
 * Reveal only server-advertised, configured providers to signed-out users.
 * Never reads financial data or stores provider tokens in browser storage.
 */
export async function mountAccountOAuth(section,{fetcher=fetch,documentRef=document}={}){
  if(!section?.isConnected)return false;
  section.hidden=true;
  section.dataset.ready='false';
  const buttons=section.querySelector('#oauth-options');
  if(!buttons)return false;
  buttons.replaceChildren();
  try{
    const response=await fetcher('./api/auth/providers',{
      credentials:'same-origin',cache:'no-store'
    });
    if(!response.ok)return false;
    const providers=allowedProviderIds(await response.json());
    if(!providers.length||!section.isConnected)return false;
    // A live email/OAuth session must not be shown another login menu.
    const me=await fetcher('./api/auth/email/me',{
      credentials:'same-origin',cache:'no-store'
    });
    if(!me.ok||!section.isConnected)return false;
    const current=await me.json();
    if(current?.authenticated!==false)return false;
    const fragment=documentRef.createDocumentFragment();
    for(const id of providers){
      const link=documentRef.createElement('a');
      link.href=providerHref(id);
      link.className='oauth-provider-link';
      const img=documentRef.createElement('img');
      img.className='oauth-provider-icon';
      img.src=PROVIDER_ICONS[id];
      img.alt='';
      img.width=24;img.height=24;
      const label=documentRef.createElement('span');
      label.className='oauth-provider-label';
      label.textContent=providerLabel(id);
      const chevron=documentRef.createElement('span');
      chevron.className='oauth-provider-chevron';
      chevron.textContent='›';
      chevron.setAttribute('aria-hidden','true');
      link.append(img,label,chevron);
      fragment.append(link);
    }
    buttons.replaceChildren(fragment);
    section.dataset.ready='true';
    const selected=documentRef.querySelector('.auth-modes [data-mode="login"]');
    section.hidden=selected?.getAttribute('aria-current')!=='page';
    return !section.hidden;
  }catch{
    // Staged, disabled, offline or malformed OAuth configuration stays hidden.
    section.hidden=true;
    section.dataset.ready='false';
    buttons.replaceChildren();
    return false;
  }
}
