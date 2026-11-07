import {mountAccountOAuth} from './auth-ui.js?rev=oauth-auth-v1';

const section=document.querySelector('#oauth-login');
if(section)void mountAccountOAuth(section);
