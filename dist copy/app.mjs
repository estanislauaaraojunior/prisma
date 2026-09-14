import {scanSynthetic} from './deriv.mjs';
import {defaults,validateConfig,calculate,demoData,parseCSV,snapshot} from './math.mjs';
const $=id=>document.getElementById(id),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const format=(v,d=2)=>v==null||!Number.isFinite(v)?'—':v.toLocaleString('pt-BR',{minimumFractionDigits:d,maximumFractionDigits:d});
const date=t=>t==null?'Sem dados':new Date(t*1000).toLocaleString('pt-BR',{timeZone:'UTC',day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
const definitions=[
  {key:'ema',name:'EMA',params:[['ema','Período']]},
  {key:'rsi',name:'RSI',params:[['rsi','Período']]},
  {key:'adx',name:'DMI + ADX',params:[['adx','Período']]},
  {key:'atr',name:'ATR',params:[['atr','Período']]},
  {key:'macd',name:'MACD',params:[['fast','Rápido'],['slow','Lento'],['signal','Sinal']]},
  {key:'boll',name:'Bollinger',params:[['boll','Período'],['deviation','Desvios']]},
  {key:'vwap',name:'VWAP por candles',params:[],note:'Requer volume. Sessão de 00:00 a 24:00 UTC.'},
  {key:'candles',name:'Estrutura dos candles',params:[]}
];
const colors={price:'#16858a',down:'#bf7954',ema:'#087f82',boll:'#8298b6',rsi:'#7158c9',atr:'#b5762f',adx:'#344e75',dip:'#248f90',dim:'#bd7a55',macd:'#3179b5',signal:'#bb8253',vwap:'#b1759c'};
let config={...defaults},visible=Object.fromEntries(definitions.map(d=>[d.key,true])),raw=demoData(),source='Série matemática',assetLabel='',isDemo=true,loadCount=360,cursor=360,displayCount=100,notes=[],history=[],currentRows=[],currentValues;
let isDeriv=false, dataRevision=0, lastContractChartKey='';
function assetIdentity(){return isDemo?'Série matemática · sem moeda real':assetLabel||'Ativo não informado';}
function showMessage(s){$('message').textContent=s;$('message').hidden=!s;}
function renderSettings(){
  $('indicatorSettings').innerHTML=definitions.map(d=>'<div class="indicator-setting"><label class="indicator-toggle" for="show-'+d.key+'"><span>'+d.name+'</span><input type="checkbox" id="show-'+d.key+'" '+(visible[d.key]?'checked':'')+'></label>'+d.params.map(([p,label])=>'<div class="parameter-row"><label for="param-'+p+'">'+label+'</label><input id="param-'+p+'" type="number" value="'+config[p]+'" min="'+(p==='deviation'?.1:2)+'" max="'+(p==='deviation'?5:200)+'" step="'+(p==='deviation'?.1:1)+'"></div>').join('')+(d.note?'<p class="disabled-note">'+d.note+'</p>':'')+'</div>').join('')+'<div class="indicator-setting disabled-option"><span class="indicator-toggle">Session Volume Profile</span><p class="disabled-note">Indisponível: requer distribuição do volume por preço.</p></div>';
  definitions.forEach(d=>$('show-'+d.key).addEventListener('change',e=>{visible[d.key]=e.target.checked;render();}));
}
function legend(items){return items.map(([label,color])=>'<span class="legend-item"><i class="legend-line" style="background:'+color+'"></i>'+esc(label)+'</span>').join('');}
function drawChart(el,rows,series,{candles=false,bars=null,range=null,height=155}={}){
  if(!rows.length){el.innerHTML='<div class="plot-empty"><strong>Sem candles no recorte</strong><span>Carregue uma amostra e configure a quantidade de candles.</span></div>';return;}
  const from=Math.max(0,rows.length-displayCount),r=rows.slice(from),lines=series.map(s=>({...s,values:s.values.slice(from)})),bar=bars?.slice(from);
  const vals=[...lines.flatMap(s=>s.values.filter(Number.isFinite)),...(candles?r.flatMap(x=>[x.low,x.high]):[]),...(bar?bar.filter(Number.isFinite).concat(0):[])];
  if(!vals.length){el.innerHTML='<div class="plot-empty"><strong>Aguardando dados</strong><span>A amostra ainda não alcança o início deste cálculo.</span></div>';return;}
  const w=Math.max(220,el.clientWidth||500),h=height,L=6,R=58,T=12,B=27,pw=w-L-R,ph=h-T-B;
  let min=range?range[0]:Math.min(...vals),max=range?range[1]:Math.max(...vals);if(min===max){const pad=Math.max(Math.abs(min)*.01,.01);min-=pad;max+=pad;}else if(!range){const pad=(max-min)*.08;min-=pad;max+=pad;}
  const x=i=>L+(i+.5)*pw/r.length,y=v=>T+(max-v)/(max-min)*ph;
  let svg='<svg class="plot" role="img" aria-label="'+(candles?'Gráfico de candles históricos':'Gráfico histórico de '+esc(lines.map(s=>s.label).join(', ')))+'" viewBox="0 0 '+w+' '+h+'">';
  for(let i=0;i<5;i++){const v=min+(max-min)*i/4,yy=y(v);svg+='<line class="grid-line" x1="'+L+'" y1="'+yy+'" x2="'+(w-R)+'" y2="'+yy+'"/><text x="'+(w-R+8)+'" y="'+(yy+4)+'">'+format(v,Math.abs(max-min)<.1?3:2)+'</text>';}
  if(bar){const bw=Math.max(1,pw/r.length*.7);bar.forEach((v,i)=>{if(Number.isFinite(v))svg+='<rect x="'+(x(i)-bw/2)+'" y="'+Math.min(y(v),y(0))+'" width="'+bw+'" height="'+Math.max(.5,Math.abs(y(v)-y(0)))+'" fill="'+(v>=0?'#acd9d5':'#e7c6b1')+'"/>';});}
  if(candles){const cw=Math.max(.7,Math.min(9,pw/r.length*.57));r.forEach((q,i)=>{const color=q.close>=q.open?colors.price:colors.down;svg+='<g><title>'+esc(date(q.time))+' UTC | A '+format(q.open,4)+' | M '+format(q.high,4)+' | m '+format(q.low,4)+' | F '+format(q.close,4)+'</title><line x1="'+x(i)+'" y1="'+y(q.high)+'" x2="'+x(i)+'" y2="'+y(q.low)+'" stroke="'+color+'" stroke-width="1"/><rect x="'+(x(i)-cw/2)+'" y="'+Math.min(y(q.open),y(q.close))+'" width="'+cw+'" height="'+Math.max(1,Math.abs(y(q.open)-y(q.close)))+'" fill="'+color+'"/></g>';});}
  lines.forEach(s=>{let path='',started=false;s.values.forEach((v,i)=>{if(!Number.isFinite(v)){started=false;return;}path+=(started?'L':'M')+x(i).toFixed(2)+','+y(v).toFixed(2);started=true;});svg+='<path d="'+path+'" fill="none" stroke="'+s.color+'" stroke-width="'+(s.width||1.7)+'" stroke-linejoin="round" stroke-linecap="round"/>';});
  const indices=[0,Math.floor((r.length-1)/2),r.length-1];[...new Set(indices)].forEach((i,j,a)=>{const xx=j===0?L:j===a.length-1?w-R:x(i),anchor=j===0?'start':j===a.length-1?'end':'middle';svg+='<text x="'+xx+'" y="'+(h-5)+'" text-anchor="'+anchor+'">'+new Date(r[i].time*1000).toLocaleTimeString('pt-BR',{timeZone:'UTC',hour:'2-digit',minute:'2-digit'})+'</text>';});
  el.innerHTML=svg+'</svg>';
}
function render(){
  const loaded=loadCount===0?[]:raw.slice(-loadCount);cursor=Math.max(1,Math.min(cursor,loaded.length||1));currentRows=loaded.slice(0,cursor);currentValues=calculate(currentRows,config);const m=currentValues,i=currentRows.length-1,last=currentRows[i],at=k=>m[k]?.[i]??null;
  $('sourceName').textContent=source;$('sourceDetail').textContent=isDemo?'Exemplo didático • sem ativo real':raw.length+' candles históricos • '+(isDeriv?'Deriv API':'CSV local');$('dataBadge').textContent=isDemo?'Exemplo didático':isDeriv?'Deriv · consulta':'Arquivo histórico';
  $('assetName').textContent=assetIdentity();$('assetOrigin').textContent=isDemo?'Exemplo didático gerado no painel':isDeriv?'Identificação fornecida pela Deriv':assetLabel?'Identificação informada por você · CSV histórico':'Informe o ativo em Dados e parâmetros';$('assetInput').disabled=isDemo||isDeriv;$('assetHelp').textContent=isDemo?'O exemplo não corresponde a uma moeda real.':isDeriv?'Símbolo identificado pela API da Deriv.':'Identificação manual; não verificada pela fonte.';$('chartTitle').textContent=isDemo?'Candles da série matemática':assetLabel?'Candles · '+assetLabel:'Candles do arquivo importado';
  $('cursor').max=String(loaded.length||1);$('cursor').value=String(cursor);$('cursor').disabled=!loaded.length;$('cursorValue').textContent=loaded.length?cursor+' de '+loaded.length:'0 de 0';$('cursorDate').textContent=date(last?.time)+(last?' UTC':'');$('latestButton').disabled=!loaded.length;$('saveReading').disabled=!last;
  const metricList=[['Fechamento observado',format(last?.close,3),'Unidades da série'],['Candles no cálculo',currentRows.length.toLocaleString('pt-BR'),'De '+raw.length+' registros carregados'],['ATR · '+config.atr,visible.atr?format(at('atr'),3):'—',visible.atr?'Amplitude média · não direcional':'Indicador desativado'],['RSI · '+config.rsi,visible.rsi?format(at('rsi'),1):'—',visible.rsi?'Escala de 0 a 100 · não é %':'Indicador desativado']];
  $('metrics').innerHTML=metricList.map(([label,v,note])=>'<article class="metric"><span class="metric-label">'+label+'</span><strong class="metric-value">'+v+'</strong><span class="metric-foot">'+note+'</span></article>').join('');
  const mainSeries=[],mainLegend=[['Candles',colors.price]];
  if(visible.ema){mainSeries.push({values:m.ema,color:colors.ema,label:'EMA'});mainLegend.push(['EMA '+config.ema,colors.ema]);}
  if(visible.boll){for(const key of ['middle','upper','lower'])mainSeries.push({values:m[key],color:colors.boll,label:'Bollinger',width:1});mainLegend.push(['Bollinger '+config.boll+' · '+config.deviation+'σ',colors.boll]);}
  if(visible.vwap&&m.hasVolume){mainSeries.push({values:m.vwap,color:colors.vwap,label:'VWAP'});mainLegend.push(['VWAP · UTC',colors.vwap]);}
  $('priceLegend').innerHTML=legend(mainLegend);drawChart($('priceChart'),currentRows,mainSeries,{candles:true,height:$('priceChart').clientHeight||290});
  const required={ema:config.ema,rsi:config.rsi+1,atr:config.atr+1,adx:2*config.adx,macd:config.slow+config.signal-1,boll:config.boll};
  const selected=Object.keys(required).filter(k=>visible[k]),ready=selected.filter(k=>currentRows.length>=required[k]);
  $('readingTitle').textContent=!last?'Aguardando uma amostra':ready.length+' de '+selected.length+' cálculos com dados suficientes';
  const text=!last?'Informe uma quantidade de candles maior que zero ou importe um arquivo.':('O recorte termina em '+date(last.time)+' UTC. '+(currentRows.length>1?'Amplitude entre a mínima e a máxima do recorte: '+format(Math.max(...currentRows.map(r=>r.high))-Math.min(...currentRows.map(r=>r.low)),3)+' unidades. ':'')+(visible.vwap&&!m.hasVolume?'VWAP indisponível: a amostra não contém volume.':''));
  $('readingText').textContent=text;
  const cards=[];
  if(visible.rsi)cards.push({key:'rsi',title:'RSI',value:at('rsi'),desc:'Relação entre variações dos fechamentos. Escala, não percentual.',series:[{values:m.rsi,color:colors.rsi,label:'RSI'}],range:[0,100],required:required.rsi});
  if(visible.adx)cards.push({key:'adx',title:'DMI + ADX',value:at('adx'),desc:'ADX: força direcional. +DI e −DI: componentes separados.',series:[{values:m.adx,color:colors.adx,label:'ADX'},{values:m.dip,color:colors.dip,label:'+DI'},{values:m.dim,color:colors.dim,label:'−DI'}],range:[0,100],required:required.adx});
  if(visible.macd)cards.push({key:'macd',title:'MACD',value:at('macd'),desc:'Diferença entre EMAs. Barras: MACD menos a linha de sinal.',series:[{values:m.macd,color:colors.macd,label:'MACD'},{values:m.signal,color:colors.signal,label:'Sinal'}],bars:m.histogram,required:required.macd});
  if(visible.atr)cards.push({key:'atr',title:'ATR',value:at('atr'),desc:'Amplitude média verdadeira nas unidades da série.',series:[{values:m.atr,color:colors.atr,label:'ATR'}],required:required.atr});
  $('indicatorCharts').innerHTML=cards.map(c=>'<article class="panel mini-panel"><div class="section-head"><h2 class="mini-title">'+c.title+'</h2><span class="mini-value">'+format(c.value,c.key==='atr'||c.key==='macd'?3:1)+'</span></div><p class="mini-desc">'+c.desc+'</p><div class="mini-chart" id="plot-'+c.key+'"></div><div class="legend">'+legend(c.series.map(s=>[s.label,s.color]))+'</div><p class="disabled-note">'+(currentRows.length<c.required?'Primeiro conjunto completo com '+c.required+' candles.':'Cálculo no candle selecionado · UTC')+'</p></article>').join('');
  cards.forEach(c=>drawChart($('plot-'+c.key),currentRows,c.series,{bars:c.bars,range:c.range}));
  document.querySelector('.anatomy-panel').hidden=!visible.candles;
  if(last){const range=last.high-last.low;const a=[['Sombra superior',last.high-Math.max(last.open,last.close)],['Corpo',Math.abs(last.close-last.open)],['Sombra inferior',Math.min(last.open,last.close)-last.low]];$('anatomy').innerHTML='<div class="anatomy-grid">'+a.map(([label,v])=>'<div class="anatomy-item"><span>'+label+'</span><strong>'+(range===0?'0,0':format(v/range*100,1))+'%</strong><span>'+format(v,3)+' unidades</span></div>').join('')+'</div>'+(range===0?'<p class="disabled-note">Candle sem amplitude: proporções definidas como zero.</p>':'');}else $('anatomy').innerHTML='<p class="no-data">Sem candle disponível.</p>';
  const partial=loadCount>raw.length?'Foram solicitados '+loadCount+' candles; o arquivo contém '+raw.length+'.':'';showMessage([...notes,partial].filter(Boolean).join(' '));
}
function applyConfig(next){config=validateConfig(next);$('configError').textContent='';renderSettings();render();return {...config};}
function loadDerivChart({rows,symbol,name,granularity=60,boundary,type,contract,reason='contrato aberto'}){
  if (!Array.isArray(rows) || !rows.length || typeof symbol !== 'string') return false;
  const key = [reason,symbol,contract?.contractId || '',boundary || rows.at(-1)?.time || '',type || ''].join(':');
  if (reason === 'contrato aberto' && key === lastContractChartKey) return false;
  if (reason === 'contrato aberto') lastContractChartKey = key;
  dataRevision++;
  raw = rows;
  isDemo = false;
  isDeriv = true;
  const label = `${name || symbol} (${symbol})`;
  source = `Deriv · ${reason} · ${symbol} · ${granularity / 60} min`;
  assetLabel = label;
  $('assetInput').value = label;
  loadCount = cursor = raw.length;
  $('loadCount').value = String(loadCount);
  const direction = type === 'CALL' ? 'Alta' : type === 'PUT' ? 'Baixa' : 'direção não informada';
  const id = contract?.contractId ? ` ID ${contract.contractId}.` : '';
  notes = reason === 'contrato aberto'
    ? [`Contrato aberto na Deriv: ${label} · ${direction}.${id}`, 'Os gráficos acompanham o símbolo do contrato aberto e serão atualizados a cada nova compra da automação.']
    : [];
  render();
  return true;
}
function registerReading(){if(!currentRows.length)throw new Error('Carregue candles antes de registrar uma leitura.');const entry={...snapshot(currentRows,config),source,asset:assetIdentity(),registered:new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit',second:'2-digit'}),visible:{...visible}};history.unshift(entry);if(history.length>30)history.pop();
  $('historyBody').innerHTML=history.map(h=>'<tr><td>'+h.registered+'</td><td>'+esc(h.asset)+'</td><td>'+esc(h.source)+'<br><span class="muted-label">'+date(h.lastTime)+' UTC</span></td><td>'+h.candles+'</td><td>'+format(h.ema,3)+'</td><td>'+format(h.rsi,1)+'</td><td>'+format(h.atr,3)+'</td><td><details><summary>Ver configuração</summary>'+Object.entries(h.parameters).map(([k,v])=>esc(k)+': '+v).join('<br>')+'<br>Visíveis: '+esc(Object.keys(h.visible).filter(k=>h.visible[k]).join(', '))+'</details></td></tr>').join('');return entry;
}
$('configForm').addEventListener('submit',e=>{e.preventDefault();try{applyConfig(Object.fromEntries(Object.keys(defaults).map(k=>[k,Number($('param-'+k).value)])));}catch(err){$('configError').textContent=err.message;}});
$('resetConfig').addEventListener('click',()=>applyConfig(defaults));
$('loadCount').addEventListener('change',()=>{const n=Number($('loadCount').value);if(!Number.isInteger(n)||n<0||n>10000){showMessage('Informe de 0 a 10.000 candles.');$('loadCount').value=String(loadCount);return;}loadCount=n;cursor=Math.min(n,raw.length)||1;render();});
$('displayCount').addEventListener('change',e=>{displayCount=Number(e.target.value);render();});
$('cursor').addEventListener('input',e=>{cursor=Number(e.target.value);render();});
$('latestButton').addEventListener('click',()=>{cursor=Math.min(loadCount,raw.length)||1;render();});
$('demoButton').addEventListener('click',()=>{dataRevision++;isDeriv=false;raw=demoData();source='Série matemática';assetLabel='';$('assetInput').value='';isDemo=true;notes=[];loadCount=raw.length;cursor=raw.length;$('loadCount').value=String(loadCount);render();});
$('importButton').addEventListener('click',()=>$('csvFile').click());
$('csvFile').addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;const revision=++dataRevision;try{if(file.size>3*1024*1024)throw new Error('O arquivo deve ter até 3 MB.');const parsed=parseCSV(await file.text());if(revision!==dataRevision)return;isDeriv=false;raw=parsed.rows;notes=parsed.notes;source=file.name;assetLabel='';$('assetInput').value='';isDemo=false;loadCount=raw.length;cursor=raw.length;$('loadCount').value=String(loadCount);render();}catch(err){showMessage(err.message);}finally{e.target.value='';}});
$('assetInput').addEventListener('change',e=>{if(isDemo||isDeriv)return;assetLabel=e.target.value.trim().slice(0,60);e.target.value=assetLabel;render();});
$('saveReading').addEventListener('click',()=>registerReading());
$('methodButton').addEventListener('click',()=>$('methodDialog').showModal());$('closeMethod').addEventListener('click',()=>$('methodDialog').close());$('methodDialog').addEventListener('click',e=>{if(e.target===$('methodDialog')){const rect=$('methodDialog').getBoundingClientRect();if(e.clientX<rect.left||e.clientX>rect.right||e.clientY<rect.top||e.clientY>rect.bottom)$('methodDialog').close();}});
let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(render,120);});
window.addEventListener('prisma:open-contract-chart',event=>loadDerivChart(event.detail || {}));
renderSettings();render();
// Optional page tools expose only the same descriptive data and controls as the UI.
if(document.modelContext?.registerTool){
  const lifecycle=new AbortController();
  const register=tool=>{try{Promise.resolve(document.modelContext.registerTool(tool,{signal:lifecycle.signal})).catch(()=>{});}catch{}};
  register({name:'read_indicator_sample',title:'Ler a amostra atual',description:'Retorna os valores descritivos e parâmetros exibidos. Não produz previsões ou operações.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true,untrustedContentHint:true},execute(input){if(input==null||typeof input!=='object'||Array.isArray(input)||Object.keys(input).length)throw new Error('Informe um objeto vazio.');return {source,asset:assetIdentity(),assetOrigin:isDemo?'mathematical_example':isDeriv?'deriv_api':'user_declared',...snapshot(currentRows,config),visible:{...visible},dataType:isDemo?'mathematical_example':isDeriv?'deriv_history':'historical_csv'};}});
  register({name:'configure_indicator_periods',title:'Configurar períodos dos indicadores',description:'Atualiza os mesmos períodos disponíveis no formulário e recalcula a amostra atual.',inputSchema:{type:'object',properties:Object.fromEntries(Object.keys(defaults).map(k=>[k,{type:k==='deviation'?'number':'integer',minimum:k==='deviation'?.1:2,maximum:k==='deviation'?5:200}])),additionalProperties:false},annotations:{readOnlyHint:false,untrustedContentHint:false},execute(input){if(input==null||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!(k in defaults)))throw new Error('Parâmetros desconhecidos.');const params=applyConfig({...config,...input});return {parameters:params,candles:currentRows.length};}});
  window.addEventListener('pagehide',()=>lifecycle.abort(),{once:true});
}

$('derivButton').addEventListener('click', async () => {
  const revision = ++dataRevision;
  const granularity = Number($('derivInterval').value);
  $('derivButton').disabled = true;
  $('derivInterval').disabled = true;
  $('derivResults').hidden = true;
  $('derivStatus').textContent = 'Conectando à Deriv…';
  try {
    const result = await scanSynthetic({granularity, onProgress: p => {
      $('derivStatus').textContent = `${p.marketLabel}: consultando ${p.done + 1} de ${p.total}: ${p.name}…`;
    }});
    const winner = result.ranking[0];
    const summary = `${result.marketLabel} · ${result.ranking.length} ativos comparados de ${result.total} consultados · ${granularity / 60} min · 500 candles · ADX (14) · corte ${date(result.boundary)} UTC.`;
    $('derivResults').innerHTML = '<table><thead><tr><th>Posição</th><th>Ativo</th><th>Família</th><th>ADX (14)</th><th>Direção</th></tr></thead><tbody>' + result.ranking.map((item, i) => '<tr><td>'+(i+1)+'</td><td>'+esc(item.name)+' ('+esc(item.symbol)+')</td><td>'+esc(item.family)+'</td><td>'+format(item.adx,2)+'</td><td>'+item.direction+'</td></tr>').join('') + '</tbody></table>' + (result.failures.length ? '<details><summary>Ativos não comparados ('+result.failures.length+')</summary><ul>'+result.failures.map(f=>'<li>'+esc(f.symbol)+': '+esc(f.message)+'</li>').join('')+'</ul></details>' : '');
    $('derivResults').hidden = false;
    if (revision !== dataRevision) {
      $('derivStatus').textContent = summary + ' O gráfico foi mantido porque você trocou a amostra durante a busca.';
      return;
    }
    loadDerivChart({rows:winner.rows,symbol:winner.symbol,name:winner.name,granularity,reason:'consulta'});
    notes = ['Consulta Deriv: ' + summary, 'Maior ADX entre os ativos comparados: '+winner.name+'. Direção: '+winner.direction+'. O ranking usa parâmetros fixos, independentes do painel.'];
    render();
    $('derivStatus').textContent = summary + ' Maior força: '+winner.name+' · ADX '+format(winner.adx)+' · '+winner.direction+'. Gráfico carregado.';
  } catch (error) {
    $('derivStatus').textContent = error.message + ' A amostra anterior foi preservada.';
  } finally {
    $('derivButton').disabled = false;
    $('derivInterval').disabled = false;
  }
});
