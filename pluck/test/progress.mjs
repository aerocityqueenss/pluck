const BASE='http://127.0.0.1:7777';
const PAGE='https://bitmovin.com/demos/stream-test';
const delay=(ms)=>new Promise(r=>setTimeout(r,ms));
const created=await (await fetch(BASE+'/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:PAGE})})).json();
const id=created.session.id;
const ws=new WebSocket(BASE.replace('http','ws')+'/ws?session='+id);
await new Promise((r,j)=>{ws.addEventListener('open',r);ws.addEventListener('error',j);});
const videos=new Map();
ws.addEventListener('message',(ev)=>{ if(typeof ev.data!=='string')return; const m=JSON.parse(ev.data); if(m.type==='video'||m.type==='videoUpdate')videos.set(m.video.id,m.video); });
await delay(12000);
const master=[...videos.values()].find(v=>v.variants&&v.variants.length);
const res=await fetch(BASE+'/api/session/'+id+'/job',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({videoId:master.id,options:{variantUrl:master.variants[0].url,sendHeaders:true}})});
const data=await res.json();
for(let i=0;i<8;i++){ await delay(1500); const s=await (await fetch(BASE+'/api/job/'+data.job.id)).json(); console.log(i, s.job.status, s.job.bytes, s.job.percent, JSON.stringify(s.job.units), s.job.filename); }
await fetch(BASE+'/api/job/'+data.job.id+'/cancel',{method:'POST'});
ws.close(); await fetch(BASE+'/api/session/'+id,{method:'DELETE'});
process.exit(0);
