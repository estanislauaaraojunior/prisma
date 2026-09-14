export const defaults = {ema:20,rsi:14,atr:14,adx:14,fast:12,slow:26,signal:9,boll:20,deviation:2};
export function validateConfig(c){
  for(const key of Object.keys(defaults)) if(!Number.isFinite(c[key]) || c[key]<(key==='deviation'?0.1:2) || c[key]>(key==='deviation'?5:200) || (key!=='deviation'&&!Number.isInteger(c[key]))) throw new Error('Use períodos inteiros entre 2 e 200 e desvio entre 0,1 e 5.');
  if(c.fast>=c.slow) throw new Error('O período rápido do MACD deve ser menor que o lento.');
  return {...c};
}
export function averageSeries(values,n,alpha=2/(n+1)){
  const out=Array(values.length).fill(null);let seed=[],v=null;
  values.forEach((x,i)=>{if(x==null||!Number.isFinite(x)){seed=[];v=null;return;}if(v===null){seed.push(x);if(seed.length===n){v=seed.reduce((a,b)=>a+b,0)/n;out[i]=v;}}else{v=alpha*x+(1-alpha)*v;out[i]=v;}});return out;
}
export function calculate(rows,config=defaults){
  const c=validateConfig(config),close=rows.map(r=>r.close),len=rows.length;
  const ema=averageSeries(close,c.ema),fast=averageSeries(close,c.fast),slow=averageSeries(close,c.slow);
  const macd=fast.map((v,i)=>v===null||slow[i]===null?null:v-slow[i]),signal=averageSeries(macd,c.signal);
  const histogram=macd.map((v,i)=>v===null||signal[i]===null?null:v-signal[i]);
  const gains=close.map((v,i)=>i?Math.max(v-close[i-1],0):null),losses=close.map((v,i)=>i?Math.max(close[i-1]-v,0):null);
  const ag=averageSeries(gains,c.rsi,1/c.rsi),al=averageSeries(losses,c.rsi,1/c.rsi);
  const rsi=ag.map((v,i)=>v===null?null:v===0&&al[i]===0?50:al[i]===0?100:100-100/(1+v/al[i]));
  const tr=rows.map((r,i)=>i?Math.max(r.high-r.low,Math.abs(r.high-rows[i-1].close),Math.abs(r.low-rows[i-1].close)):null);
  const atr=averageSeries(tr,c.atr,1/c.atr),trD=averageSeries(tr,c.adx,1/c.adx);
  const plus=rows.map((r,i)=>{if(!i)return null;const u=r.high-rows[i-1].high,d=rows[i-1].low-r.low;return u>d&&u>0?u:0;});
  const minus=rows.map((r,i)=>{if(!i)return null;const u=r.high-rows[i-1].high,d=rows[i-1].low-r.low;return d>u&&d>0?d:0;});
  const sp=averageSeries(plus,c.adx,1/c.adx),sm=averageSeries(minus,c.adx,1/c.adx);
  const dip=sp.map((v,i)=>v===null?null:trD[i]===0?0:100*v/trD[i]),dim=sm.map((v,i)=>v===null?null:trD[i]===0?0:100*v/trD[i]);
  const dx=dip.map((v,i)=>v===null?null:v+dim[i]===0?0:100*Math.abs(v-dim[i])/(v+dim[i])),adx=averageSeries(dx,c.adx,1/c.adx);
  const middle=Array(len).fill(null),upper=Array(len).fill(null),lower=Array(len).fill(null);
  for(let i=c.boll-1;i<len;i++){const a=close.slice(i-c.boll+1,i+1),m=a.reduce((s,v)=>s+v,0)/c.boll,sd=Math.sqrt(a.reduce((s,v)=>s+(v-m)**2,0)/c.boll);middle[i]=m;upper[i]=m+c.deviation*sd;lower[i]=m-c.deviation*sd;}
  const hasVolume=len>0&&rows.every(r=>Number.isFinite(r.volume)&&r.volume>=0);let day='',weighted=0,volume=0;
  const vwap=rows.map(r=>{if(!hasVolume)return null;const d=new Date(r.time*1000).toISOString().slice(0,10);if(d!==day){day=d;weighted=0;volume=0;}weighted+=(r.high+r.low+r.close)/3*r.volume;volume+=r.volume;return volume>0?weighted/volume:null;});
  return {ema,rsi,atr,macd,signal,histogram,dip,dim,adx,middle,upper,lower,vwap,hasVolume};
}
export function demoData(){
  return Array.from({length:360},(_,i)=>{const f=t=>100+0.018*t+2.4*Math.sin(t/19)+0.7*Math.cos(t/4.7);const open=f(i),close=f(i+1);return {time:Date.UTC(2026,0,5,9,0)/1000+i*60,open,close,high:Math.max(open,close)+0.25+0.16*(1+Math.sin(i*1.3)),low:Math.min(open,close)-0.25-0.15*(1+Math.cos(i*0.9)),volume:null};});
}
function splitCSV(text,sep){let rows=[],row=[],s='',q=false;for(let i=0;i<text.length;i++){const ch=text[i];if(ch==='"'){if(q&&text[i+1]==='"'){s+='"';i++;}else q=!q;}else if(ch===sep&&!q){row.push(s.trim());s='';}else if((ch==='\n'||ch==='\r')&&!q){if(ch==='\r'&&text[i+1]==='\n')i++;row.push(s.trim());if(row.some(Boolean))rows.push(row);row=[];s='';}else s+=ch;}if(q)throw new Error('Há aspas não encerradas no CSV.');row.push(s.trim());if(row.some(Boolean))rows.push(row);return rows;}
export function parseCSV(text){
  if(text.length>3*1024*1024)throw new Error('O arquivo deve ter até 3 MB.');
  text=text.replace(/^\uFEFF/,'');const first=text.split(/\r?\n/)[0],sep=first.includes(';')?';':',';
  const raw=splitCSV(text,sep),header=(raw.shift()||[]).map(s=>s.toLowerCase());
  const aliases={time:['timestamp','time','epoch','date','data'],open:['open','abertura'],high:['high','maxima','máxima'],low:['low','minima','mínima'],close:['close','fechamento'],volume:['volume']};
  const col=Object.fromEntries(Object.entries(aliases).map(([k,v])=>[k,header.findIndex(h=>v.includes(h))]));
  if(['time','open','high','low','close'].some(k=>col[k]<0))throw new Error('Colunas obrigatórias: timestamp, open, high, low, close. Volume é opcional.');
  if(!raw.length||raw.length>10000)throw new Error('O CSV deve conter de 1 a 10.000 candles.');
  const seen=new Set();let hadOrder=false,previous=-Infinity;
  const rows=raw.map((a,i)=>{
    const ts=a[col.time]||'';let t;
    if(/^\d+(\.\d+)?$/.test(ts)){t=Number(ts);if(t>1e11)t/=1000;}else{if(!/(Z|[+-]\d{2}:?\d{2})$/i.test(ts))throw new Error('Linha '+(i+2)+': informe horário ISO com fuso (Z) ou timestamp Unix.');t=Date.parse(ts)/1000;}
    if(!Number.isFinite(t)||t<0||t>253402300799)throw new Error('Linha '+(i+2)+': horário inválido.');
    if(seen.has(t))throw new Error('Linha '+(i+2)+': horário duplicado. Corrija o arquivo.');seen.add(t);if(t<previous)hadOrder=true;previous=t;
    const number=k=>{const v=a[col[k]];return v==null||v===''?NaN:Number(sep===';'?v.replace(',','.'):v);};
    const r={time:t,open:number('open'),high:number('high'),low:number('low'),close:number('close'),volume:col.volume>=0?number('volume'):null};
    if(![r.open,r.high,r.low,r.close].every(v=>Number.isFinite(v)&&v>0)||r.low>Math.min(r.open,r.close)||r.high<Math.max(r.open,r.close)||r.high<r.low)throw new Error('Linha '+(i+2)+': valores OHLC inconsistentes.');
    if(col.volume>=0&&(!Number.isFinite(r.volume)||r.volume<0))throw new Error('Linha '+(i+2)+': volume inválido.');return r;
  }).sort((a,b)=>a.time-b.time);
  const diffs=rows.slice(1).map((r,i)=>r.time-rows[i].time);const interval=diffs.length?Math.min(...diffs):null;
  const irregular=diffs.filter(d=>d!==interval).length;
  return {rows,notes:[hadOrder?'Registros ordenados pelo horário.':'',irregular?irregular+' intervalos irregulares; lacunas não foram preenchidas.':''].filter(Boolean)};
}
export function snapshot(rows,c){const m=calculate(rows,c),i=rows.length-1;return {candles:rows.length,lastTime:rows[i]?.time??null,close:rows[i]?.close??null,ema:m.ema[i]??null,rsi:m.rsi[i]??null,atr:m.atr[i]??null,adx:m.adx[i]??null,parameters:{...c}};}
