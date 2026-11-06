// Локальный импорт пользовательского XLSX без внешних библиотек и сетевых запросов.
// Поддерживается форма двух расчётных периодов с кредитной таблицей.
// Не выполняем формулы Excel: читаются только сохранённые значения ячеек.
import {cents, payoffMonths} from './finance.js';

const MAX_FILE=4_000_000, MAX_PART=4_000_000, MAX_TOTAL=12_000_000;
const encoder=new TextDecoder('utf-8',{fatal:true});
const clean=value=>String(value??'').replace(/\u00a0/g,' ').trim();
const key=value=>clean(value).toLocaleLowerCase('ru-RU').replace(/\s+/g,' ');
const get=(row,col)=>row?.[col]??null;
function read32(view,pos){return view.getUint32(pos,true);}
function bad(message){throw new Error(message);}
function zipEntries(bytes){
 if(bytes.byteLength<22||bytes.byteLength>MAX_FILE)bad('XLSX повреждён или превышает 4 МБ');
 const dv=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
 let end=-1;
 for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--){
  if(read32(dv,i)===0x06054b50){end=i;break;}
 }
 if(end<0)bad('Файл не является поддерживаемым XLSX (ZIP)');
 if(dv.getUint16(end+4,true)||dv.getUint16(end+6,true))bad('Многотомные ZIP не поддерживаются');
 const count=dv.getUint16(end+10,true);
 const offset=read32(dv,end+16);
 if(!count||count>200||offset===0xffffffff)bad('Неподдерживаемый или слишком большой XLSX');
 const entries=new Map();let pos=offset,total=0;
 for(let i=0;i<count;i++){
  if(pos+46>bytes.length||read32(dv,pos)!==0x02014b50)bad('Повреждён каталог XLSX');
  const flags=dv.getUint16(pos+8,true),method=dv.getUint16(pos+10,true);
  const crc=read32(dv,pos+16),compressed=read32(dv,pos+20),plain=read32(dv,pos+24);
  const len=dv.getUint16(pos+28,true),extra=dv.getUint16(pos+30,true),comment=dv.getUint16(pos+32,true);
  const local=read32(dv,pos+42);
  if(pos+46+len+extra+comment>bytes.length)bad('Повреждено имя файла XLSX');
  const name=encoder.decode(bytes.subarray(pos+46,pos+46+len));
  pos+=46+len+extra+comment;
  if(flags&1||!(method===0||method===8))bad('Зашифрованные и нестандартные XLSX не поддерживаются');
  if(!name||name.startsWith('/')||name.includes('\\')||name.split('/').includes('..'))bad('Недопустимый путь внутри XLSX');
  if(plain>MAX_PART||compressed>MAX_FILE)bad('Лист XLSX слишком большой');
  total+=plain;if(total>MAX_TOTAL)bad('Суммарный размер XLSX превышает лимит');
  if(entries.has(name))bad('Повторяющийся путь внутри XLSX');
  if(local+30>bytes.length||read32(dv,local)!==0x04034b50)bad('Повреждён заголовок XLSX');
  const localName=dv.getUint16(local+26,true),localExtra=dv.getUint16(local+28,true);
  const dataAt=local+30+localName+localExtra;
  if(dataAt+compressed>bytes.length)bad('Файл XLSX обрезан');
  entries.set(name,{method,plain,crc,compressed:bytes.subarray(dataAt,dataAt+compressed)});
 }
 return entries;
}
function crc32(bytes){
 let crc=0xffffffff;
 for(const x of bytes){crc^=x;for(let i=0;i<8;i++)crc=(crc>>>1)^(crc&1?0xedb88320:0);}
 return (crc^0xffffffff)>>>0;
}
async function uncompress(entry){
 if(!entry)bad('В XLSX отсутствует обязательная часть');
 let out;
 if(entry.method===0){out=entry.compressed;}
 else {
  if(typeof DecompressionStream!=='function')bad('Этот браузер не поддерживает локальную распаковку XLSX');
  const reader=new Blob([entry.compressed]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks=[];let size=0;
  try {
   for(;;){const {value,done}=await reader.read();if(done)break;
    size+=value.byteLength;if(size>entry.plain||size>MAX_PART)bad('Превышен размер распакованной части XLSX');
    chunks.push(value);
   }
  }finally{reader.releaseLock();}
  out=new Uint8Array(size);let pos=0;for(const x of chunks){out.set(x,pos);pos+=x.byteLength;}
 }
 if(out.byteLength!==entry.plain||crc32(out)!==entry.crc)bad('Контрольная сумма XLSX не совпала');
 return out;
}
async function readXml(entries,name){
 const part=entries.get(name);
 if(!part)return null;
 const xml=encoder.decode(await uncompress(part));
 if(/<!DOCTYPE|<!ENTITY|<\?xml-stylesheet/i.test(xml))bad('Опасная XML-конструкция в XLSX');
 if(typeof DOMParser==='undefined')bad('В этом браузере недоступно чтение XML');
 const doc=new DOMParser().parseFromString(xml,'application/xml');
 if(doc.getElementsByTagName('parsererror').length)bad('Некорректный XML в XLSX');
 return doc;
}
const tag=(node,name)=>node?.getElementsByTagNameNS('*',name)[0]||null;
const tags=(node,name)=>Array.from(node?.getElementsByTagNameNS('*',name)||[]);
const text=node=>node?.textContent||'';
function sharedStrings(doc){
 if(!doc)return [];
 return tags(doc,'si').map(si=>tags(si,'t').map(text).join(''));
}
function parseCells(sheet,strings){
 const rows=[];let filled=0;
 for(const row of tags(sheet,'row')){
  const index=Number(row.getAttribute('r'))-1;
  if(!Number.isSafeInteger(index)||index<0||index>=500)bad('Слишком много строк XLSX');
  const cells=rows[index]||[];
  for(const cell of tags(row,'c')){
   const ref=cell.getAttribute('r')||'';
   const letters=/^([A-Z]{1,2})([0-9]+)$/.exec(ref);
   if(!letters||Number(letters[2])!==index+1)bad('Некорректная ссылка на ячейку XLSX');
   let column=0;for(const c of letters[1])column=column*26+c.charCodeAt(0)-64;
   column--;if(column>=40)continue;
   if(++filled>6000)bad('Слишком много ячеек XLSX');
   const type=cell.getAttribute('t');
   const raw=text(tag(cell,'v'));
   let value=null;
   if(type==='s') {const idx=Number(raw);if(!Number.isInteger(idx)||idx<0||idx>=strings.length)bad('Повреждён справочник строк XLSX');value=strings[idx];}
   else if(type==='inlineStr')value=tags(tag(cell,'is'),'t').map(text).join('');
   else if(type==='str'||type==='d')value=raw;
   else if(type==='e')value=null;
   else if(raw!==''){const n=Number(raw);value=Number.isFinite(n)?n:null;}
   if(value!==null&&value!=='')cells[column]=value;
  }
  rows[index]=cells;
 }
 return rows;
}
export async function readXlsxRows(arrayBuffer){
 const bytes=arrayBuffer instanceof Uint8Array?arrayBuffer:new Uint8Array(arrayBuffer);
 if(bytes.byteLength>MAX_FILE)bad('Файл Excel больше 4 МБ');
 const entries=zipEntries(bytes);
 const workbook=await readXml(entries,'xl/workbook.xml');
 const relations=await readXml(entries,'xl/_rels/workbook.xml.rels');
 if(!workbook||!relations)bad('В XLSX не найдена структура книги');
 const sheets=tags(workbook,'sheet');
 const selected=sheets.find(s=>key(s.getAttribute('name'))==='расходы')||sheets[0];
 if(!selected)bad('В книге нет листов');
 const id=selected.getAttribute('r:id')||selected.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships','id');
 const rel=tags(relations,'Relationship').find(r=>r.getAttribute('Id')===id);
 if(!rel||rel.getAttribute('TargetMode')==='External')bad('Неподдерживаемая ссылка на лист');
 let target=clean(rel.getAttribute('Target')).replace(/^\/+/,'');
 if(!target.startsWith('xl/'))target='xl/'+target.replace(/^(\.\/)+/,'');
 if(!/^xl\/worksheets\/[a-zA-Z0-9_.-]+\.xml$/.test(target))bad('Неподдерживаемое расположение листа');
 const strings=sharedStrings(await readXml(entries,'xl/sharedStrings.xml'));
 const sheet=await readXml(entries,target);
 if(!sheet)bad('Лист XLSX не найден');
 return {sheetName:selected.getAttribute('name')||'Лист',rows:parseCells(sheet,strings)};
}
function sumCents(raw){
 if(raw===null||raw===undefined||raw==='')return null;
 const n=typeof raw==='number'?raw:Number(clean(raw).replace(/\s/g,'').replace(',','.'));
 if(!Number.isFinite(n)||n<=0||n>1e12)return null;
 const amount=Math.round(n*100);
 return Number.isSafeInteger(amount)?amount:null;
}
function dateFromSerial(raw){
 if(typeof raw==='number'&&Number.isInteger(raw)&&raw>=1&&raw<100000){
  const iso=new Date(Date.UTC(1899,11,30)+raw*86400000).toISOString().slice(0,10);
  return iso;
 }
 const s=clean(raw);
 if(/^\d{4}-\d{2}-\d{2}$/.test(s))return s;
 return null;
}
function dueInfo(raw,fallback){
 const value=clean(raw);
 const match=value.match(/\b([1-9]|[12]\d|3[01])\s*(?:[-–]\s*(?:[1-9]|[12]\d|3[01]))?\s*(?:числ[оа]|апрел[ья]|мая|июня|июля|августа|сентября|октября|ноября|декабря|января|февраля|марта)/i);
 if(match)return {day:Number(match[1]),ambiguous:/[-–]/.test(value),source:value};
 return {day:fallback,ambiguous:false,source:value,defaulted:true};
}
function makeDate(asOf,day){
 const month=asOf.slice(0,7);
 const [y,m]=month.split('-').map(Number);
 const last=new Date(Date.UTC(y,m,0)).getUTCDate();
 return month+'-'+String(Math.min(day,last)).padStart(2,'0');
}
function category(title){
 if(/отпуск|резерв|накоплен/i.test(title))return 'Накопления';
 if(/ипотек|кредит|долг|рассрочк/i.test(title))return 'Кредиты';
 if(/жкх|аренд|квартир|страхов/i.test(title))return 'Жильё';
 if(/интернет|связь|телефон|сот\./i.test(title))return 'Связь';
 if(/абонемент|зал|спорт|трениров/i.test(title))return 'Здоровье';
 if(/подпис|сервис|хостинг|сервер/i.test(title))return 'Подписки';
 if(/покупк|продукт|животн|корм/i.test(title))return 'Покупки';
 return 'Другое';
}
function monthsUntil(asOf,target){
 if(!target)return null;
 const [y,m]=asOf.split('-').map(Number),[Y,M]=target.split('-').map(Number);
 const diff=(Y-y)*12+M-m;
 return diff>0&&diff<=1200?diff:null;
}
function sourceLabel(col,row){return col+String(row+1);}
export function parseBudgetRows(rows,asOfDate=new Date().toISOString().slice(0,10)){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate))bad('Некорректная дата импорта');
 if(!Array.isArray(rows)||!rows.length)bad('Пустая таблица');
 const first=key(get(rows[0],0)),incomeHead=key(get(rows[0],8));
 const sectionHeads=rows.map((row,i)=>({i,text:key(get(row,8))})).filter(x=>/^(зарплата|аванс)[\s,]/.test(x.text)||/^(зарплата|аванс)$/.test(x.text));
 if(!first.includes('кредитная нагрузка')||!incomeHead.includes('зарплата')||!sectionHeads.length)bad('Формат таблицы не распознан: нужен поддерживаемый шаблон с кредитами и двумя блоками доходов');
 const warnings=[],entries=[],loans=[];
 const notice=(src,msg)=>{if(warnings.length<60)warnings.push({source:src,message:msg});};
 for(let i=2;i<Math.min(rows.length,40);i++){
  const bank=clean(get(rows[i],0)),type=clean(get(rows[i],1));
  if(/итого/i.test(bank))break;
  if(!bank||!type)continue;
  const opening=sumCents(get(rows[i],6)),payment=sumCents(get(rows[i],3));
  const src=sourceLabel('A',i);
  if(!opening||!payment){
   notice(src,'Обязательство пропущено: нет остатка долга или ежемесячного платежа. Лимит карты не считается задолженностью.');
   continue;
  }
  const apr=Number(get(rows[i],4)??0);
  if(!Number.isFinite(apr)||apr<0||apr>100){notice(src,'Неверная процентная ставка; кредит не импортирован.');continue;}
  const target=dateFromSerial(get(rows[i],5));
  const termMonths=monthsUntil(asOfDate,target)||payoffMonths(opening,payment,apr);
  if(!termMonths||termMonths>1200){notice(src,'Не удалось надёжно рассчитать срок; кредит пропущен.');continue;}
  let dueDay=15;
  const paidName=key(type).includes('ипотек')?'ипотек':key(bank).slice(0,3);
  for(const [rowIndex,row] of rows.entries()){
   const label=key(get(row,8));
   if(label.includes(paidName)&&sumCents(get(row,9))===payment){
    const section=[...sectionHeads].reverse().find(x=>x.i<rowIndex);
    const fallback=section?.text.startsWith('аванс')?30:15;
    dueDay=dueInfo(get(row,10),fallback).day;
    break;
   }
  }
  loans.push({title:(bank+' - '+type).slice(0,100),openingCents:opening,paymentCents:payment,apr,termMonths,asOfDate,dueDay,schedule:[],source:src});
  notice(src,'Дата актуальности остатка долга принята равной дате импорта. Проверьте условия кредита и день платежа.');
 }
 for(let h=0;h<sectionHeads.length;h++){
  const {i,text:heading}=sectionHeads[h];
  const income=sumCents(get(rows[i+1],9));
  const day=/зарплата/.test(heading)?15:30;
  if(income){
   entries.push({title:/зарплата/.test(heading)?'Зарплата':'Аванс',kind:'income',amountCents:income,date:makeDate(asOfDate,day),recurrence:'monthly',category:'Работа',source:sourceLabel('I',i+1)});
  }else notice(sourceLabel('J',i+1),'Не найден размер поступления.');
  const end=h+1<sectionHeads.length?sectionHeads[h+1].i:Math.min(rows.length,200);
  for(let row=i+2;row<end;row++){
   const title=clean(get(rows[row],8));
   if(/^(остаток|итого)/i.test(title))break;
   if(!title||title==='+')continue;
   const amount=sumCents(get(rows[row],9));
   if(!amount){
    if(get(rows[row],11))notice(sourceLabel('I',row),'Строка пропущена: сумма отсутствует, данные в комментарии не засчитываются.');
    continue;
   }
   const loan=loans.find(l=>l.paymentCents===amount&&(
    (/ипотек/i.test(title)&&/ипотек/i.test(l.title))||
    (key(l.title.split(' - ')[0]).slice(0,3).length>=3&&key(title).includes(key(l.title.split(' - ')[0]).slice(0,3)))||
    key(l.title).includes(key(title))
   ));
   if(loan){notice(sourceLabel('I',row),'Обязательный кредитный платёж учтён в карточке кредита; повторный расход не создан.');continue;}
   const info=dueInfo(get(rows[row],10),day),comment=key(get(rows[row],11));
   let recurrence='monthly';
   if(/раз\s*в|[23456]\s*мес|каждые\s*[23456]/.test(comment)){recurrence='once';notice(sourceLabel('I',row),'Периодичность из комментария не перенесена автоматически; проверьте разовую запись.');}
   if(info.ambiguous)notice(sourceLabel('K',row),'Указан диапазон дней: выбран первый. При необходимости исправьте.');
   if(info.defaulted)notice(sourceLabel('K',row),'Нет точного дня: использована дата соответствующего поступления.');
   if(/досрочн|ипотек/i.test(title)&&!loan)notice(sourceLabel('I',row),'Дополнительный платёж пока является только планом расходов и не уменьшает долг до подтверждения в карточке кредита.');
   if(/отпуск|накоплен/i.test(title))notice(sourceLabel('I',row),'Накопления учитываются в бюджете как плановая сумма, не как перевод между счетами.');
   entries.push({title:title.slice(0,100),kind:'expense',amountCents:amount,date:makeDate(asOfDate,info.day),recurrence,category:category(title),source:sourceLabel('I',row)});
  }
 }
 if(!entries.length&&!loans.length)bad('Подходящих записей для импорта не найдено');
 return {format:'two-paydays',asOfDate,entries,loans,warnings};
}
function entryKey(item){
 return [key(item.title),item.kind,item.amountCents,item.date,item.recurrence].join('|');
}
export function previewImportChanges(parsed,state){
 const inEntries=new Set((state.entries||[]).filter(x=>!x.deletedAt).map(entryKey));
 const inLoans=(state.loans||[]).filter(x=>!x.deletedAt);
 const entries=[],loans=[];let duplicates=0;
 for(const entry of parsed.entries){
  const k=entryKey(entry);
  if(inEntries.has(k)){duplicates++;continue;}
  inEntries.add(k);entries.push(entry);
 }
 for(const loan of parsed.loans){
  if(inLoans.some(x=>key(x.title)===key(loan.title)||(
    x.openingCents===loan.openingCents&&Math.abs(x.apr-loan.apr)<.0001&&x.paymentCents===loan.paymentCents
  ))){duplicates++;continue;}
  loans.push(loan);
 }
 const categories=[...new Set(entries.map(x=>x.category).filter(x=>!(state.categories||[]).includes(x)))];
 const incomeCents=entries.filter(x=>x.kind==='income').reduce((sum,x)=>sum+x.amountCents,0);
 const expenseCents=entries.filter(x=>x.kind==='expense').reduce((sum,x)=>sum+x.amountCents,0);
 return {entries,loans,categories,duplicates,incomeCents,expenseCents,warnings:parsed.warnings};
}
