import {validateState} from './finance.js';
const bytes=source=>new Uint8Array(source);
const b64=u8=>{let binary=''; for(let i=0;i<u8.length;i+=0x8000)binary+=String.fromCharCode(...u8.subarray(i,i+0x8000));return btoa(binary);};
const unb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
async function keyFromPassword(password,salt,iterations){
 const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'PBKDF2',hash:'SHA-256',iterations,salt},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function encryptBackup(state,password){
 validateState(state);if(password.length<12)throw Error('Для резервной копии нужен пароль не короче 12 символов');
 const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12)),iterations=310000;
 const key=await keyFromPassword(password,salt,iterations);
 const plain=new TextEncoder().encode(JSON.stringify(state));
 const cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain);
 return JSON.stringify({format:'financial-horizon-backup',version:1,kdf:'PBKDF2-SHA256',iterations,salt:b64(salt),iv:b64(iv),ciphertext:b64(bytes(cipher))},null,2);
}
export async function decryptBackup(text,password){
 if(text.length>8_000_000)throw Error('Резервная копия слишком большая');
 let data;try{data=JSON.parse(text);}catch{throw Error('Файл не является резервной копией');}
 if(data.format!=='financial-horizon-backup'||data.version!==1||data.kdf!=='PBKDF2-SHA256'||data.iterations!==310000||typeof data.salt!=='string'||typeof data.iv!=='string'||typeof data.ciphertext!=='string') throw Error('Неизвестный формат шифрованной копии');
 try {
  const key=await keyFromPassword(password,unb64(data.salt),data.iterations);
  const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(data.iv)},key,unb64(data.ciphertext));
  return validateState(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plain)));
 } catch { throw Error('Неверный пароль или повреждённый файл'); }
}
