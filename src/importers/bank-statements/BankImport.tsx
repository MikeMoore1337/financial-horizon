import {useEffect,useMemo,useRef,useState,type ChangeEvent} from 'react';
import {Icon} from '../../react/Calendar';
import {formatRubMinor,parseRubMinor} from '../../react/accounts-view-model';
import {readBankStatementFile,suggestColumnMapping,normalizeBankStatement,
  reconcileBankStatement,draftBankImportBatch} from './index.ts';
import {loadSignedBankSnapshot,loadOlderSignedBankHistory,type SignedBankSnapshot} from './server.ts';
import {buildBankCommitRequest,buildBankUndoRequest,
  commitConfirmedBankBatch,undoConfirmedBankBatch} from './save.ts';
import {emptyGuestBankLedger,guestBankMovements,guestBankBalance} from './guest-ledger.js';
import type {BankStatementTable,BankImportPreview,ColumnMapping,MappableField,
  ReconciliationResult,ImportBatchPlan} from './types.ts';
import type {GuestBankLedger} from '../../types/finance.ts';
import './bank-import.css';

export interface BankImportProps {
  mode:'guest'|'account';
  verifiedActorUserId:string|null;
  guestLedger:GuestBankLedger|null;
  guestRevision:number;
  onBack:()=>void;
  onOpenAccounts:()=>void;
  onGuestAddAccount:(name:string,openingMinor:number,revision:number)=>Promise<void>;
  onGuestCommit:(plan:ImportBatchPlan,digest:string,revision:number)=>Promise<void>;
  onGuestUndo:(key:string,revision:number)=>Promise<void>;
}
const fields:{key:MappableField;label:string}[]=[
  {key:'date',label:'Дата'},{key:'amount',label:'Сумма'},
  {key:'income',label:'Приход'},{key:'expense',label:'Расход'},
  {key:'description',label:'Описание'},{key:'account',label:'Счёт'},
  {key:'targetAccount',label:'Счёт назначения'},{key:'kind',label:'Тип'},
  {key:'currency',label:'Валюта'},{key:'category',label:'Категория'},
  {key:'externalId',label:'Банковский ID'},
];
const money=(minor:number)=>formatRubMinor(minor);
function formatAmount(value:number,kind:string){
  return (kind==='income'?'+':kind==='expense'||kind==='transfer'?'−':'')+money(value);
}
export function BankImport({mode,verifiedActorUserId,guestLedger,guestRevision,
  onBack,onOpenAccounts,onGuestAddAccount,onGuestCommit,onGuestUndo}:BankImportProps){
  const bytes=useRef<Uint8Array|null>(null);
  const locked=useRef(false);
  const [filename,setFilename]=useState('');
  const [table,setTable]=useState<BankStatementTable|null>(null);
  const [mapping,setMapping]=useState<ColumnMapping>({});
  const [defaultAccount,setDefaultAccount]=useState('');
  const [codec,setCodec]=useState('auto');
  const [separator,setSeparator]=useState('auto');
  const [sheet,setSheet]=useState('');
  const [header,setHeader]=useState('');
  const [order,setOrder]=useState<'DMY'|'MDY'>('DMY');
  const [numberFormat,setNumberFormat]=useState<'auto'|'dot-decimal'|'comma-decimal'>('auto');
  const [transferDirection,setTransferDirection]=useState<'signed-source'|'from-to'>('signed-source');
  const [preview,setPreview]=useState<BankImportPreview|null>(null);
  const [decisions,setDecisions]=useState<Record<string,'include'|'skip'|'reviewed'>>({});
  const [server,setServer]=useState<SignedBankSnapshot|null>(null);
  const [serverBusy,setServerBusy]=useState(false);
  const [historyBusy,setHistoryBusy]=useState(false);
  const [refresh,setRefresh]=useState(0);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [accountName,setAccountName]=useState('');
  const [opening,setOpening]=useState('0');

  const guest=useMemo(()=>guestLedger||emptyGuestBankLedger(),[guestLedger]);
  useEffect(()=>{
    if(mode==='guest'){setServer(null);setServerBusy(false);return;}
    const controller=new AbortController();
    if(!verifiedActorUserId){setError('Не подтверждена авторизация');return;}
    setServerBusy(true);
    void loadSignedBankSnapshot(verifiedActorUserId,fetch,controller.signal).then(view=>{
      if(!controller.signal.aborted){setServer(view);setError('');setServerBusy(false);}
    }).catch(()=>{
      if(!controller.signal.aborted){setServer(null);setServerBusy(false);
        setError('Серверный импорт недоступен или финансовый снимок устарел. Повторите загрузку.');
      }
    });
    return ()=>controller.abort();
  },[mode,verifiedActorUserId,refresh]);

  const accounts=useMemo(()=>mode==='guest'
    ?guest.accounts.map(a=>({id:a.id,name:a.name,currency:'RUB' as const}))
    :(server?.accounts||[]).map(a=>({id:a.id,name:a.name,currency:'RUB' as const})),
    [mode,guest,server]);
  const existing=useMemo(()=>mode==='guest'
    ?guestBankMovements(guest):server?.movements||[],[mode,guest,server]);

  useEffect(()=>{
    if(!table){setPreview(null);return;}
    let active=true;setPreview(null);
    void normalizeBankStatement(table,{mapping,accounts,
      defaultAccountId:defaultAccount||undefined,dateOrder:order,
      numberFormat,transferDirection}).then(data=>{
      if(active)setPreview(data);
    }).catch(()=>{if(active)setError('Не удалось распознать строки');});
    return ()=>{active=false;};
  },[table,mapping,accounts,defaultAccount,order,numberFormat,transferDirection]);
  const compared:ReconciliationResult|null=useMemo(()=>
    preview?reconcileBankStatement(preview,existing):null,[preview,existing]);
  useEffect(()=>setDecisions({}),[compared]);
  const allRows=compared?.rows||[];
  const selected=allRows.filter(row=>row.operation&&(
    row.status==='ready'&&decisions[row.operation.sourceKey]!=='skip'||
    row.status==='possible-duplicate'&&decisions[row.operation.sourceKey]==='reviewed'
  ));
  const keys=selected.map(row=>row.operation!.sourceKey);
  const allowed=selected.filter(row=>row.status==='possible-duplicate').map(row=>row.operation!.sourceKey);
  const summary=selected.reduce((acc,row)=>{
    const op=row.operation!;
    if(op.kind==='income')acc.income+=op.amountCents;
    else if(op.kind==='expense')acc.expense+=op.amountCents;
    else acc.transfer+=op.amountCents;
    return acc;
  },{income:0,expense:0,transfer:0});
  const canSave=!!table&&!!compared&&selected.length>0&&selected.length<=1000&&
    !busy&&!serverBusy&&(mode==='guest'||!!server);

  async function parse(options:{sheet?:string;header?:number;codec?:string;separator?:string;name?:string}={}){
    if(!bytes.current)return;
    setBusy(true);setError('');
    try{
      const next=await readBankStatementFile(bytes.current,{
        filename:options.name||filename,
        sheetName:options.sheet||undefined,headerRowNumber:options.header,
        csvEncoding:(options.codec&&options.codec!=='auto'?options.codec:'auto') as
          'auto'|'utf-8'|'windows-1251'|'windows-1252'|'ibm866'|'utf-16le'|'utf-16be',
        csvDelimiter:(options.separator&&options.separator!=='auto'?options.separator:undefined) as
          ','|';'|'\t'|'|'|undefined,
      });
      setTable(next);setSheet(next.sheetName||'');
      setMapping(suggestColumnMapping(next.headers).mapping);
    }catch{setTable(null);setError('Файл повреждён, превышает лимит или выбран неверный формат.');}
    finally{setBusy(false);}
  }
  async function chooseFile(event:ChangeEvent<HTMLInputElement>){
    const file=event.target.files?.[0];event.target.value='';
    if(!file)return;
    if(!/\.(csv|xlsx)$/i.test(file.name)||file.size===0||
      file.size>(/\.csv$/i.test(file.name)?4_000_000:6_000_000)){
      setError('Выберите CSV до 4 МБ или XLSX до 6 МБ');return;
    }
    bytes.current=new Uint8Array(await file.arrayBuffer());
    setFilename(file.name.slice(0,160));setCodec('auto');setSeparator('auto');
    setHeader('');setDecisions({});setNotice('');
    await parse({name:file.name});
  }
  async function save(){
    if(!canSave||!table||!compared||locked.current)return;
    locked.current=true;setBusy(true);setError('');setNotice('');
    try{
      const plan=await draftBankImportBatch(compared,keys,allowed);
      if(mode==='guest')await onGuestCommit(plan,table.fileDigest,guestRevision);
      else{
        if(!server)throw Error('Нет серверного подтверждения');
        const request=buildBankCommitRequest(plan,compared,table.fileDigest,{
          revision:server.revision,etag:server.etag,clientMutationId:crypto.randomUUID(),
          accountEntityRevisions:Object.fromEntries(server.accounts.map(a=>[a.id,a.entityRevision])),
        });
        await commitConfirmedBankBatch(request,server.etag);
        setRefresh(v=>v+1);
      }
      setNotice('Импорт подтверждён: '+plan.operations.length+' операций');
      bytes.current=null;setTable(null);setPreview(null);
    }catch{
      setError('Сохранение не подтверждено. Прежде чем повторять, обновите сверку и историю.');
      if(mode==='account')setRefresh(v=>v+1);
    }finally{locked.current=false;setBusy(false);}
  }
  async function undo(batchKey:string){
    if(locked.current||busy||!window.confirm(
      'Отменить всю партию? Операции останутся в истории с отметкой об отмене.'))return;
    locked.current=true;setBusy(true);setError('');setNotice('');
    try{
      if(mode==='guest')await onGuestUndo(batchKey,guestRevision);
      else{
        if(!server)throw Error('Нет подтверждённого сервера');
        const request=buildBankUndoRequest(batchKey,'Отмена по подтверждению владельца',{
          revision:server.revision,etag:server.etag,clientMutationId:crypto.randomUUID(),
          accountEntityRevisions:{},
        });
        await undoConfirmedBankBatch(request,server.etag);
        setRefresh(x=>x+1);
      }
      setNotice('Отмена партии подтверждена');
    }catch{
      setError('Отмена отклонена. Проверьте последующие изменения и ревизию профиля.');
      if(mode==='account')setRefresh(x=>x+1);
    }finally{locked.current=false;setBusy(false);}
  }
  async function loadOlderHistory(){
    if(mode!=='account'||!server||server.historyNextCursor===null||
      historyBusy||busy)return;
    setHistoryBusy(true);setError('');
    try{
      const current=server;
      const page=await loadOlderSignedBankHistory(current);
      setServer(previous=>{
        if(!previous||previous.revision!==current.revision||
          previous.etag!==current.etag||
          previous.historyNextCursor!==current.historyNextCursor)return previous;
        if(page.batches.some(batch=>
          previous.batches.some(existing=>existing.batch_id===batch.batch_id))){
          setError('Повторная страница истории; обновите финансовую сверку.');
          return previous;
        }
        return {...previous,batches:[...previous.batches,...page.batches],
          historyNextCursor:page.historyNextCursor};
      });
    }catch{
      setError('Не удалось проверить предыдущую страницу истории. Обновите сверку.');
    }finally{setHistoryBusy(false);}
  }
  async function addAccount(){
    if(busy||!accountName.trim())return;
    setBusy(true);setError('');
    try{
      await onGuestAddAccount(accountName,parseRubMinor(opening,true),guestRevision);
      setAccountName('');setOpening('0');setNotice('Счёт создан');
    }catch{setError('Не удалось создать счёт. Проверьте данные и актуальность профиля.');}
    finally{setBusy(false);}
  }
  const history=mode==='guest'?guest.batches.map(b=>({
    key:b.batchKey,id:b.batchKey,label:'Ревизия '+b.committedStateRevision,
    count:b.operationCount,status:b.cancelledStateRevision===null?'committed':'cancelled',
    canUndo:b.cancelledStateRevision===null&&guestRevision===b.committedStateRevision,
  })).reverse():(server?.batches||[]).map(b=>({
    key:b.batch_key,id:b.batch_id,label:new Date(b.committed_at).toLocaleDateString('ru-RU'),
    count:b.operation_count,status:b.status,
    canUndo:b.status==='committed'&&b.committed_revision===server?.revision,
  }));
  return <section className="fh-bank-screen">
    <header className="page-header fh-bank-header"><div>
      <div className="eyebrow">БАНКОВСКИЕ ОПЕРАЦИИ</div><h1>Импорт выписки</h1>
      <p className="subtitle">Загрузите CSV или XLSX. Проверьте совпадения до сохранения.</p>
    </div><div className="header-tools">
      <button type="button" className="button-secondary" onClick={()=>
        document.getElementById('fh-bank-history')?.scrollIntoView({behavior:'smooth'})}>
        <Icon name="archive"/> История партий
      </button>
      <button type="button" className="button-secondary" onClick={onBack}>К счетам</button>
    </div></header>
    <nav className="surface fh-bank-steps" aria-label="Этапы импорта">
      {['Файл','Колонки','Сверка','Результат'].map((label,index)=>
        <span key={label} className={index===2&&table?'current':''}>
          <b>{index+1}</b>{label}</span>)}
    </nav>
    {error&&<p className="fh-bank-error" role="alert">{error}</p>}
    {notice&&<p className="fh-bank-notice" role="status">{notice}</p>}
    <div className="fh-bank-columns"><div className="fh-bank-main">
      <section className="surface fh-bank-panel">
        <h2>Выбранная выписка</h2>
        <p className="small-hint">Исходный файл остаётся на устройстве и не отправляется на сервер.</p>
        <div className="fh-bank-file"><Icon name="sheet"/><span>
          <strong>{filename||'Файл не выбран'}</strong>
          <small>{table?table.rows.length+' строк · '+table.format.toUpperCase():
            'CSV или XLSX, до 6 МБ'}</small>
        </span><label className="button-secondary">Выбрать файл
          <input type="file" accept=".csv,.xlsx" aria-label="Банковская выписка"
            onChange={e=>void chooseFile(e)} disabled={busy}/>
        </label></div>
        {table&&<div className="fh-bank-format">
          {table.format==='xlsx'&&(table.availableSheets?.length||0)>1&&
            <label className="field">Лист XLSX<select value={sheet}
              onChange={e=>setSheet(e.target.value)}>
              {table.availableSheets!.map(name=><option key={name}>{name}</option>)}
            </select></label>}
          {table.format==='csv'&&<>
            <label className="field">Кодировка<select value={codec} onChange={e=>setCodec(e.target.value)}>
              {['auto','utf-8','windows-1251','windows-1252','ibm866','utf-16le','utf-16be']
                .map(name=><option key={name}>{name}</option>)}</select></label>
            <label className="field">Разделитель<select value={separator}
              onChange={e=>setSeparator(e.target.value)}>
              {[['auto','Автоматически'],[';', ';'],[',',','],['\t','Табуляция'],['|','|']]
                .map(([value,label])=><option key={value} value={value}>{label}</option>)}
            </select></label>
          </>}
          <label className="field">Строка заголовка (1-100)
            <input type="number" min="1" max="100" value={header}
              placeholder={String(table.headerRowNumber)}
              onChange={e=>setHeader(e.target.value)}/></label>
          <button type="button" className="button-secondary" disabled={busy}
            onClick={()=>void parse({sheet,header:header?Number(header):undefined,codec,separator})}>
            Применить формат</button>
        </div>}
      </section>
      {mode==='guest'&&<section className="surface fh-bank-panel">
        <h2>Локальные банковские счета</h2>
        <p className="small-hint">Начальный остаток задаётся явно, отдельно от плановых платежей.</p>
        {!!guest.accounts.length&&<div className="fh-bank-account-list" aria-label="Остатки банковских счетов">
          {guest.accounts.map(a=><div key={a.id} className="fh-bank-account">
            <strong>{a.name}</strong>
            <span>{money(guestBankBalance(guest,a.id))}</span>
          </div>)}
        </div>}
        <div className="fh-bank-fields">
          <label className="field">Название<input maxLength={160} value={accountName}
            onChange={e=>setAccountName(e.target.value)}/></label>
          <label className="field">Начальный остаток, ₽<input value={opening} inputMode="decimal"
            onChange={e=>setOpening(e.target.value)}/></label>
          <button type="button" className="button-primary" disabled={busy||!accountName.trim()}
            onClick={()=>void addAccount()}>Добавить счёт</button>
        </div>
      </section>}
      {mode==='account'&&serverBusy&&<p role="status">Получаем финансовый снимок…</p>}
      {mode==='account'&&server&&!accounts.length&&<section className="surface fh-bank-panel">
        <p>Нет доступных счетов.</p><button type="button" className="button-primary"
          onClick={onOpenAccounts}>Создать счёт</button></section>}
      {table&&!!accounts.length&&<section className="surface fh-bank-panel">
        <h2>Сопоставление колонок</h2>
        <p className="small-hint">Автоматические предложения можно изменить вручную.</p>
        <div className="fh-bank-fields">
          <label className="field">Счёт по умолчанию
            <select value={defaultAccount} onChange={e=>setDefaultAccount(e.target.value)}>
              <option value="">Не выбран</option>
              {accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
            </select></label>
          {fields.map(field=><label className="field" key={field.key}>{field.label}
            <select value={mapping[field.key]??''} onChange={e=>setMapping(old=>{
              const next={...old};
              if(!e.target.value)delete next[field.key];
              else next[field.key]=Number(e.target.value);
              return next;
            })}>
              <option value="">Не используется</option>
              {table.headers.map((name,index)=><option key={index} value={index}>
                {name||'Колонка '+(index+1)}</option>)}
            </select></label>)}
          <label className="field">Формат даты<select value={order}
            onChange={e=>setOrder(e.target.value as 'DMY'|'MDY')}>
            <option value="DMY">День / месяц / год</option>
            <option value="MDY">Месяц / день / год</option>
          </select></label>
          <label className="field">Числовой формат<select value={numberFormat}
            onChange={e=>setNumberFormat(e.target.value as typeof numberFormat)}>
            <option value="auto">Автоматически</option>
            <option value="comma-decimal">Запятая</option>
            <option value="dot-decimal">Точка</option>
          </select></label>
          <label className="field">Положительный перевод<select value={transferDirection}
            onChange={e=>setTransferDirection(e.target.value as typeof transferDirection)}>
            <option value="signed-source">Получен на этот счёт</option>
            <option value="from-to">Отправлен с этого счёта</option>
          </select></label>
        </div>
      </section>}
      {table&&compared&&!!accounts.length&&<section className="surface fh-bank-panel">
        <h2>Предварительный просмотр</h2>
        <p className="small-hint">Спорные совпадения нельзя импортировать без явного решения.</p>
        <div className="fh-bank-stats">
          {[[allRows.length,'Всего строк'],[compared.ready,'Новые'],
            [compared.possibleDuplicates+compared.duplicates,'Совпадения'],
            [compared.invalid,'Ошибки']].map(([count,label])=>
            <div key={label}><small>{label}</small><strong>{count}</strong></div>)}
        </div>
        <div className="fh-bank-tablewrap"><table className="fh-bank-table">
          <thead><tr><th>Дата</th><th>Описание</th><th>Счёт</th>
            <th>Сумма</th><th>Решение</th></tr></thead>
          <tbody>{allRows.map((row,index)=>{
            const op=row.operation;
            const choice=op?decisions[op.sourceKey]||
              (row.status==='ready'?'include':'skip'):'skip';
            return <tr key={op?.sourceKey||'invalid-'+index}>
              <td>{op?.date||'Строка '+row.rowNumber}</td>
              <td><b>{op?.description||'Некорректная строка'}</b>
                {row.warnings.length>0&&<small>{row.warnings[0]?.message}</small>}</td>
              <td>{accounts.find(a=>a.id===op?.accountId)?.name||'—'}</td>
              <td className="fh-bank-money">{op?formatAmount(op.amountCents,op.kind):'—'}</td>
              <td>{op&&['ready','possible-duplicate'].includes(row.status)?
                <select aria-label={'Решение строки '+row.rowNumber} value={choice}
                  onChange={e=>setDecisions(old=>({
                    ...old,[op.sourceKey]:e.target.value as 'include'|'skip'|'reviewed',
                  }))}>
                  <option value="skip">Исключить</option>
                  {row.status==='ready'&&<option value="include">Новая</option>}
                  {row.status==='possible-duplicate'&&
                    <option value="reviewed">Подтверждаю отдельный импорт</option>}
                </select>:<small>{row.status==='invalid'?'Ошибка':'Уже учтена'}</small>}</td>
            </tr>;
          })}</tbody></table></div>
      </section>}
    </div><aside className="fh-bank-aside">
      <section className="surface fh-bank-panel">
        <h2>Требует решения</h2>
        <p className="small-hint">Платежи по обязательствам и кредиты не должны списываться дважды.</p>
        <strong>{compared?.possibleDuplicates||0} спорных совпадений</strong>
        <p className="small-hint">Сервер повторно проверит выбранные операции перед записью.</p>
      </section>
      <section className="surface fh-bank-panel">
        <h2>Итог партии</h2>
        <p className="small-hint">Только выбранные операции.</p>
        <dl className="fh-bank-summary">
          <div><dt>Новых операций</dt><dd>{keys.length}</dd></div>
          <div><dt>Исключено</dt><dd>{allRows.length-keys.length}</dd></div>
          <div><dt>Поступления</dt><dd>{money(summary.income)}</dd></div>
          <div><dt>Расходы</dt><dd>{money(-summary.expense)}</dd></div>
          <div><dt>Переводы</dt><dd>{money(summary.transfer)}</dd></div>
          <div className="total"><dt>Изменение остатка</dt><dd>
            {money(summary.income-summary.expense)}</dd></div>
        </dl>
        <button type="button" className="button-primary fh-bank-submit"
          disabled={!canSave} onClick={()=>void save()}>Подтвердить импорт {keys.length} операций</button>
        {keys.length>1000&&<p role="alert" className="fh-bank-error">
          Одна атомарная партия не может превышать 1000 операций.</p>}
      </section>
      <section className="surface fh-bank-panel" id="fh-bank-history">
        <h2>История импорта</h2>
        {mode==='account'&&<button type="button" className="button-text"
          onClick={()=>setRefresh(x=>x+1)} disabled={busy}>Обновить</button>}
        {history.length===0&&<p className="small-hint">Партии пока отсутствуют.</p>}
        {history.map(batch=><div className="fh-bank-history" key={batch.id}>
          <div><b>{batch.label}</b><small>{batch.count} операций · {
            batch.status==='cancelled'?'Отменено':'Сохранено'}</small></div>
          {batch.canUndo&&<button type="button" className="button-secondary"
            onClick={()=>void undo(batch.key)} disabled={busy}>Отменить</button>}
        </div>)}
        {mode==='account'&&server?.historyNextCursor!==null&&server&&
          <button type="button" className="button-secondary"
            disabled={busy||historyBusy||serverBusy}
            onClick={()=>void loadOlderHistory()}>
            {historyBusy?'Проверка истории…':'Загрузить более ранние партии'}
          </button>}
      </section>
    </aside></div>
  </section>;
}
