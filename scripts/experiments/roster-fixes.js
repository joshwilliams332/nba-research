// Nov 2, 2026 experiment behind the model retune (see CLAUDE.md, projection model). Needs site/data built and the
// data branch in store/. Modes: A / A2 (unlisted absences), B (previous-team weight), C (thin teammate evidence),
// D (teammate-out strength), E (current vs new on real lines). Usage: node scripts/experiments/roster-fixes.js B
// Experiments for roster fixes. Usage: node harness.js
const R=require('path').join(__dirname,'..','..')+'/';
const fs=require('fs');
const C=require(R+'site/assets/common.js');
const M=require(R+'site/assets/model.js');
const read=n=>JSON.parse(fs.readFileSync(R+'site/data/'+n+'.json'));
const meta=read('meta');
const L=C.indexLab(meta,read('teams'),read('games'));L.players=read('players');L.logs=read('logs');
const ctx=M.modelContext(L);
const STATS=['pts','reb','ast','fg3m'];
// real lines with market no-vig
const imp=a=>a<0?-a/(-a+100):100/(a+100);
const real=new Map();
for(const f of fs.readdirSync(R+'store/odds/props').filter(f=>/^\d{4}-\d{2}-\d{2}\.json$/.test(f))){
  const snap=JSON.parse(fs.readFileSync(R+'store/odds/props/'+f));
  for(const [gid,props] of Object.entries(snap.games))for(const p of props){
    const q=Object.values(p.books||{}).filter(b=>b[0]===p.l&&b[1]!=null&&b[2]!=null).map(b=>imp(b[1])/(imp(b[1])+imp(b[2])));
    real.set(`${p.id}|${gid}|${p.s}`,{l:p.l,mkt:q.length?q.reduce((a,b)=>a+b)/q.length:null});
  }
}
// Fix A heuristic: rotation teammates (20+ min avg in the team's last 30 games, 5+ appearances) who missed the
// team's last K games before g. Uses only prior games.
let roster=false;
function unlisted(team,g,K=2,W=30,minAvg=20,minApps=5){
  const prior=priorGames(team,g.t);
  const last=prior.slice(-W), lastK=prior.slice(-K);
  if(lastK.length<K)return [];
  const mins={};
  for(const x of last)for(const [pid,m] of Object.entries((ctx.byGame.get(x.g.id)||{})[team]||{}))(mins[pid]=mins[pid]||[]).push(m);
  return Object.entries(mins).filter(([pid,m])=>m.length>=minApps&&C.mean(m)>=minAvg&&(!roster||(L.players[pid]||{}).t===team)&&lastK.every(x=>!(pid in ((ctx.byGame.get(x.g.id)||{})[team]||{})))).map(([pid])=>pid);
}
function priorGames(team,t){const list=ctx.seq[team]||[];let lo=0,hi=list.length;while(lo<hi){const mid=(lo+hi)>>1;if(list[mid].t<t)lo=mid+1;else hi=mid;}return list.slice(0,lo);}

function run(variant){
  const out=[];
  for(const pid of Object.keys(L.logs)){
    const rows=C.playerRows(L,pid);
    for(let i=10;i<rows.length;i++){
      const r=rows[i],g=r.g; if(r.min<10)continue;
      const prior=rows.slice(0,i).filter(x=>x.g.s>=g.s-1); if(prior.length<10)continue;
      const truth=M.missingMates(ctx,r.team,g);
      const heur=unlisted(r.team,g,variant.K||2);
      const absent=variant.absent==='none'?[]:variant.absent==='heur'?heur:variant.absent==='truth'?truth:[...new Set([...truth,...heur])];
      const changed=prior.some(x=>x.team!==r.team);
      const curGames=prior.filter(x=>x.team===r.team).length;
      // small-sample flag: a truth-absent mate whose split has < 5 without-games
      let small=false,anyMate=truth.length>0;
      for(const m of truth){const sp=M.mateSplit(ctx,prior,r.team,m,'pts'); if(!sp||sp.n<5)small=true;}
      for(const s of STATS){
        const pr=M.project(L,pid,s,g,{team:r.team,rows:prior,absent});if(!pr)continue;
        const f=C.STATS[s].f, actual=f(r), line=C.typicalLine(prior,s);
        const rl=real.get(`${pid}|${g.id}|${s}`);
        out.push({s,err:Math.abs(pr.mean-actual),bias:pr.mean-actual,pT:pr.over(line),hitT:actual>line,pushT:actual===line,
          pR:rl&&actual!==rl.l?pr.over(rl.l):null,hitR:rl?actual>rl.l:null,mkt:rl&&rl.mkt,
          heur:heur.length>0,heurNotTruth:heur.some(x=>!truth.includes(x)),changed,curGames,anyMate,small,season:g.s});
      }
    }
  }
  return out;
}
const brier=a=>a.reduce((s,x)=>s+(x.p-(x.h?1:0))**2,0)/a.length;
function report(name,recs,filter=()=>true){
  const a=recs.filter(filter);if(!a.length)return console.log(name,'n=0');
  const mae=s=>{const b=a.filter(x=>x.s===s);return b.length?(b.reduce((t,x)=>t+x.err,0)/b.length).toFixed(3):'-'};
  const bias=s=>{const b=a.filter(x=>x.s===s);return b.length?(b.reduce((t,x)=>t+x.bias,0)/b.length).toFixed(2):'-'};
  const T=a.filter(x=>!x.pushT).map(x=>({p:x.pT,h:x.hitT}));
  const Rl=a.filter(x=>x.pR!=null).map(x=>({p:x.pR,h:x.hitR}));
  const lean=T.filter(x=>x.p>=0.6||x.p<=0.4);const leanHit=lean.filter(x=>(x.p>=0.6)===x.h).length/lean.length;
  console.log(`${name.padEnd(34)} n=${String(a.length).padStart(6)} MAE pts ${mae('pts')} reb ${mae('reb')} ast ${mae('ast')} 3pm ${mae('fg3m')} | bias pts ${bias('pts')} | Brier typ ${brier(T).toFixed(4)} | leans ${(leanHit*100).toFixed(1)}% (${lean.length}) | real ${Rl.length?brier(Rl).toFixed(4)+' ('+Rl.length+')':'-'}`);
}
module.exports={run,report,M,L};
if(require.main===module){
  const mode=process.argv[2]||'A';
  if(mode==='A2'){
    roster=true;
    const cur=x=>x.season===2027;
    const v0=run({absent:'none'}),vt=run({absent:'truth'});
    for(const K of [2,3,5]){
      const v1=run({absent:'heur',K}),vu=run({absent:'union',K});
      console.log('== K',K);
      for(const [n,f] of [['2026-27 all',cur],['2026-27 heuristic flags someone',x=>cur(x)&&x.heur],['2026-27 flags someone not sitting',x=>cur(x)&&x.heurNotTruth]]){
        console.log('--',n);report('  none',v0,f);report('  heuristic',v1,f);report('  actual sitters',vt,f);report('  sitters + heuristic',vu,f);
      }
    }
  }
  if(mode==='A'){
    const v0=run({absent:'none'}),v1=run({absent:'heur'}),vt=run({absent:'truth'});
    for(const [n,f] of [['all',()=>true],['heuristic flags someone',x=>x.heur],['flags someone who did NOT sit (false alarm)',x=>x.heurNotTruth]]){
      console.log('--',n);report('  no absences (no report)',v0,f);report('  heuristic only',v1,f);report('  actual sitters (perfect report)',vt,f);
    }
  }
}
if(require.main===module && process.argv[2]==='B'){
  const res={};
  for(const w of [1,0.6,0.35,0.15]){M.MODEL.otherTeamWeight=w;res[w]=run({absent:'truth'});}
  for(const [n,f] of [['all',()=>true],['changed teams (any)',x=>x.changed],['changed, <10 games with new team',x=>x.changed&&x.curGames<10],['changed, 10-30 games with new team',x=>x.changed&&x.curGames>=10&&x.curGames<30],['changed, 2026-27',x=>x.changed&&x.season===2027]]){
    console.log('--',n);for(const w of Object.keys(res).sort((a,b)=>b-a))report(`  other-team weight ${w}`,res[w],f);
  }
}
if(require.main===module && process.argv[2]==='C'){
  const v=run({absent:'truth'});
  for(const [n,f] of [['no key teammate out',x=>!x.anyMate],['key teammate out, 5+ games of evidence',x=>x.anyMate&&!x.small],['key teammate out, <5 games of evidence',x=>x.anyMate&&x.small]]){
    report(n,v,f);
    // strong leans only (what picks are made of)
    const a=v.filter(f).filter(x=>!x.pushT&&(x.pT>=0.65||x.pT<=0.35));const h=a.filter(x=>(x.pT>=0.65)===x.hitT).length;
    const avgConf=a.reduce((s,x)=>s+Math.max(x.pT,1-x.pT),0)/a.length;
    console.log(`     strong leans (65%+): ${a.length}, hit ${(h/a.length*100).toFixed(1)}% vs model said ${(avgConf*100).toFixed(1)}%`);
    const r=v.filter(f).filter(x=>x.pR!=null&&x.mkt!=null);
    const rs=r.filter(x=>Math.abs(x.pR-x.mkt)>=0.08);const rh=rs.filter(x=>(x.pR>x.mkt)===x.hitR).length;
    console.log(`     real lines where model disagrees with books by 8+ pts: ${rs.length}, model side hit ${rs.length?(rh/rs.length*100).toFixed(1):'-'}%`);
  }
}
if(require.main===module && process.argv[2]==='D'){
  M.MODEL.otherTeamWeight=0.6;
  const res={};
  for(const k of [0.5,0.3,0.15,0]){M.MODEL.mateStrength=k;res[k]=run({absent:'truth'});}
  for(const [n,f] of [['all',()=>true],['2025-26',x=>x.season===2026],['2026-27',x=>x.season===2027],['key teammate out',x=>x.anyMate]]){
    console.log('--',n);for(const k of Object.keys(res).sort((a,b)=>b-a))report(`  teammate-out strength ${k}`,res[k],f);
  }
}
if(require.main===module && process.argv[2]==='E'){
  const cfgs=[['current (1.0 / 0.5)',1,0.5],['new (0.6 / 0.3)',0.6,0.3]];
  for(const [n,w,k] of cfgs){
    M.MODEL.otherTeamWeight=w;M.MODEL.mateStrength=k;
    const v=run({absent:'truth'});report(n,v);
    const r=v.filter(x=>x.pR!=null&&x.mkt!=null);
    for(const t of [0.05,0.08,0.12]){
      const rs=r.filter(x=>Math.abs(x.pR-x.mkt)>=t);const rh=rs.filter(x=>(x.pR>x.mkt)===x.hitR).length;
      const bl=rs.map(x=>{const b=0.3*x.pR+0.7*x.mkt;return (x.pR>x.mkt?b:1-b)});
      console.log(`   real: model vs books gap ${t*100}+ pts: ${rs.length}, model side hit ${(rh/rs.length*100).toFixed(1)}% (blend expected ${(bl.reduce((a,b)=>a+b,0)/bl.length*100).toFixed(1)}%)`);
    }
  }
}
