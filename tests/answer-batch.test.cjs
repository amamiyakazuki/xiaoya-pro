const {test} = require('node:test');
const assert = require('node:assert/strict');
const {parseHTML} = require('linkedom');
require('../extension/ai-question.js');
require('../extension/answer-dom.js');
const B = require('../extension/answer-batch.js');
const {createAdapter} = require('../extension/answer-page.js');
const {createDriver} = require('../extension/answer-driver.js');
const {AIError} = require('../extension/ai-client.js');
const task = (n = 1) => ({id:`t${n}`, courseId:'11', nodeId:String(n), typeCode:2, name:`任务${n}`,courseName:'模拟课程', finished:false});
const pause = () => new Promise(r=>setImmediate(r));
async function settled(engine) {for(let i=0;i<100 && engine.busy();i++)await pause(); assert.equal(engine.busy(),false); return engine.get();}
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
const q = {id:'question_123',type:'short',stem:'计算一加一',options:[]};
function fixture(options={}) {
  const data={...(options.data||{})},calls=[];
  let account='account',filled=false;
  const snapshot=()=>({complete:true,questions:[{question:q,fingerprint:'q',state:filled?'done':'empty',writable:true}],fingerprint:'paper'});
  const driver={
    async open(t){calls.push(['open',t.id]);filled=false;return snapshot();},
    async inspect(){return snapshot();},
    async fill(t,item){calls.push(['fill',t.id,item]);filled=true;},
    async submit(t){calls.push(['submit',t.id]);},
    async verify(){calls.push(['verify']);return true;},
    async recheck(){return true;},halt(){calls.push(['halt']);},...options.driver};
  const engine=B.createEngine({storage:{async get(){return structuredClone(data);},async set(v){Object.assign(data,structuredClone(v));}},driver,
    getAccount:async()=>account,query:async(q,signal)=>{calls.push(['query',q]);return {solution:{kind:'text',text:'2'}};},uuid:()=> 'batch',...options,driver});
  return {engine,data,calls,driver,snapshot,setAccount(v){account=v;},start:(tasks=[task()])=>engine.start({account:'account',tasks})};
}
test('only stable whole-task identities are selectable; hidden selections persist and account changes clear them',()=>{
  const tasks=[task(),task(2),{...task(3),finished:true},{...task(4),typeCode:1},{...task(5),nodeId:null}];
  assert.deepEqual(B.selection(tasks,['t1','t2','t3','t4','t5'],'a','a'),['t1','t2']);
  assert.deepEqual(B.selection(tasks,['t1'],'b','a'),[]);
  assert.deepEqual([1,2,3,4,5].filter(typeCode=>B.eligible({...task(),typeCode})),[2,3,4]);
  assert.equal(B.matches('https://whut.ai-augmented.com/app/jx-web/course_paper/mycourse/11/1/3/4',B.canonical(task())),true);
  assert.equal(B.matches('https://whut.ai-augmented.com/app/jx-web/course_paper/mycourse/11/2/3/4',B.canonical(task())),false);
});
test('confirmed subset completes query → fill → submit → receipt, never opens unselected tasks',async()=>{
 const f=fixture(); await f.start([task(2)]);const state=await settled(f.engine);
 assert.equal(state.stage,'finished');assert.equal(state.results[0].status,'done');
 assert.deepEqual(f.calls.map(c=>c[0]),['open','query','fill','submit','verify']);assert.equal(f.calls[0][1],'t2');
 assert.ok(!JSON.stringify(f.data).includes(q.stem));assert.ok(!JSON.stringify(f.data).includes('solution'));
});
test('all answers are collected before any write, and one AI failure skips the whole task',async()=>{
 let count=0;const f=fixture({query:async()=>{if(++count===2)throw Error('模拟服务失败');return {solution:{kind:'text',text:'2'}};}});
 const original=f.driver.open;f.driver.open=async t=>{const s=await original(t);s.questions.push({...s.questions[0],question:{...q,id:'question_124'}});return s;};
 await f.start();const state=await settled(f.engine);assert.equal(state.results[0].status,'pending');assert.equal(state.results[0].message,'第 2 题：模拟服务失败');assert.ok(!f.calls.some(c=>c[0]==='fill'||c[0]==='submit'));
});
test('AI failure results preserve the page question number and distinguish timeout, rate and format errors',async()=>{
 for(const code of ['timeout','rate','answer',null]) {
  const error=code && new AIError(code);
  const f=fixture({query:async()=>{if(error)throw error;return {};}});
  const open=f.driver.open;
  f.driver.open=async t=>{const s=await open(t);s.questions[0].number=code?7:undefined;s.questions[0].numberSource=code?'page':'order';return s;};
  await f.start();const state=await settled(f.engine);
  assert.equal(state.results[0].status,'pending');
  assert.equal(state.results[0].message, error ? `第 7 题：${error.message}` : '第 1 题（页面顺序）：AI 未返回可填写的结构化答案。');
  assert.ok(!f.calls.some(c=>['fill','submit'].includes(c[0])));
 }
});
test('unsupported task is pending and next selected task still executes',async()=>{
 const f=fixture();const original=f.driver.open;f.driver.open=async t=>t.id==='t1'?{complete:true,questions:[{state:'unknown'}]}:original(t);
 await f.start([task(),task(2)]);const state=await settled(f.engine);assert.deepEqual(state.results.map(r=>r.status),['pending','done']);assert.equal(f.calls.find(c=>c[0]==='submit')[1],'t2');
});
test('manual complete answers are retained and never sent to AI',async()=>{
 const f=fixture();f.driver.open=async()=>({...f.snapshot(),questions:[{question:q,state:'done',writable:false}]});f.driver.inspect=f.driver.open;
 await f.start();await settled(f.engine);assert.ok(!f.calls.some(c=>['query','fill'].includes(c[0])));assert.ok(f.calls.some(c=>c[0]==='submit'));
});
test('changed paper fingerprint stops before writing',async()=>{
 const f=fixture();f.driver.inspect=async()=>({...f.snapshot(),fingerprint:'changed'});await f.start();const state=await settled(f.engine);assert.equal(state.results[0].status,'pending');assert.ok(!f.calls.some(c=>['fill','submit'].includes(c[0])));
});
test('stop during AI ignores late answer and prevents later tasks',async()=>{
 const gate=deferred();let asked=false;const f=fixture({query:async()=>{asked=true;await gate.promise;return {solution:{kind:'text',text:'2'}};}});
 await f.start([task(),task(2)]);while(!asked)await pause();await f.engine.stop();gate.resolve();const state=await settled(f.engine);assert.equal(state.stage,'stopped');assert.equal(f.calls.filter(c=>c[0]==='open').length,1);assert.ok(!f.calls.some(c=>['fill','submit'].includes(c[0])));
});
test('stop while startup account validation awaits cancels the pending start',async()=>{
 const gate=deferred();const f=fixture({getAccount:()=>gate.promise});const start=f.start();await pause();await f.engine.stop();gate.resolve('account');await assert.rejects(start,/取消/);assert.equal(f.calls.filter(c=>c[0]==='open').length,0);
});
test('account change during AI pauses all subsequent writes and tasks',async()=>{
 const f=fixture({query:async()=>{f.setAccount('other');return {solution:{kind:'text',text:'2'}};}});await f.start([task(),task(2)]);const state=await settled(f.engine);assert.equal(state.stage,'paused');assert.ok(!f.calls.some(c=>c[0]==='fill'));
});
test('missing receipt pauses, forbids a new batch, and manual check never resubmits',async()=>{
 const f=fixture({driver:{verify:async()=>false}});await f.start([task(),task(2)]);let state=await settled(f.engine);assert.equal(state.stage,'uncertain');await assert.rejects(f.start(),/待核对/);await f.engine.verify();state=await f.engine.get();assert.equal(state.inFlight,false);assert.equal(f.calls.filter(c=>c[0]==='submit').length,1);assert.equal(f.calls.filter(c=>c[0]==='open').length,1);
});
test('stop after submit still verifies the in-flight operation without starting the next task',async()=>{
 const gate=deferred();let submitted=false;const f=fixture({driver:{submit:async()=>{submitted=true;await gate.promise;}}});await f.start([task(),task(2)]);while(!submitted)await pause();await f.engine.stop();gate.resolve();const state=await settled(f.engine);assert.equal(state.results[0].status,'done');assert.equal(state.stage,'stopped');assert.equal(f.calls.filter(c=>c[0]==='open').length,1);
});
test('worker restart pauses persisted running state and preserves uncertain submissions',async()=>{
 for(const inFlight of [false,true]){const f=fixture({data:{[B.KEY]:{id:'old',enabled:true,inFlight,tasks:[B.canonical(task())],index:0,results:[],account:'account'}}});const state=await f.engine.get();assert.equal(state.enabled,false);assert.equal(state.stage,inFlight?'uncertain':'paused');assert.equal(f.calls.length,0);}
});
test('stopping before the submit request was dispatched clears the lock without polling a receipt',async()=>{
 const entered=deferred(), resume=deferred();
 const storage={async get(){return {};},async set(values){
  const state=values[B.KEY];
  if(state.enabled && state.inFlight){entered.resolve();await resume.promise;}
 }};
 const f=fixture({storage});
 await f.start([task(),task(2)]);
 await entered.promise;
 const stop=f.engine.stop();
 resume.resolve();
 await stop;
 const state=await settled(f.engine);
 assert.equal(state.stage,'stopped');
 assert.equal(state.inFlight,false);
 assert.match(state.results[0].message,/指令发出前/);
 assert.ok(!f.calls.some(c=>['submit','verify'].includes(c[0])||c[1]==='t2'));
});
test('a lost submit reply and a fresh unfinished status keep the original task locked',async()=>{
 let clicks=0;
 const f=fixture({driver:{async submit(){clicks++;throw Error('lost submit reply');},async verify(){return false;},async recheck(){return false;}}});
 await f.start([task(),task(2)]);
 const state=await settled(f.engine);
 assert.equal(state.stage,'uncertain');
 assert.equal(state.inFlight,true);
 assert.deepEqual(await f.engine.verify(),{ok:true,confirmed:false});
 await assert.rejects(f.start([task(2)]),/待核对/);
 assert.equal(clicks,1);
 assert.ok(!f.calls.some(c=>c[1]==='t2'));
});
test('stopping or restoring a batch during filling marks the current task for draft review',async()=>{
 const entered=deferred(), resume=deferred();
 const f=fixture({driver:{async fill(){entered.resolve();await resume.promise;}}});
 await f.start([task(),task(2)]);
 await entered.promise;
 const recovered=fixture({data:f.data});
 const restored=await recovered.engine.get();
 assert.equal(restored.stage,'paused');
 assert.equal(restored.results[0].status,'pending');
 assert.match(restored.results[0].message,/部分答案/);
 assert.equal(recovered.calls.length,0);
 await f.engine.stop();
 resume.resolve();
 const stopped=await settled(f.engine);
 assert.equal(stopped.stage,'stopped');
 assert.deepEqual(stopped.results.map(r=>r.status),['pending','waiting']);
 assert.match(stopped.results[0].message,/原答题页/);
 assert.ok(!f.calls.some(c=>c[0]==='submit'||c[1]==='t2'));
});
test('lost connection while filling pauses the batch for draft review',async()=>{
 const base=B.canonical(task());
 const api={tabs:{async create(){return {id:1};},async get(){return {id:1,url:base.url};},async sendMessage(id,message){
  if(message.action==='fill')throw Error('lost channel');
  return {ok:true,snapshot:{pageToken:'page',complete:true,fingerprint:'paper',questions:[{question:q,state:'empty',writable:true,fingerprint:'q'}]}};
 }}};
 const driver=createDriver({chrome:api,getBatchId:()=> 'batch'});
 const f=fixture({driver});
 await f.start([task(),task(2)]);
 const stopped=await settled(f.engine);
 assert.equal(stopped.stage,'paused');
 assert.match(stopped.message,/与执行页断开/);
 assert.deepEqual(stopped.results.map(r=>r.status),['pending','waiting']);
});
test('a failed fill only continues the batch when the page explicitly confirms no write was attempted',async()=>{
 for (const fillBeforeWrite of [true,false,undefined]) {
  let opened=0,url,filled=false,submitted=false;
  const api={tabs:{async create(tab){opened++;url=tab.url;return {id:1};},async get(){return {id:1,url};},async sendMessage(id,message){
   if(message.action==='fill') {
    if(opened===1)return {ok:false,error:'控件状态变化。',fillBeforeWrite};
    filled=true;
   }
   if(message.action==='submit')submitted=true;
   return {ok:true,snapshot:{pageToken:'page',complete:true,fingerprint:'paper',submitted,questions:[{question:q,state:filled?'done':'empty',writable:true,fingerprint:'q'}]}};
  }}};
  const driver=createDriver({chrome:api,getBatchId:()=> 'batch'});
  const f=fixture({driver});
  await f.start([task(),task(2)]);
  const result=await settled(f.engine);
  assert.equal(opened,fillBeforeWrite?2:1);
  assert.equal(result.stage,fillBeforeWrite?'finished':'paused');
  assert.deepEqual(result.results.map(r=>r.status),fillBeforeWrite?['pending','done']:['pending','waiting']);
  assert.match(fillBeforeWrite?result.results[0].message:result.message,/控件状态变化/);
 }
});
test('a later question failure pauses the batch if the previous question was already written',async()=>{
 let writes=0;
 const f=fixture({driver:{async fill(){
  if(++writes===2)throw Error('下一题控件在写入前变化。');
  return {filled:true};
 }}});
 const paper=()=>{const snapshot=f.snapshot();snapshot.questions.push({...snapshot.questions[0],question:{...q,id:'question_124'}});return snapshot;};
 f.driver.open=async t=>{f.calls.push(['open',t.id]);return paper();};
 f.driver.inspect=async()=>paper();
 await f.start([task(),task(2)]);
 const result=await settled(f.engine);
 assert.equal(result.stage,'paused');
 assert.match(result.results[0].message,/部分答案/);
 assert.equal(result.results[1].status,'waiting');
 assert.deepEqual(f.calls.filter(c=>c[0]==='open'),[['open','t1']]);
});
test('duplicate task identity rejects before any page action',async()=>{
 const f=fixture();
 await assert.rejects(f.start([task(),{...task(),id:'duplicate'}]),/重复/);
 assert.equal(f.calls.length,0);
});
function page({manual='',total=1,permit=async()=>true,delay=async()=>{}}={}) {
 const {document,window}=parseHTML(`<html><body><div id="survey_page"><span class="score_sub_title">共${total}题（100分）</span><form id="question_content"><div class="question"><div class="exam_question_stem"><div class="stem_title">填入结果 <span class="xy_richtext_blank_number_warp">(1) ____</span> 和 <span class="xy_richtext_blank_number_warp">(2) ____</span></div><span class="score">[填空题 100 分]</span></div><div id="question_123" class="question_gap_subject"><div class="_label">填空1:</div><textarea>${manual}</textarea><div class="_label">填空2:</div><textarea></textarea></div></div><button type="submit">提交</button></form></div></body></html>`);
 const card=document.createElement('div');card.className='answer_info_card';card.innerHTML='<ul class="sheet_list"><li><a id="#123">1</a></li></ul>';document.querySelector('#survey_page').append(card);
 const syncCard=()=>{const done=[...document.querySelectorAll('textarea')].every(e=>e.value.trim());card.querySelector('li').title=done?'已答题':'未答题';card.querySelector('li').className=done?'finish':'';};
 document.addEventListener('input',syncCard);syncCard();
 const location=new URL(B.canonical(task()).url);const adapter=createAdapter({document,location,permit,uuid:()=> 'page',delay});
 const command=(action,extra={})=>adapter.command({action,task:B.canonical(task()),batchId:'batch',pageToken:'page',...extra});
 return {document,window,location,adapter,command};
}
test('DOM adapter fills blanks in order, preserves partial manual draft, and never includes it in query',async()=>{
 const p=page({manual:'人工保留'});const s=(await p.command('inspect')).snapshot;assert.equal(s.complete,true);assert.equal(s.questions[0].state,'partial');assert.ok(!JSON.stringify(s).includes('人工保留'));
 await p.command('fill',{item:{id:q.id,fingerprint:s.questions[0].fingerprint,solution:{kind:'fill',values:['替换禁止','4']}}});
 assert.deepEqual([...p.document.querySelectorAll('textarea')].map(e=>e.value),['人工保留','4']);assert.equal((await p.command('inspect')).snapshot.questions[0].state,'done');
});
test('incomplete paper and stale document token cannot submit',async()=>{
 const p=page({total:2});assert.equal((await p.command('inspect')).snapshot.complete,false);
 assert.match((await p.command('submit',{fingerprint:'x'})).reason,/核对/);
 assert.match((await p.command('submit',{pageToken:'old'})).reason,/旧交卷指令/);
 await assert.rejects(p.command('fill',{pageToken:'old'}),/旧指令/);
});
test('incomplete and duplicate papers show the reason in the batch without querying or filling', async () => {
 const p=page({total:2});
 const f=fixture();
 f.driver.open=async ()=>(await p.command('inspect')).snapshot;
 await f.start();
 let state=await settled(f.engine);
 assert.match(state.results[0].message,/当前页面读取到 1 题，卷面共 2 题/);
 const question=p.document.querySelector('.question');
 question.after(question.cloneNode(true));
 await f.start();
 state=await settled(f.engine);
 assert.match(state.results[0].message,/重复题目/);
 assert.ok(!f.calls.some(c=>['query','fill','submit'].includes(c[0])));
});
test('stopping between two blanks keeps the written blank and a newly confirmed batch fills only the rest', async () => {
 const entered=deferred(), resume=deferred();
 let paused=false;
 const p=page({delay:async ms=>{if(ms===100&&!paused){paused=true;entered.resolve();await resume.promise;}}});
 const s=(await p.command('inspect')).snapshot;
 const item={id:q.id,fingerprint:s.questions[0].fingerprint,solution:{kind:'fill',values:['已写入','未写入']}};
 const fill=p.command('fill',{item});
 await entered.promise;
 await p.command('halt');
 resume.resolve();
 await assert.rejects(fill,error=>/已停止/.test(error.message)&&error.fillBeforeWrite===false);
 assert.deepEqual([...p.document.querySelectorAll('textarea')].map(e=>e.value),['已写入','']);
 await p.command('fill',{batchId:'confirmed-next',item:{...item,solution:{kind:'fill',values:['不得覆盖','补齐']}}});
 assert.deepEqual([...p.document.querySelectorAll('textarea')].map(e=>e.value),['已写入','补齐']);
});
test('revoked authorization stops native input writes',async()=>{
 const p=page({permit:async()=>false});const s=(await p.command('inspect')).snapshot;await assert.rejects(p.command('fill',{item:{id:q.id,fingerprint:s.questions[0].fingerprint,solution:{kind:'fill',values:['2','4']}}}),error=>/未获/.test(error.message)&&error.fillBeforeWrite===true);assert.equal(p.document.querySelector('textarea').value,'');
});
test('DOM native submit is only accepted after whole-paper readback; submitting is not submitted',async()=>{
 const p=page();const s=(await p.command('inspect')).snapshot;await p.command('fill',{item:{id:q.id,fingerprint:s.questions[0].fingerprint,solution:{kind:'fill',values:['2','4']}}});
 let count=0;const button=p.document.querySelector('button');button.addEventListener('click',()=>count++);await p.command('submit',{fingerprint:s.fingerprint});assert.equal(count,1);
 button.disabled=true;button.textContent='提交中';assert.equal((await p.command('inspect')).snapshot.submitted,false);button.textContent='已提交';assert.equal((await p.command('inspect')).snapshot.submitted,true);
});
test('a known pre-click failure reports blocked without clicking any candidate',async()=>{
 let allowed=true;
 const p=await preparedPage({permit:async()=>allowed});
 const button=p.document.querySelector('button[type=submit]');
 const duplicate=button.cloneNode(true);
 button.after(duplicate);
 let clicks=0;
 for(const candidate of [button,duplicate])candidate.addEventListener('click',()=>clicks++);
 const result=await p.command('submit',{fingerprint:p.fingerprint});
 assert.equal(result.blocked,true);
 assert.match(result.reason,/不能唯一确定/);
 allowed=false;
 const denied=await p.command('submit',{fingerprint:p.fingerprint});
 assert.equal(denied.blocked,true);
 assert.match(denied.reason,/未获/);
 assert.equal(clicks,0);
});
test('late submission only clicks the unique enabled platform button',async()=>{
 const p=await preparedPage();
 const button=p.document.querySelector('button[type=submit]');
 button.textContent='补交';
 button.disabled=true;
 let clicks=0;
 button.addEventListener('click',()=>clicks++);
 const unavailable=await p.command('submit',{fingerprint:p.fingerprint});
 assert.equal(unavailable.blocked,true);
 assert.equal(clicks,0);
 button.disabled=false;
 const available=await p.command('submit',{fingerprint:p.fingerprint});
 assert.equal(available.ok,true);
 assert.equal(clicks,1);
});
test('draft focus checks the original tab and document again before switching windows',async()=>{
 const p=page();
 const base=B.canonical(task());
 const calls=[];
 let tab={id:1,windowId:9,url:base.url}, reloaded=false;
 const api={tabs:{async create(){return {id:1};},async get(){return tab;},async sendMessage(id,message){
  assert.equal(id,1);
  if(reloaded)message={...message,pageToken:'new-page'};
  return p.adapter.command(message);
 },async update(id,settings){calls.push(['tab',id,settings]);}},windows:{async update(id,settings){calls.push(['window',id,settings]);}}};
 const driver=createDriver({chrome:api,getBatchId:()=> 'batch'});
 await driver.open(base,new AbortController().signal);
 const reference=driver.draftReference();
 assert.deepEqual(reference,{tabId:1,pageToken:'page'});
 const canFocus=()=>true;
 await assert.rejects(driver.focusDraft(base,reference,async()=>{reloaded=true;return true;},canFocus),/原答题页/);
 assert.deepEqual(calls,[]);
 reloaded=false;
 await assert.rejects(driver.focusDraft(base,reference,async()=>{throw Error('账号已变化');},canFocus),/账号/);
 assert.equal(await driver.focusDraft(base,reference,async()=>false,canFocus),false);
 assert.equal(await driver.focusDraft(base,reference,async()=>true,()=>false),false);
 assert.deepEqual(calls,[]);
 await driver.focusDraft(base,reference,async()=>{calls.push(['verify']);return true;},canFocus);
 assert.deepEqual(calls,[['verify'],['tab',1,{active:true}],['window',9,{focused:true}]]);
 tab={...tab,url:B.canonical(task(2)).url};
 await assert.rejects(driver.focusDraft(base,reference,async()=>true,canFocus),/原答题页/);
});
test('driver only follows a matching child of its dedicated tab and validates permit sender',async()=>{
 let created,clock=0;let childFn;const tabs=new Map();let n=0;const base=B.canonical(task());const api={tabs:{onCreated:{addListener(fn){childFn=fn;}},async create(o){created=o;tabs.set(1,{id:1,url:o.url});return tabs.get(1);},async get(id){return tabs.get(id);},async sendMessage(id,m){if(m.action==='inspect')return {ok:true,snapshot:{pageToken:`p${id}`,pageKind:id===3?'paper':'resource',canEnter:id===1,complete:id===3}};if(m.action==='enter'){childFn({id:2,openerTabId:1});tabs.set(2,{id:2,url:'https://evil.test'});childFn({id:3,openerTabId:1});tabs.set(3,{id:3,url:'https://whut.ai-augmented.com/app/jx-web/course_paper/mycourse/11/1/3/4'});}return {ok:true};}}};
 const d=createDriver({chrome:api,getBatchId:()=> 'b',now:()=>clock,delay:async()=>{clock+=500;},timeout:1000});await d.open(base,new AbortController().signal);assert.equal(created.url,base.url);assert.equal(d.usesTab(1),true);assert.equal((await d.enter(base,new AbortController().signal)).complete,true);
 assert.equal(d.usesTab(3),true);assert.equal(d.usesTab(2),false);
 assert.equal(await d.permits({pageToken:'p3'},{tab:{id:3},frameId:0,url:tabs.get(3).url},base),true);assert.equal(await d.permits({pageToken:'p3'},{tab:{id:2},frameId:0,url:tabs.get(3).url},base),false);
});
function background(options={}) {
 const vm=require('node:vm'),fs=require('node:fs');let listener;
 const data={},events=[],videoEvents=[],gate=options.gate,answerPage=deferred();
 const tabs=new Map([
  [1,{id:1,url:'https://whut.ai-augmented.com/app/jx-web/mycourse',status:'complete'}],
  [2,{id:2,url:B.canonical(task()).url,status:'complete'}],
  [3,{id:3,url:'https://whut.ai-augmented.com/app/jx-web/mycourse/11/resource/_/9',pendingUrl:B.canonical(task()).url}],
  [4,{id:4,url:'https://whut.ai-augmented.com/app/jx-web/course_paper/mycourse/11/4/3/4',lastAccessed:99}]
 ]);
 const local={async get(){return structuredClone(data);},async set(value){Object.assign(data,structuredClone(value));},async remove(key){delete data[key];}};
 const context=vm.createContext({URL,structuredClone,AbortController,setTimeout,clearTimeout,crypto:require('node:crypto').webcrypto,importScripts(){},
 XiaoyaAnswerBatch:B,XiaoyaAnswerDriver:{createDriver:()=>({async open(){events.push('open');return answerPage.promise;},halt(){events.push('halt');answerPage.resolve();},usesTab:id=>id===2,permits:async()=>false})},
 XiaoyaTaskData:{createTaskStore:()=>({async load(){if(gate)await gate.promise;return {status:'ok',account:'account',tasks:[task()]};},currentAccount:async()=> 'account'})},
 XiaoyaAIService:{createService:()=>({available:async()=>true,handle:async()=>({ok:true}),querySaved:async()=>({solution:{kind:'text',text:'2'}})})},
 chrome:{runtime:{id:'ext',getURL:p=>'chrome-extension://ext/'+p,onMessage:{addListener(fn){listener=fn;}}},storage:{local,session:local},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{
  onUpdated:{addListener(){}},onRemoved:{addListener(){}},
  async get(id){return tabs.get(id);},
  async query(){return [...tabs.values()];},
  async update(id,changes){Object.assign(tabs.get(id),changes);},
  async sendMessage(id,message){
   videoEvents.push([id,message.type]);
   if(message.type==='health' && options.videoGate) await options.videoGate.promise;
   return {ok:true,protocol:6,loggedInHome:true};
  }
 }}});
 vm.runInContext(fs.readFileSync(require.resolve('../extension/worker.js'),'utf8'),context);
 return {data,events,videoEvents,send:(message,sender={id:'ext',url:'chrome-extension://ext/sidepanel.html'})=>new Promise(resolve=>listener(message,sender,resolve))};
}
test('background rejects content-page batch control and unselected/unknown task IDs',async()=>{
 const b=background();assert.equal((await b.send({type:'auto:start',ids:['t1'],account:'account'},{id:'ext',url:'https://whut.ai-augmented.com/',tab:{id:1}})).ok,false);
 assert.equal((await b.send({type:'auto:start',ids:['not-listed'],account:'account'})).ok,false);assert.deepEqual(b.events,[]);
});
test('background stop bypasses pending task refresh and cancels the queued start',async()=>{
 const gate=deferred(),b=background({gate});const start=b.send({type:'auto:start',ids:['t1'],account:'account'});await pause();assert.equal((await b.send({type:'auto:stop'})).ok,true);gate.resolve();assert.match((await start).error,/取消/);assert.ok(!b.events.includes('open'));
});
test('video and answer queues can start in either order and stop independently',async()=>{
 for (const videoFirst of [true,false]) {
  const b=background();
  const videoStart={type:'start',tabId:1,options:{background:true}};
  const answerStart={type:'auto:start',ids:['t1'],account:'account'};
  for (const command of videoFirst?[videoStart,answerStart]:[answerStart,videoStart]) assert.equal((await b.send(command)).ok,true);
  assert.equal(b.data.xiaoyaRun.enabled,true);
  assert.equal(b.data[B.KEY].enabled,true);
  assert.equal(b.data.xiaoyaRun.tabId,1);
  assert.ok(b.events.includes('open'));
  assert.match((await b.send({type:'ai:save'})).error,/自动作答/);
  if (videoFirst) {
   await b.send({type:'auto:stop'});
   assert.equal(b.data.xiaoyaRun.enabled,true);
   assert.deepEqual(b.videoEvents,[[1,'health'],[1,'run']]);
   await b.send({type:'stop',tabId:1});
  } else {
   await b.send({type:'stop',tabId:1});
   assert.equal(b.data[B.KEY].enabled,true);
   assert.ok(!b.events.includes('halt'));
   await b.send({type:'auto:stop'});
  }
  assert.equal(b.data[B.KEY].enabled,false);
  assert.equal(b.data.xiaoyaRun.enabled,false);
  assert.deepEqual(b.videoEvents.at(-1),[1,'halt']);
 }
});
test('video startup and stop are independent of an answer start waiting for a task refresh',async()=>{
 const gate=deferred(),b=background({gate});
 const answer=b.send({type:'auto:start',ids:['t1'],account:'account'});
 await pause();
 assert.equal((await b.send({type:'start',tabId:1})).ok,true);
 assert.equal(b.data.xiaoyaRun.enabled,true);
 assert.equal((await b.send({type:'stop',tabId:1})).ok,true);
 assert.equal(b.data.xiaoyaRun.enabled,false);
 gate.resolve();
 assert.equal((await answer).ok,true);
 await b.send({type:'auto:stop'});
});
test('answer startup can proceed while the video page is still connecting',async()=>{
 const videoGate=deferred(),b=background({videoGate});
 const video=b.send({type:'start',tabId:1});
 await pause();
 assert.deepEqual(b.videoEvents,[[1,'health']]);
 assert.equal((await b.send({type:'auto:start',ids:['t1'],account:'account'})).ok,true);
 assert.equal(b.data[B.KEY].enabled,true);
 videoGate.resolve();
 assert.equal((await video).ok,true);
 await b.send({type:'auto:stop'});
});
test('video start and scan keep the active answer page and its pending navigation untouched',async()=>{
 const b=background();
 assert.equal((await b.send({type:'auto:start',ids:['t1'],account:'account'})).ok,true);
 for (const tabId of [2,3]) assert.match((await b.send({type:'start',tabId})).error,/答题执行页/);
 assert.deepEqual(b.videoEvents,[]);
 assert.equal((await b.send({type:'scan',tabId:2})).ok,true);
 assert.equal(b.data.xiaoyaRun.tabId,1);
 assert.ok(b.videoEvents.every(([tabId])=>tabId===1));
 await b.send({type:'auto:stop'});
});
test('a pending video scan does not resume on an answer execution tab',async()=>{
 const b=background();
 await b.send({type:'auto:start',ids:['t1'],account:'account'});
 b.data.xiaoyaPendingScan={tabId:2,sourceTabId:1};
 const result=await b.send({type:'login-ready'},{id:'ext',tab:{id:2}});
 assert.match(result.error,/原待办页正在答题/);
 assert.equal(b.data.xiaoyaPendingScan,undefined);
 assert.deepEqual(b.videoEvents,[]);
 await b.send({type:'auto:stop'});
});
test('background rejects foreign page mutation permits',async()=>{
 const b=background();assert.equal((await b.send({type:'auto:permit',batchId:'forged',taskId:'t1',action:'submit'},{id:'other'})).allowed,false);
});
test('DOM refuses unknown modal confirmations and incomplete-answer warnings',async()=>{
 const p=page();const s=(await p.command('inspect')).snapshot;await p.command('fill',{item:{id:q.id,fingerprint:s.questions[0].fingerprint,solution:{kind:'fill',values:['2','4']}}});
 let clicked=0;const modal=p.document.createElement('div');modal.className='ant-modal';modal.innerHTML='<p>存在未作答题目，确定提交吗？</p><button>确定</button>';p.document.body.append(modal);modal.querySelector('button').addEventListener('click',()=>clicked++);
 await p.command('confirm');assert.equal(clicked,0);modal.remove();await p.command('submit',{fingerprint:s.fingerprint});p.document.body.append(modal);await p.command('confirm');assert.equal(clicked,0);
 modal.querySelector('p').textContent='确认提交该份作业？';await p.command('confirm');assert.equal(clicked,1);await p.command('confirm');assert.equal(clicked,1);
});
test('content changed while awaiting per-write authorization is not filled',async()=>{
 const p=page({permit:async()=>{p.document.querySelector('.stem_title').textContent='另一道题';return true;}});
 const s=(await p.command('inspect')).snapshot;await assert.rejects(p.command('fill',{item:{id:q.id,fingerprint:s.questions[0].fingerprint,solution:{kind:'fill',values:['2','4']}}}),/题目发生变化/);assert.equal(p.document.querySelector('textarea').value,'');
});
test('cleared answer while submission confirmation is open is not confirmed',async()=>{
 const p=page();const s=(await p.command('inspect')).snapshot;await p.command('fill',{item:{id:q.id,fingerprint:s.questions[0].fingerprint,solution:{kind:'fill',values:['2','4']}}});await p.command('submit',{fingerprint:s.fingerprint});
 const modal=p.document.createElement('div');modal.className='ant-modal';modal.innerHTML='<p>确认提交作业？</p><button>确定</button>';p.document.body.append(modal);let clicked=0;modal.querySelector('button').addEventListener('click',()=>clicked++);
 p.document.querySelector('textarea').value='';await assert.rejects(p.command('confirm'),/答案已变化/);assert.equal(clicked,0);
});
function popupPage(options={}) {
 const p=page(options);const entry=p.document.createElement('button');entry.className='entry_task_btn';entry.textContent='点击进入任务>>>';p.document.body.append(entry);
 const dialog=p.document.createElement('div');dialog.className='ant-modal';dialog.innerHTML='<div class="ant-modal-confirm"><p>窗口被浏览器拦截，无法正常打开新的页面</p><p>你可以选择在当前页直接跳转至新的页面，或者手动处理浏览器拦截。</p><button>在当前页面跳转</button><button>关 闭</button></div>';p.document.body.append(dialog);
 return {...p,entry,dialog,button:dialog.querySelector('button')};
}
test('popup fallback requires our own entry attempt, exact known modal and unique button; clicked once',async()=>{
 const p=popupPage();let count=0;p.button.addEventListener('click',()=>count++);
 assert.equal((await p.command('inspect')).snapshot.canEnterCurrent,false);await assert.rejects(p.command('enter-current'),/未找到/);
 await p.command('enter');assert.equal((await p.command('inspect')).snapshot.canEnterCurrent,true);await p.command('enter-current');assert.equal(count,1);await assert.rejects(p.command('enter-current'),/未找到/);assert.equal(count,1);
});
test('unknown or ambiguous popup is never accepted as current-page navigation',async()=>{
 const p=popupPage();await p.command('enter');p.dialog.querySelector('p').textContent='无关的页面提示';assert.equal((await p.command('inspect')).snapshot.canEnterCurrent,false);
 p.dialog.querySelector('p').textContent='窗口被浏览器拦截，无法正常打开新的页面';const duplicate=p.button.cloneNode(true);p.dialog.append(duplicate);await assert.rejects(p.command('enter-current'),/未找到/);
});
test('stop while awaiting fallback authorization prevents current-page navigation',async()=>{
 const gate=deferred();let defer=false,count=0;const p=popupPage({permit:async()=>{if(defer)await gate.promise;return true;}});p.button.addEventListener('click',()=>count++);await p.command('enter');defer=true;const action=p.command('enter-current');await pause();await p.command('halt');gate.resolve();await assert.rejects(action,/停止/);assert.equal(count,0);
});
function entryDriver({navigate=true,loseAck=false,stopOnModal=false}={}) {
 let clock=0,blocked=false,paper=false,driver;const actions=[],base=B.canonical(task());
 const api={tabs:{async create(){return {id:1};},async get(){return {id:1,url:paper?'https://whut.ai-augmented.com/app/jx-web/course_paper/mycourse/11/1/3/4':base.url};},async sendMessage(id,m){
  if(m.action==='inspect'){if(blocked&&stopOnModal)driver.halt();return {ok:true,snapshot:{pageToken:'page',pageKind:paper?'paper':'resource',canEnter:!paper,canEnterCurrent:blocked&&!paper,complete:true}};}
  actions.push(m.action);if(m.action==='enter')blocked=true;if(m.action==='enter-current'){paper=navigate;if(loseAck)throw Error('reply channel closed');}return {ok:true};
 }}};
 driver=createDriver({chrome:api,getBatchId:()=> 'batch',now:()=>clock,delay:async()=>{clock+=100;},timeout:500});
 return {driver,actions,base};
}
test('driver handles blocked entry then waits for paper route, despite a complete preview',async()=>{
 const f=entryDriver({loseAck:true});const signal=new AbortController().signal;await f.driver.open(f.base,signal);const s=await f.driver.enter(f.base,signal);assert.equal(s.pageKind,'paper');assert.deepEqual(f.actions,['enter','enter-current']);
});
test('driver never repeats lost-ack fallback or treats complete preview as ready',async()=>{
 const f=entryDriver({navigate:false,loseAck:true});const signal=new AbortController().signal;await f.driver.open(f.base,signal);await assert.rejects(f.driver.enter(f.base,signal),/尚未进入/);assert.deepEqual(f.actions,['enter','enter-current']);
});
test('driver stop at popup discovery suppresses fallback',async()=>{
 const f=entryDriver({stopOnModal:true});const signal=new AbortController().signal;await f.driver.open(f.base,signal);await assert.rejects(f.driver.enter(f.base,signal),/停止/);assert.ok(!f.actions.includes('enter-current'));
});
test('real empty score subtitle preceding the count does not hide the total',async()=>{
 const p=page();const empty=p.document.createElement('div');empty.className='score_sub_title';p.document.querySelector('#survey_page').prepend(empty);
 const s=(await p.command('inspect')).snapshot;assert.equal(s.total,1);assert.equal(s.complete,true);
 p.document.querySelectorAll('.score_sub_title')[1].textContent='共15题（100分）';const incomplete=(await p.command('inspect')).snapshot;assert.equal(incomplete.total,15);assert.equal(incomplete.complete,false);
});
test('conflicting declared totals fail closed rather than selecting a convenient count',async()=>{
 const p=page();const extra=p.document.createElement('div');extra.className='score_sub_title';extra.textContent='共2题（100分）';p.document.querySelector('#survey_page').append(extra);
 const s=(await p.command('inspect')).snapshot;assert.equal(s.complete,false);assert.match(s.reason,/不一致/);
});
async function submissionDialog(options={}) {
 const p=page(options);const s=(await p.command('inspect')).snapshot;
 await p.command('fill',{item:{id:q.id,fingerprint:s.questions[0].fingerprint,solution:{kind:'fill',values:['2','4']}}});
 p.document.querySelector('button[type=submit]').textContent='补 交';await p.command('submit',{fingerprint:s.fingerprint});
 const modal=p.document.createElement('div');modal.setAttribute('role','dialog');modal.className='ant-modal-wrap xy-modal-warp xy-modal-warp-md';modal.innerHTML='<h3>提交作业/测练</h3><p>是否确定提交？</p><button><span>提 交</span></button><button><span>取 消</span></button>';p.document.body.append(modal);
 return {...p,modal};
}
test('Xiaoya role dialog and spaced submit label confirm exactly once without clicking cancel',async()=>{
 const p=await submissionDialog();let submit=0,cancel=0;const buttons=p.modal.querySelectorAll('button');buttons[0].addEventListener('click',()=>submit++);buttons[1].addEventListener('click',()=>cancel++);
 await p.command('confirm');await p.command('confirm');assert.equal(submit,1);assert.equal(cancel,0);
});
test('stop during real-shaped submission dialog authorization suppresses its click',async()=>{
 const gate=deferred();let waiting=false;const p=await submissionDialog({permit:async m=>{if(m.action==='confirm'){waiting=true;await gate.promise;}return true;}});let count=0;p.modal.querySelector('button').addEventListener('click',()=>count++);
 const confirmation=p.command('confirm');while(!waiting)await pause();await p.command('halt');gate.resolve();await assert.rejects(confirmation,/停止/);assert.equal(count,0);
});
test('spaced incomplete-answer warning or multiple confirmation dialogs cannot auto-confirm',async()=>{
 const p=await submissionDialog();let count=0;p.modal.querySelector('button').addEventListener('click',()=>count++);p.modal.querySelector('p').textContent='尚有未 作 答题目，是否确定提交？';await p.command('confirm');assert.equal(count,0);
 p.modal.querySelector('p').textContent='是否确定提交？';p.document.body.append(p.modal.cloneNode(true));await p.command('confirm');assert.equal(count,0);
});
test('fresh platform completion unlocks recheck even when no old tab connection exists',async()=>{
 let reads=0;const d=createDriver({chrome:{tabs:{async query(){throw Error('must not require old tabs');}}},getBatchId:()=> 'b',verifySubmitted:async t=>{reads++;assert.equal(t.nodeId,'1');return true;}});
 assert.equal(await d.recheck(B.canonical(task())),true);assert.equal(reads,1);
});
test('automatic verification falls back to fresh platform status without resubmitting',async()=>{
 let clock=0,reads=0;const commands=[];const base=B.canonical(task());
 const d=createDriver({chrome:{tabs:{async create(){return {id:1};},async get(){return {id:1,url:base.url};},async sendMessage(id,m){commands.push(m.action);return {ok:true,snapshot:{pageToken:'p',complete:true,submitted:false}};}}},getBatchId:()=> 'b',verifySubmitted:async()=>{reads++;return true;},now:()=>clock,delay:async()=>{clock+=500;},timeout:500});
 await d.open(base,new AbortController().signal);assert.equal(await d.verify(base),true);assert.equal(reads,1);assert.ok(!commands.includes('submit'));
});
test('fresh status errors are surfaced instead of leaving a misleading missing-page instruction',async()=>{
 const d=createDriver({chrome:{tabs:{}},getBatchId:()=> 'b',verifySubmitted:async()=>{throw Error('平台状态读取失败');}});await assert.rejects(d.recheck(B.canonical(task())),/平台状态读取失败/);
});
test('real result header with submission time and result badge is a receipt without a submit button',async()=>{
 const p=page();p.document.querySelector('button[type=submit]').remove();const header=p.document.createElement('div');header.className='exam_paper_sub_title flex_panel ver';header.innerHTML='<span>提交时间：2026/11/10 18:19:34</span><img alt="check_status"><span class="strong_label">最终成绩</span>';p.document.querySelector('#survey_page').prepend(header);
 assert.equal((await p.command('inspect')).snapshot.submitted,true);
 header.querySelector('span').textContent='提交时间：';assert.equal((await p.command('inspect')).snapshot.submitted,false);
});
test('old submission time cannot mark a task done while resubmission or processing is active',async()=>{
 const p=page();const header=p.document.createElement('div');header.className='exam_paper_sub_title';header.innerHTML='<span>提交时间：2026/11/10 18:19:34</span><img alt="check_status">';p.document.querySelector('#survey_page').prepend(header);
 assert.equal((await p.command('inspect')).snapshot.submitted,false);const button=p.document.querySelector('button[type=submit]');button.disabled=true;button.textContent='提交中';assert.equal((await p.command('inspect')).snapshot.submitted,false);
});
test('manual verification of the last uncertain task finishes and releases the batch',async()=>{
 const f=fixture({driver:{verify:async()=>false}});await f.start();await settled(f.engine);await f.engine.verify();const state=await f.engine.get();assert.equal(state.stage,'finished');assert.equal(state.inFlight,false);assert.equal(state.results[0].status,'done');
});
test('fresh unfinished status cannot be overridden by a stale submitted preview',async()=>{
 const d=createDriver({chrome:{tabs:{async query(){throw Error('must not inspect stale tabs after fresh unfinished state');}}},getBatchId:()=> 'b',verifySubmitted:async()=>false});assert.equal(await d.recheck(B.canonical(task())),false);
});

function addSuccessDialog(p, text='提交成功') {
 const modal=p.document.createElement('div');modal.setAttribute('role','dialog');
 modal.innerHTML=`<div class="ant-modal"><h3>成功</h3><p>${text}</p><button><span>确 定</span></button></div>`;
 p.document.body.append(modal);return modal;
}
test('current submission success dialog triggers a receipt hint but is never a submit confirmation',async()=>{
 const p=await submissionDialog();await p.command('confirm');p.modal.remove();
 const modal=addSuccessDialog(p);let clicks=0;modal.querySelector('button').addEventListener('click',()=>clicks++);
 const state=(await p.command('inspect')).snapshot;assert.equal(state.submissionSucceeded,true);assert.equal(state.submitted,false);
 await p.command('confirm');assert.equal(clicks,0);
 assert.equal((await p.command('inspect',{batchId:'other'})).snapshot.submissionSucceeded,false);
 assert.equal((await p.command('inspect',{task:{...B.canonical(task()),id:'other'}})).snapshot.submissionSucceeded,false);
});
test('old, hidden, ambiguous and unrelated success dialogs never accelerate verification',async()=>{
 const old=page();addSuccessDialog(old);assert.equal((await old.command('inspect')).snapshot.submissionSucceeded,false);
 const s=(await old.command('inspect')).snapshot;
 await old.command('fill',{item:{id:q.id,fingerprint:s.questions[0].fingerprint,solution:{kind:'fill',values:['2','4']}}});
 await old.command('submit',{fingerprint:s.fingerprint});assert.equal((await old.command('inspect')).snapshot.submissionSucceeded,false);
 const p=await submissionDialog();p.modal.remove();const modal=addSuccessDialog(p,'保存成功');
 assert.equal((await p.command('inspect')).snapshot.submissionSucceeded,false);
 modal.querySelector('p').textContent='提交成功';modal.hidden=true;assert.equal((await p.command('inspect')).snapshot.submissionSucceeded,false);
 modal.hidden=false;const duplicate=addSuccessDialog(p);assert.equal((await p.command('inspect')).snapshot.submissionSucceeded,false);
 duplicate.remove();modal.querySelector('p').textContent='提交成功失败';assert.equal((await p.command('inspect')).snapshot.submissionSucceeded,false);
});
function receiptDriver({verifySubmitted,timeout=25000}={}) {
 let clock=0;const actions=[],base=B.canonical(task());
 const driver=createDriver({chrome:{tabs:{async create(){return {id:1};},async get(){return {id:1,url:base.url};},async sendMessage(id,m){actions.push(m.action);return {ok:true,snapshot:{pageToken:'p',complete:true,submissionSucceeded:true}};}}},getBatchId:()=> 'batch',verifySubmitted,now:()=>clock,delay:async ms=>{clock+=ms;},timeout});
 return {driver,base,actions,time:()=>clock};
}
test('success receipt queries fresh state immediately and bounded retries allow delayed propagation',async()=>{
 let reads=0;const f=receiptDriver({verifySubmitted:async()=>++reads===2});
 await f.driver.open(f.base,new AbortController().signal);assert.equal(await f.driver.verify(f.base),true);
 assert.equal(f.time(),1000);assert.equal(reads,2);assert.ok(!f.actions.includes('confirm'));
 const pending=receiptDriver({verifySubmitted:async()=>false,timeout:2000});await pending.driver.open(pending.base,new AbortController().signal);
 assert.equal(await pending.driver.verify(pending.base),false);assert.equal(pending.time(),2000);assert.ok(!pending.actions.includes('submit'));
 const broken=receiptDriver({verifySubmitted:async()=>{throw Error('账号已变化');}});await broken.driver.open(broken.base,new AbortController().signal);
 await assert.rejects(broken.driver.verify(broken.base),/账号已变化/);assert.equal(broken.time(),0);
});
test('two selected tasks move from success dialog to next task after fresh confirmation without timeout',async()=>{
 let p,url,clock=0;const events=[];
 const driver=createDriver({chrome:{tabs:{
  async create(tab){url=tab.url;p=page();p.location.href=url;events.push(['open',url,clock]);
   p.document.querySelector('button[type=submit]').addEventListener('click',()=>{
    events.push(['submit',url,clock]);const modal=p.document.createElement('div');modal.setAttribute('role','dialog');modal.innerHTML='<h3>提交作业/测练</h3><p>是否确定提交？</p><button>提 交</button>';p.document.body.append(modal);
    modal.querySelector('button').addEventListener('click',()=>{modal.remove();addSuccessDialog(p);events.push(['success',url,clock]);});
   });return {id:1};},
  async get(){return {id:1,url};},async sendMessage(id,m){return p.adapter.command(m);}
 }},getBatchId:()=> 'batch',verifySubmitted:async t=>{events.push(['verified',t.url,clock]);return true;},now:()=>clock,delay:async ms=>{clock+=ms;}});
 const f=fixture({driver,query:async()=>({solution:{kind:'fill',values:['2','4']}})});
 await f.start([task(),task(2)]);const state=await settled(f.engine);
 assert.equal(state.stage,'finished');assert.deepEqual(state.results.map(r=>r.status),['done','done']);
 assert.deepEqual(events.map(e=>e[0]),['open','submit','success','verified','open','submit','success','verified']);
 assert.equal(events[4][2],events[3][2]);assert.equal(events[3][2]-events[2][2],500);
 assert.equal(clock,1000);
});

function diagnosticPaper(items) {
 const {document}=parseHTML(`<html><body><div id="survey_page"><span class="score_sub_title">共${items.length}题（100分）</span><div id="question_content">${items.map((item,i)=>`<div class="question"><div class="exam_question_stem">${item.number === null ? '' : `<span class="sequence">${item.number || i+1}.&nbsp;</span>`}<div class="stem_title">${item.stem || '只读诊断结构样本'}</div><span class="score">[${item.label} 20分]</span></div><div id="question_${i+100}" class="question_${item.subject}_subject">${item.body || ''}</div></div>`).join('')}</div></div></body></html>`);
 const adapter=createAdapter({document,location:new URL(B.canonical(task()).url),permit:async()=>true,uuid:()=> 'page',delay:async()=>{}});
 return {document,snapshot:()=>adapter.inspect(B.canonical(task()))};
}
const diagnosticChoice = (multiple=false) => ({label:multiple?'多选题':'单选题',subject:multiple?'multiple':'single',body:['A','B'].map((label,i)=>`<label class="ant-${multiple?'checkbox':'radio'}-wrapper"><input type="${multiple?'checkbox':'radio'}" value="${i+1}"><span class="exam_answer_item_sequence">${label}.</span><div class="xy_rich_text_base">模拟选项${label}</div></label>`).join('')});
test('observed lec4 and lec9 structures report every blocking question without saving uploaded content',async()=>{
 const lec4=diagnosticPaper([diagnosticChoice(),diagnosticChoice(true),{label:'附件题',subject:'attach',body:'<table><tr><td>private-code.py</td><td>上传成功</td></tr></table><input type="file">'},{label:'简答题',subject:'subjective',body:'<div class="DraftEditor-root"><div class="public-DraftEditor-content" contenteditable="false">私有报告正文</div></div>'}]);
 const s=lec4.snapshot();assert.equal(s.complete,true);
 const problems=B.questionProblems(s.questions);assert.match(problems,/第 3 题（附件题）：需要上传文件/);assert.match(problems,/第 4 题（简答题）：使用特殊文本编辑器/);
 assert.ok(!problems.includes('第 1 题'));assert.ok(!problems.includes('第 2 题'));
 const f=fixture();f.driver.open=async()=>s;await f.start();const state=await settled(f.engine);
 assert.equal(state.results[0].status,'pending');assert.equal(state.results[0].message,`整份未提交。\n${problems}`);
 assert.ok(!f.calls.some(c=>['query','fill','submit'].includes(c[0])));assert.ok(!JSON.stringify(f.data).includes('private-code'));assert.ok(!JSON.stringify(f.data).includes('私有报告'));assert.ok(!JSON.stringify(f.data).includes('只读诊断结构样本'));
 const lec9=diagnosticPaper([diagnosticChoice(true),{label:'附件题',subject:'attach',body:'<input type="file">'},{label:'附件题',subject:'attach',body:'<input type="file">'}]);
 const lec9Problems=B.questionProblems(lec9.snapshot().questions);
 assert.match(lec9Problems,/第 2 题（附件题）/);assert.match(lec9Problems,/第 3 题（附件题）/);
});
test('diagnostics retain page numbering and distinguish controls, images and parsing failures',()=>{
 const fill={label:'填空题',subject:'gap',stem:'<span class="xy_richtext_blank_number_warp">(1) ____</span><span class="xy_richtext_blank_number_warp">(2) ____</span>',body:'<div class="_label">填空1:</div><div class="_label">填空2:</div><textarea></textarea>'};
 const p=diagnosticPaper([{...fill,number:7},{label:'简答题',subject:'subjective',number:null,body:'<textarea readonly></textarea>'},{...diagnosticChoice(),number:9}]);
 p.document.querySelectorAll('input')[1].value='1';
 // Linkedom does not reflect the readonly attribute into the native property.
 p.document.querySelector('textarea[readonly]').readOnly=true;
 let s=p.snapshot(),text=B.questionProblems(s.questions);
 assert.match(text,/第 7 题（填空题）：应有 2 个空位，但匹配到 1 个输入框/);
 assert.match(text,/第 2 题（页面顺序）（简答题）：输入框被禁用或只读/);assert.match(text,/第 9 题（单选题）：选项标识缺失或重复/);
 p.document.querySelector('textarea[readonly]').value='已有人工答案';assert.ok(!B.questionProblems(p.snapshot().questions).includes('第 2 题'));
 p.document.querySelectorAll('._label')[1].textContent='填空3:';s=p.snapshot();assert.equal(s.complete,false);assert.match(s.reason,/第 7 题/);assert.match(s.reason,/空位数量或编号不一致/);
 const image=diagnosticPaper([{...diagnosticChoice(),stem:'含图片的题干<img src="https://example.test/image.png">'}]);assert.match(B.questionProblems(image.snapshot().questions),/批量自动作答暂未接入识图/);
 const disabled=diagnosticPaper([diagnosticChoice()]);disabled.document.querySelectorAll('input').forEach(e=>{e.disabled=true;});assert.match(B.questionProblems(disabled.snapshot().questions),/选择控件被禁用/);
});

const attachmentItem=()=>({question:{id:'question_999',type:'attachment',stem:'附件题干不要发送',options:[]},state:'unknown',writable:false,fingerprint:'attachment',number:2,typeName:'附件题',reason:'需要上传文件'});
function attachmentBatch(options={}) {
 const f=fixture(options);const original={...f.driver};let active;
 const add=s=>({...s,questions:[...s.questions,attachmentItem()]});
 f.driver.open=async t=>{active=t.id;const s=await original.open(t);return t.id==='t1'?add(s):s;};
 f.driver.inspect=async()=>{const s=await original.inspect();return active==='t1'?add(s):s;};
 return f;
}
test('a batch ending with a draft can immediately start another batch without opening the draft',async()=>{
 const f=attachmentBatch({driver:{draftReference:()=>({tabId:12,pageToken:'attachment-page'})}});
 await f.start([task()]);
 const first=await settled(f.engine);
 assert.equal(first.stage,'finished');
 assert.equal(first.results[0].status,'draft');
 assert.equal(first.inFlight,false);
 await f.start([task(2)]);
 const next=await settled(f.engine);
 assert.deepEqual(next.results.map(result=>result.status),['done']);
 assert.deepEqual(f.calls.filter(call=>call[0]==='submit').map(call=>call[1]),['t2']);
});
test('attachment task fills only other blanks, retains partial manual answers and files, then continues without submitting',async()=>{
 const p=page({manual:'人工首空',total:2});
 const attachment=p.document.createElement('div');attachment.className='question';attachment.innerHTML='<div class="exam_question_stem"><span class="sequence">2.</span><div class="stem_title">附件题干不要发送</div><span class="score">[附件题 50分]</span></div><div id="question_999" class="question_attach_subject"><span>existing.py 上传成功</span><input type="file"></div>';
 p.document.querySelector('#question_content').append(attachment);const originalAttachment=attachment.outerHTML;
 const queries=[];const f=fixture({query:async question=>{queries.push(question);return {solution:question.type==='fill'?{kind:'fill',values:['不替换人工答案','补齐第二空']}:{kind:'text',text:'2'}};}});
 const original={...f.driver};let active;
 f.driver.open=async t=>{active=t.id;return active==='t1'?(await p.command('inspect')).snapshot:original.open(t);};
 f.driver.inspect=async()=>active==='t1'?(await p.command('inspect')).snapshot:original.inspect();
 f.driver.fill=async(t,item)=>active==='t1'?p.command('fill',{item}):original.fill(t,item);
 f.driver.draftReference=()=>({tabId:12,pageToken:'original-attachment-paper'});
 await f.start([task(),task(2)]);const state=await settled(f.engine);
 assert.deepEqual(state.results.map(r=>r.status),['draft','done']);assert.equal(state.inFlight,false);
 assert.deepEqual(state.results[0].draftPage,{tabId:12,pageToken:'original-attachment-paper'});
 assert.match(state.results[0].message,/第 2 题/);assert.match(state.results[0].message,/其余 1 题已答/);assert.match(state.results[0].message,/未提交/);
 assert.deepEqual([...p.document.querySelectorAll('textarea')].map(e=>e.value),['人工首空','补齐第二空']);assert.equal(attachment.outerHTML,originalAttachment);
 assert.ok(queries.every(question=>question.type!=='attachment'));assert.equal(f.calls.filter(c=>c[0]==='submit').length,1);assert.equal(f.calls.find(c=>c[0]==='submit')[1],'t2');
 for(const privateText of ['人工首空','补齐第二空','existing.py','附件题干不要发送'])assert.ok(!JSON.stringify(f.data).includes(privateText));
 const snapshot=(await p.command('inspect')).snapshot;
 assert.match((await p.command('submit',{fingerprint:snapshot.fingerprint})).reason,/含附件题.*不自动提交/);
});
test('all-attachment and already-answered mixed tasks never query, fill or submit',async()=>{
 for(const mixed of [false,true]) {
  const f=fixture();const snapshot={complete:true,fingerprint:'paper',questions:[...(mixed?[{question:q,state:'done',writable:false,number:1}]:[]),{...attachmentItem(),state:'done'}]};
  f.driver.open=async()=>snapshot;f.driver.inspect=async()=>snapshot;
  await f.start();const state=await settled(f.engine);assert.equal(state.results[0].status,'draft');assert.equal(state.stage,'finished');assert.equal(state.inFlight,false);
  assert.ok(!f.calls.some(c=>['query','fill','submit','verify'].includes(c[0])));
  if(!mixed)assert.match(state.results[0].message,/仅含附件题，未填写/);
 }
});
test('stopping or changing account during attachment-draft queries prevents writes and subsequent tasks',async()=>{
 const gate=deferred();let started=false;const f=attachmentBatch({query:async()=>{started=true;await gate.promise;return {solution:{kind:'text',text:'2'}};}});
 await f.start([task(),task(2)]);while(!started)await pause();await f.engine.stop();gate.resolve();const state=await settled(f.engine);
 assert.equal(state.stage,'stopped');assert.equal(f.calls.filter(c=>c[0]==='open').length,1);assert.ok(!f.calls.some(c=>['fill','submit'].includes(c[0])));
 const g=attachmentBatch({query:async()=>{g.setAccount('other');return {solution:{kind:'text',text:'2'}};}});
 await g.start();const changed=await settled(g.engine);assert.equal(changed.stage,'paused');assert.ok(!g.calls.some(c=>['fill','submit'].includes(c[0])));
});
test('changed paper or incomplete non-attachment readback cannot be reported as a prepared draft',async()=>{
 for(const changedPaper of [false,true]) {
  const f=attachmentBatch();const original=f.driver.inspect;
  f.driver.inspect=async()=>{const s=await original();if(changedPaper)s.fingerprint='changed';else s.questions[0].state='empty';return s;};
  await f.start();const state=await settled(f.engine);assert.equal(state.results[0].status,'pending');assert.equal(state.inFlight,false);assert.ok(!f.calls.some(c=>c[0]==='submit'));
  if(changedPaper)assert.ok(!f.calls.some(c=>c[0]==='fill'));
 }
});

// B1-017: real empty-list modal structure, with synthetic questions and IDs.
function noAnswerDialog(p, contents='') {
 const wrap=p.document.createElement('div');wrap.setAttribute('role','dialog');
 wrap.innerHTML=`<div class="ant-modal NoAnswerModal"><div class="ant-modal-title">提交</div><div class="NoAnswerModal_container"><div class="sub_caption">未完成的题目：</div><ul class="no_answer_sheet_list">${contents}</ul><div class="tip">*可在屏幕右侧答题卡内查看各试题的作答状态</div><button>提交</button><button>取消</button></div></div>`;
 p.document.body.append(wrap);return wrap;
}
async function preparedPage(options={}) {
 const p=page(options),s=p.adapter.inspect(B.canonical(task()));
 await p.command('fill',{item:{id:q.id,fingerprint:s.questions[0].fingerprint,solution:{kind:'fill',values:['2','4']}}});
 return {...p,fingerprint:s.fingerprint};
}
test('empty unfinished list confirms once only after synchronized card and stable answers',async()=>{
 const waits=[];const p=await preparedPage({delay:async ms=>waits.push(ms)});
 await p.command('submit',{fingerprint:p.fingerprint});const modal=noAnswerDialog(p);let clicks=0;modal.querySelector('button').addEventListener('click',()=>clicks++);
 waits.length=0;await p.command('confirm');await p.command('confirm');assert.equal(clicks,1);assert.deepEqual(waits,[250]);
});
test('real unfinished numbers, unknown list entries and extra warnings block with specific reasons',async()=>{
 for(const [html,expected] of [['<li><a>2</a></li><li><a>4</a></li>',/第 2、4 题/],['<li><span>未知结构</span></li>',/无法可靠读取题号/]]){
  const p=await preparedPage();await p.command('submit',{fingerprint:p.fingerprint});const modal=noAnswerDialog(p,html);let clicks=0;modal.querySelector('button').addEventListener('click',()=>clicks++);
  const result=await p.command('confirm');assert.equal(result.blocked,true);assert.match(result.reason,expected);assert.equal(clicks,0);
 }
 const p=await preparedPage();await p.command('submit',{fingerprint:p.fingerprint});const modal=noAnswerDialog(p);modal.querySelector('.tip').append('保存失败');assert.equal((await p.command('confirm')).blocked,true);
});
test('submission waits for delayed card synchronization and fails boundedly when card is missing or unfinished',async()=>{
 let action=false,count=0,p; p=await preparedPage({delay:async()=>{if(action && ++count===2){const li=p.document.querySelector('.sheet_list li');li.title='已答题';li.className='finish';}}});
 let clicks=0;p.document.querySelector('button[type=submit]').addEventListener('click',()=>clicks++);p.document.querySelector('.sheet_list li').title='未答题';action=true;
 await p.command('submit',{fingerprint:p.fingerprint});assert.equal(clicks,1);assert.equal(count,3);
 for(const missing of [true,false]){
  let waits=0;const other=await preparedPage({delay:async()=>waits++});waits=0;
  if(missing)other.document.querySelector('.answer_info_card').remove();else other.document.querySelector('.sheet_list li').title='未答题';
  let clicked=0;other.document.querySelector('button[type=submit]').addEventListener('click',()=>clicked++);
  const result=await other.command('submit',{fingerprint:other.fingerprint});assert.equal(result.blocked,true);assert.match(result.reason,missing?/无法读取平台答题卡/:/第 1 题/);assert.equal(clicked,0);assert.equal(waits,11);
 }
});
test('empty modal loading is bounded and a late unfinished number cannot be confirmed',async()=>{
 for(const lateNumber of [true,false]){
  let checking=false,modal,waits=0;const p=await preparedPage({delay:async()=>{if(checking){waits++;if(lateNumber && waits===1){modal.querySelector('.no_answer_sheet_list').innerHTML='<li><a>1</a></li>';modal.querySelector('.ant-spin-spinning').remove();}}}});
  await p.command('submit',{fingerprint:p.fingerprint});modal=noAnswerDialog(p);const spinner=p.document.createElement('div');spinner.className='ant-spin-spinning';modal.querySelector('.NoAnswerModal').append(spinner);
  let clicks=0;modal.querySelector('button').addEventListener('click',()=>clicks++);checking=true;
  const result=await p.command('confirm');assert.equal(result.blocked,true);assert.match(result.reason,lateNumber?/第 1 题/:/仍在加载/);assert.equal(clicks,0);assert.equal(waits,lateNumber?1:11);
 }
});
test('stop or changed answers during stable confirmation never clicks submit',async()=>{
 for(const stop of [true,false]){
  let checking=false,p;p=await preparedPage({delay:async()=>{if(checking){if(stop)await p.command('halt');else p.document.querySelector('textarea').value='';}}});
  await p.command('submit',{fingerprint:p.fingerprint});const modal=noAnswerDialog(p);let clicks=0;modal.querySelector('button').addEventListener('click',()=>clicks++);checking=true;
  await assert.rejects(p.command('confirm'),stop?/停止/:/答案已变化/);assert.equal(clicks,0);
 }
});
test('blocked confirmation reaches batch result immediately and never starts next task or resubmits',async()=>{
 let p,url,clock=0;const actions=[];
 const driver=createDriver({chrome:{tabs:{async create(tab){url=tab.url;p=page();p.location.href=url;p.document.querySelector('button[type=submit]').addEventListener('click',()=>noAnswerDialog(p,'<li><a>1</a></li>'));return {id:1};},async get(){return {id:1,url};},async sendMessage(id,m){actions.push(m.action);return p.adapter.command(m);}}},getBatchId:()=> 'batch',now:()=>clock,delay:async ms=>{clock+=ms;}});
 const f=fixture({driver,query:async()=>({solution:{kind:'fill',values:['2','4']}})});await f.start([task(),task(2)]);const state=await settled(f.engine);
 assert.equal(state.stage,'uncertain');assert.match(state.message,/第 1 题/);assert.match(state.results[0].message,/第 1 题/);assert.equal(state.results[1].status,'waiting');assert.equal(clock,0);assert.equal(actions.filter(a=>a==='submit').length,1);assert.equal(actions.filter(a=>a==='confirm').length,1);
});
test('pre-submit stability failure pauses without claiming a submission is in flight',async()=>{
 const f=fixture({driver:{submit:async()=>({ok:true,blocked:true,reason:'平台答题卡尚未确认已答：第 1 题。'})}});await f.start([task(),task(2)]);const state=await settled(f.engine);
 assert.equal(state.stage,'paused');assert.equal(state.inFlight,false);assert.match(state.message,/第 1 题/);assert.ok(!f.calls.some(c=>c[0]==='verify'));assert.equal(state.results[1].status,'waiting');
});

test('closed execution tab still falls back to fresh platform receipt',async()=>{
 let closed=false,reads=0;const base=B.canonical(task());
 const d=createDriver({chrome:{tabs:{async create(){return {id:1};},async get(){if(closed)throw Error('closed');return {id:1,url:base.url};},async sendMessage(){return {ok:true,snapshot:{pageToken:'p',complete:true}};}}},getBatchId:()=> 'batch',verifySubmitted:async()=>{reads++;return true;}});
 await d.open(base,new AbortController().signal);closed=true;assert.equal(await d.verify(base),true);assert.equal(reads,1);
});
