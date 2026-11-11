// Browser-only integration fixture. No real platform or provider requests.
const mockChanges = [], mockData = {}, mockTasks = [1,2,3].map(n=>({id:`t${n}`,courseId:'11',nodeId:String(n),typeCode:n===2?3:2,type:n===2?'练习':'作业',name:['','文字题自动提交','附件题待处理','未选任务保持原样'][n],courseName:'模拟课程',finished:false,start:Date.now()-1000,end:Date.now()+86400000,finishedAt:null,url:`https://whut.ai-augmented.com/app/jx-web/mycourse/11/resource/_/${n}`}));
let mockEngine, mockAdapter, mockCurrent, mockCalls=0, mockSubmits=0, mockOpened=[];
function mockStats(){document.getElementById('mockStats').textContent=`模拟 API 请求 ${mockCalls} 次 · 已提交 ${mockSubmits} 份 · 未选任务操作 ${mockOpened.filter(id=>id==='t3').length} 次`;}
const mockStorage={async get(){return structuredClone(mockData);},async set(values){for(const [key,value] of Object.entries(values)){const oldValue=mockData[key];mockData[key]=structuredClone(value);mockChanges.forEach(fn=>fn({[key]:{oldValue,newValue:structuredClone(value)}},'local'));}}};
window.chrome={storage:{local:mockStorage,onChanged:{addListener(fn){mockChanges.push(fn);}},session:{async get(){return {};}}},runtime:{id:'fixture',onMessage:{addListener(){}},async sendMessage(m){
 if(m.type==='auto:start')return mockEngine.start({account:m.account,tasks:mockTasks.filter(t=>m.ids.includes(t.id))});
 if(m.type==='auto:get')return {ok:true,batch:await mockEngine.get()};
 if(m.type==='auto:stop')return mockEngine.stop();
 if(m.type==='auto:verify')return mockEngine.verify();
 return {ok:true};
}},tabs:{onUpdated:{addListener(){}},async query(){return [];}}};
const mockStore={async peek(){return null;},async load(){return {status:'ok',tasks:mockTasks,account:'mock',failures:[],fetchedAt:Date.now()};},async getPins(){return [];},async setPins(){}};
window.XiaoyaTaskData={...window.XiaoyaTaskData,createTaskStore:()=>mockStore};
function mockInit(){
 const command=(action,extra={})=>mockAdapter.command({action,task:mockCurrent,batchId:mockEngine.getId(),pageToken:'fixture-page',...extra});
 const driver={async open(task){
  mockCurrent=task;mockOpened.push(task.id);mockStats();const old=document.getElementById('mockPaper');const frame=document.createElement('iframe');frame.id='mockPaper';frame.title='模拟作业';old.replaceWith(frame);
  const html=await (await fetch('batch-paper.html')).text();
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('模拟页加载超时')),10000);frame.onload=()=>{clearTimeout(timer);resolve();};frame.srcdoc=html.replace("new URLSearchParams(location.search).get('task')", JSON.stringify(task.nodeId));});
  mockAdapter=XiaoyaAnswerPage.createAdapter({document:frame.contentDocument,location:new URL(task.url),uuid:()=> 'fixture-page',permit:m=>mockEngine.permit(m)});
  return (await command('inspect')).snapshot;
 },async inspect(){return (await command('inspect')).snapshot;},async fill(task,item){return command('fill',{item});},async submit(task,fingerprint){return command('submit',{fingerprint});},async verify(){
  for(let i=0;i<10;i++){if((await command('inspect')).snapshot.submitted){mockSubmits++;mockTasks.find(t=>t.id===mockCurrent.id).finished=true;mockStats();return true;}await command('confirm');await new Promise(r=>setTimeout(r,100));}return false;
 },halt(){command('halt');},async recheck(){return (await command('inspect')).snapshot.submitted;}};
 mockEngine=XiaoyaAnswerBatch.createEngine({storage:mockStorage,driver,getAccount:async()=> 'mock',query:async q=>{
  mockCalls++;mockStats();await new Promise(r=>setTimeout(r,300));return XiaoyaQuestion.answer(JSON.stringify({answer:q.type==='fill'?['2','4']:q.type==='multiple'?['A','C']:['A'],explanation:'本地固定样题模拟答案'}),q);
 }});
 mockStats();
}
