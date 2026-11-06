/** Optional account area. Never sends IndexedDB data; guest mode is default. */
const PROVIDER_LABELS = Object.freeze({
  telegram: 'Войти через Telegram',
  google: 'Войти через Google',
  yandex: 'Войти через Яндекс ID',
  vk: 'Войти через VK ID',
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
