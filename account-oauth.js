import {mountAccountOAuth} from './auth-ui.js?rev=oauth-brand-originals-v1';

const section=document.querySelector('#oauth-login');
function refreshOAuthLogin(){
 if(section?.isConnected)void mountAccountOAuth(section);
}
refreshOAuthLogin();
// A completed logout must restore the available sign-in methods without reload.
window.addEventListener('fh:auth-session-change',refreshOAuthLogin);
