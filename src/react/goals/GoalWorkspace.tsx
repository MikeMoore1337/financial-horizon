import {useState, type FormEvent} from 'react';
import {GoalsPreview} from './GoalsPreview';
import {buildGoalsScreenModel} from '../../domain/goals/presentation.ts';
import {parseGoalRubles} from '../../domain/goals/ui-money.ts';
import {formatRubMinor} from '../accounts-view-model';
import {verifyGoalDependencies} from '../../domain/goals/goal-command-candidate.mjs';
import type {ServerGoal} from '../../domain/goals/server-goals.ts';
import type {GoalCategory,GoalEvent} from '../../domain/goals/types.ts';

type Entity = {id:string;kind:string;entity_revision:number;data:unknown};
type AccountChoice = {id:string;name:string;available:number;archived:boolean};
type Command = {schema_version:number;client_mutation_id:string;base_revision:number;action:string;
  expected_entity_revisions:Record<string,number>;payload:Record<string,unknown>};
export interface GoalWorkspaceProps {
  goals: ServerGoal[];
  accounts: AccountChoice[];
  entities: Entity[];
  revision: number;
  writable: boolean;
  pending: boolean;
  guest?: boolean;
  onCommand: (command:Command)=>Promise<unknown>;
}
const labels: Record<GoalCategory,string> = {
  emergency:'Подушка безопасности',travel:'Путешествие',purchase:'Покупка',education:'Образование',other:'Другая цель',
};
type Mode = 'create'|'update'|'contribution'|'use'|'skip'|'void'|'complete'|'reopen'|'archive'|'restore';
const actionLabel: Record<Mode,string> = {
  create:'Создать цель',update:'Изменить параметры',contribution:'Пополнить',use:'Использовать средства',
  skip:'Отметить пропуск взноса',void:'Отменить событие',complete:'Завершить',reopen:'Возобновить',archive:'Архивировать',restore:'Восстановить',
};
const today=()=>new Date().toISOString().slice(0,10);
const displayDate=(value:string)=>new Date(value+'T00:00:00Z').toLocaleDateString('ru-RU',{timeZone:'UTC'});
const amountText=(minor:number)=>String(Math.floor(minor/100))+','+String(minor%100).padStart(2,'0');

export function GoalWorkspace({goals,accounts,entities,revision,writable,pending,guest=false,onCommand}:GoalWorkspaceProps) {
  const [selection,setSelection]=useState<string|null>(null);
  const [mode,setMode]=useState<Mode|null>(null);
  const [date,setDate]=useState(today);
  const [title,setTitle]=useState('');
  const [category,setCategory]=useState<GoalCategory>('other');
  const [account,setAccount]=useState('');
  const [target,setTarget]=useState('');
  const [deadline,setDeadline]=useState(today);
  const [monthly,setMonthly]=useState('');
  const [opening,setOpening]=useState('0');
  const [amount,setAmount]=useState('');
  const [funding,setFunding]=useState('virtual');
  const [counterparty,setCounterparty]=useState('');
  const [due,setDue]=useState('');
  const [reason,setReason]=useState('');
  const [eventId,setEventId]=useState('');
  const [confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const asOf=today();
  const model=buildGoalsScreenModel(goals.map(g=>g.record),asOf,selection);
  const selected=goals.find(g=>g.id===model.selected?.card.id);
  const detail=model.selected;
  const canWrite=writable&&!pending&&!busy;
  const active=detail?.card.status==='active';
  const open=(next:Mode)=>{
    setMode(next);setError('');setConfirmed(false);setDate(asOf);setAmount('');setFunding(next==='use'?'virtual-release':'virtual');setCounterparty('');setDue('');setReason('');setEventId('');
    setAccount(next==='create'?'':selected?.accountId??'');
    setTitle(next==='create'?'':detail?.card.title??'');
    setCategory(next==='create'?'other':detail?.card.category??'other');
    setTarget(next==='create'?'':amountText(detail?.card.targetCents??0));
    setDeadline(next==='create'?asOf:detail?.card.targetDate??asOf);
    setMonthly(next==='create'||!detail?.snapshot.monthlyPlanIsFixed?'':amountText(detail.snapshot.monthlyCents));
    setOpening('0');
  };
  const reversible=selected?.record.events.filter(e=>['contribution','use','skip'].includes(e.type)&&
    !selected.record.events.some(v=>v.type==='void'&&v.eventId===e.id))??[];
  const submit=async (ev:FormEvent<HTMLFormElement>)=>{
    ev.preventDefault();
    if(!mode||!canWrite||!confirmed)return;
    setBusy(true);setError('');
    try{
      const id=crypto.randomUUID(),goalId=mode==='create'?crypto.randomUUID():selected?.id;
      const accountId=mode==='create'?account:selected?.accountId;
      if(!goalId||!accountId)throw Error('Выберите цель и счёт');
      let event:Record<string,unknown>={id,type:mode,on:date};
      if(mode==='create'||mode==='update'){
        const changes={title:title.trim(),category,targetCents:parseGoalRubles(target),targetDate:deadline,
          monthlyCents:monthly.trim()?parseGoalRubles(monthly,false):null,plannedFunding:'virtual'};
        event=mode==='create'?{...event,...changes,openingCents:parseGoalRubles(opening,false)}:{...event,changes};
      }else if(mode==='contribution')event={...event,amountCents:parseGoalRubles(amount),funding,...(due?{forDueOn:due}:{})};
      else if(mode==='use')event={...event,amountCents:parseGoalRubles(amount),usage:funding};
      else if(mode==='skip')event={...event,dueOn:due,...(reason.trim()?{reason:reason.trim()}:{})};
      else if(mode==='void')event={...event,eventId,reason:reason.trim()};
      const ids=new Set([accountId,...(mode==='create'?[]:[goalId])]);
      const transfer=(mode==='contribution'||mode==='use')&&funding==='account-transfer';
      if(transfer){if(!counterparty)throw Error('Выберите второй собственный счёт');ids.add(counterparty);}
      if(mode==='void'){
        const original=selected?.record.events.find(e=>e.id===eventId) as GoalEvent|undefined;
        if(original&&(original.type==='contribution'||original.type==='use')&&original.ledgerMovementId){
          const tx=entities.find(x=>x.kind==='transaction'&&x.id===original.ledgerMovementId);
          if(!tx)throw Error('Нет подтверждённой проводки');
          for(const p of (tx.data as {postings:{account_id:string}[]}).postings)ids.add(p.account_id);
        }
      }
      const versions:Record<string,number>={};
      for(const key of ids){
        const entity=entities.find(x=>x.id===key);
        if(!entity)throw Error('Связанная запись изменилась');
        versions[key]=entity.entity_revision;
      }
      const command:Command={schema_version:2,client_mutation_id:id,base_revision:revision,action:'goal.append',
        expected_entity_revisions:versions,payload:{goal_id:goalId,account_id:accountId,event,
          ...(transfer?{counterparty_account_id:counterparty}:{})}};
      if(!guest)verifyGoalDependencies(command,entities);
      await onCommand(command);
      setSelection(goalId);setMode(null);
    }catch(e){setError(e instanceof Error?e.message:'Не удалось сохранить операцию');}
    finally{setBusy(false);}
  };
  const button=(action:Mode,disabled=false)=><button type="button" className="button-secondary" disabled={!canWrite||disabled} onClick={()=>open(action)}>{actionLabel[action]}</button>;
  return <div className="goal-workspace">
    <GoalsPreview model={model} rubles={formatRubMinor} formatDate={displayDate}
      onSelect={id=>{setSelection(id);setMode(null);}} connected guest={guest}/>
    {pending&&<p role="status">Операция ожидает подтверждения. Остаток и история показаны по последнему подтверждённому состоянию.</p>}
    {!writable&&<p role="status">Изменения недоступны. Проверьте доступ или завершите конфликт синхронизации.</p>}
    {!accounts.some(a=>!a.archived)&&<p role="status">Сначала добавьте собственный счёт в настройках (Счета и кошельки / Импорт выписки).</p>}
    <div className="dialog-actions goal-workspace-actions">{button('create',!accounts.some(a=>!a.archived))}
      {detail&&active&&<>{button('update')}{button('contribution')}{button('use',!detail.card.savedCents)}
        {button('skip',!detail.installments.length)}{button('void',!reversible.length)}{button('complete',!detail.snapshot.reached)}</>}
      {detail?.card.status==='completed'&&button('reopen')}
      {detail&&detail.card.status!=='archived'&&button('archive')}
      {detail?.card.status==='archived'&&button('restore')}
    </div>
    {mode&&<form className="surface goal-workspace-form" onSubmit={ev=>void submit(ev)} aria-label={actionLabel[mode]}>
      <h2>{actionLabel[mode]}</h2>
      <label className="field"><span>Дата события</span><input type="date" required max={asOf} value={date} onChange={e=>setDate(e.target.value)}/></label>
      {mode==='create'&&<label className="field"><span>Счёт накоплений</span>
        <select required value={account} onChange={e=>setAccount(e.target.value)}>
          <option value="">Выберите счёт</option>{accounts.filter(a=>!a.archived).map(a=><option key={a.id} value={a.id}>{a.name} · доступно {formatRubMinor(a.available)}</option>)}
        </select></label>}
      {mode!=='create'&&selected&&<p className="small-hint">Счёт: {accounts.find(a=>a.id===selected.accountId)?.name??'Недоступен'}</p>}
      {(mode==='create'||mode==='update')&&<>
        <label className="field"><span>Название</span><input required maxLength={160} value={title} onChange={e=>setTitle(e.target.value)}/></label>
        <label className="field"><span>Категория</span><select value={category} onChange={e=>setCategory(e.target.value as GoalCategory)}>
          {Object.entries(labels).map(([key,label])=><option key={key} value={key}>{label}</option>)}
        </select></label>
        <label className="field"><span>Целевая сумма, ₽</span><input required inputMode="decimal" value={target} onChange={e=>setTarget(e.target.value)}/></label>
        <label className="field"><span>Срок</span><input type="date" required value={deadline} onChange={e=>setDeadline(e.target.value)}/></label>
        <label className="field"><span>Фиксированный ежемесячный взнос, ₽ (пусто - автоматически)</span><input inputMode="decimal" value={monthly} onChange={e=>setMonthly(e.target.value)}/></label>
        {mode==='create'&&<label className="field"><span>Выделить из текущего остатка, ₽</span><input required inputMode="decimal" value={opening} onChange={e=>setOpening(e.target.value)}/></label>}
      </>}
      {(mode==='contribution'||mode==='use')&&<>
        <label className="field"><span>Сумма, ₽</span><input required inputMode="decimal" value={amount} onChange={e=>setAmount(e.target.value)}/></label>
        <label className="field"><span>Способ</span><select value={funding} onChange={e=>setFunding(e.target.value)}>
          <option value={mode==='contribution'?'virtual':'virtual-release'}>{mode==='contribution'?'Выделить из остатка без перевода':'Освободить средства без расхода'}</option>
          {!guest&&<option value="account-transfer">Реальный перевод между своими счетами</option>}
          {!guest&&mode==='use'&&<option value="expense">Фактическая покупка (расход)</option>}
        </select></label>
        {funding==='account-transfer'&&<label className="field"><span>{mode==='contribution'?'Списать со счёта':'Перевести на счёт'}</span>
          <select required value={counterparty} onChange={e=>setCounterparty(e.target.value)}><option value="">Выберите счёт</option>
            {accounts.filter(a=>!a.archived&&a.id!==selected?.accountId).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}
          </select></label>}
      </>}
      {(mode==='skip'||mode==='contribution')&&<label className="field"><span>{mode==='skip'?'Дата пропущенного взноса':'Отнести к взносу (необязательно)'}</span>
        <select required={mode==='skip'} value={due} onChange={e=>setDue(e.target.value)}><option value="">Выберите дату</option>
          {detail?.installments.map(x=><option key={x.dueOn} value={x.dueOn}>{displayDate(x.dueOn)}</option>)}
        </select></label>}
      {mode==='void'&&<label className="field"><span>Событие для отмены</span><select required value={eventId} onChange={e=>setEventId(e.target.value)}>
        <option value="">Выберите событие</option>{reversible.map(e=><option key={e.id} value={e.id}>{displayDate(e.on)} · {actionLabel[e.type as Mode]} {'amountCents' in e?formatRubMinor(e.amountCents):''}</option>)}
      </select></label>}
      {(mode==='skip'||mode==='void')&&<label className="field"><span>Причина</span><input required={mode==='void'} maxLength={500} value={reason} onChange={e=>setReason(e.target.value)}/></label>}
      <label className="field"><span><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/> Подтверждаю изменение {funding==='account-transfer'||funding==='expense'?'и фактическую проводку':''}</span></label>
      {error&&<p role="alert">{error}</p>}
      <div className="dialog-actions"><button className="button-primary" type="submit" disabled={!canWrite||!confirmed}>Подтвердить</button>
        <button type="button" className="button-secondary" onClick={()=>setMode(null)} disabled={busy}>Отмена</button></div>
    </form>}
  </div>;
}
