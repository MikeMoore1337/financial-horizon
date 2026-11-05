import {cents} from './finance.js';
// Импорт выписки только после пользовательского выбора файла. Никаких серверных запросов.
export function parseCsv(input){
 const text=input.replace(/^\ufeff/,'');const first=text.split(/\r?\n/).find(x=>x.trim())||'';
 const delimiter=(first.match(/;/g)||[]).length>=(first.match(/,/g)||[]).length?';':',';
 let rows=[],row=[],part='',quote=false;
 for(let i=0;i<text.length;i++){const c=text[i];
  if(c==='"'){if(quote&&text[i+1]==='"'){part+='"';i++;}else quote=!quote;}
  else if(c===delimiter&&!quote){row.push(part.trim());part='';}
  else if((c==='\n'||c==='\r')&&!quote){if(c==='\r'&&text[i+1]==='\n')i++;row.push(part.trim());if(row.some(Boolean))rows.push(row);row=[];part='';}
  else part+=c;
 }
 if(quote)throw Error('Незакрытые кавычки в CSV');row.push(part.trim());if(row.some(Boolean))rows.push(row);
 return rows;
}
function normalize(x){return String(x).toLowerCase().replace(/[\s._-]/g,'').replace(/ё/g,'е');}
function dateFrom(x){const raw=String(x).trim();let m=raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
 if(!m){m=raw.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);if(m)m=[raw,m[3],m[2],m[1]];}
 if(!m)throw Error('Некорректная дата в графике: '+raw.slice(0,25));
 const [y,mo,d]=m.slice(1).map(Number);const parsed=new Date(Date.UTC(y,mo-1,d));
 if(parsed.getUTCFullYear()!==y||parsed.getUTCMonth()+1!==mo||parsed.getUTCDate()!==d)throw Error('Несуществующая дата в графике: '+raw.slice(0,25));
 return `${String(y).padStart(4,'0')}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;}
export function parseSchedule(text){
 const rows=parseCsv(text);if(rows.length<2||rows.length>1500)throw Error('Ожидается CSV с заголовком и 1-1499 строками');
 const fields={date:['дата','датаплатежа','date'],amount:['платеж','суммаплатежа','amount','payment'],interest:['проценты','interest'],principal:['основнойдолг','телокредита','principal'],balance:['остаток','остатокдолга','balance']};
 const header=rows[0].map(normalize);const index={};
 for(const [key,names] of Object.entries(fields))index[key]=header.findIndex(h=>names.includes(h));
 if(index.date<0||index.amount<0||index.balance<0)throw Error('Не найдены колонки «Дата», «Платёж» и «Остаток»');
 let last='';const items=rows.slice(1).map((r,i)=>{
 const date=dateFrom(r[index.date]);if(last && date<=last)throw Error(`Даты графика не возрастают, строка ${i+2}`);last=date;
 const amountCents=cents(r[index.amount]);const balanceCents=cents(r[index.balance]);
 return {date,amountCents,balanceCents,interestCents:index.interest>=0 && r[index.interest] ? cents(r[index.interest]):null,principalCents:index.principal>=0 && r[index.principal] ? cents(r[index.principal]):null};
 });
 return items;
}
