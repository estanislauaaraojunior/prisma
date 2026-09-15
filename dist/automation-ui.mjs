import {AccountConnection} from './deriv-account.mjs';
import {DemoAutomation, automationDefaults, validateAutomation} from './automation.mjs';
import {publishSessionEvent, readSessionState} from './session-state.mjs';
const $ = id => document.getElementById(id);
let client = null, engine = null, connected = false, busy = false, connecting = false, runRequested = false;
let lastRemoteEvent = '';
const LOCK_TTL = 45_000;
function readSessionLock(key) {
  try { return JSON.parse(localStorage.getItem(key) || 'null'); }
  catch { return null; }
}
async function withSessionLock(name, callback) {
  if (navigator.locks?.request) {
    return navigator.locks.request(name, {ifAvailable:true}, async lock => {
      if (!lock) throw new Error('Já existe uma sessão ativa desta conta em outra aba.');
      return callback();
    });
  }
  const key = `prisma-session-lock:${name}`;
  const owner = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  const current = readSessionLock(key);
  if (current?.expiresAt > now) throw new Error('Já existe uma sessão ativa desta conta neste navegador.');
  localStorage.setItem(key, JSON.stringify({owner, expiresAt:now + LOCK_TTL}));
  if (readSessionLock(key)?.owner !== owner) throw new Error('Já existe uma sessão ativa desta conta neste navegador.');
  let heartbeat;
  try {
    heartbeat = setInterval(() => localStorage.setItem(key, JSON.stringify({owner, expiresAt:Date.now() + LOCK_TTL})), LOCK_TTL / 3);
    return await callback();
  } finally {
    clearInterval(heartbeat);
    if (readSessionLock(key)?.owner === owner) localStorage.removeItem(key);
  }
}
function controls() {
  $('accountFields').disabled = connecting || connected || busy;
  $('automationSettings').disabled = busy;
  $('startAutomation').disabled = !connected || busy;
  $('stopAutomation').disabled = !busy;
  $('disconnectAccount').disabled = !connected || busy;
  $('clearPending').disabled = !connected || busy;
}
function event(item) {
  $('automationStatus').textContent = item.message;
  $('automationTotals').textContent = `Operações: ${item.trades} · Resultado da sessão: ${item.profit.toFixed(2)} ${engine?.currency || ''}`;
  publishSessionEvent(item, {accountId:engine?.accountId, currency:engine?.currency, running:busy || runRequested}).catch(()=>{});
  if (item.opened && item.chart) {
    window.dispatchEvent(new CustomEvent('prisma:open-contract-chart', {detail:{...item.chart, contract:item.opened}}));
  }
  const li = document.createElement('li');
  li.textContent = `${new Date().toLocaleTimeString('pt-BR')} · ${item.message}`;
  if (item.analysis) {
    const details = document.createElement('details'), summary = document.createElement('summary'), values = document.createElement('pre');
    summary.textContent = 'Indicadores e composição do score';
    values.textContent = JSON.stringify(item.analysis, null, 2);
    details.append(summary, values); li.append(details);
  }
  $('automationLog').prepend(li);
  while ($('automationLog').children.length > 200) $('automationLog').lastChild.remove();
}
function renderRemoteState(state) {
  if (!state || busy) return;
  const suffix = state.running ? 'Sessão ativa em outro navegador: ' : 'Última sessão publicada: ';
  if (state.message) $('automationStatus').textContent = suffix + state.message;
  $('automationTotals').textContent = `Operações: ${Number(state.trades || 0)} · Resultado da sessão: ${Number(state.profit || 0).toFixed(2)} ${state.currency || ''}`;
  const events = Array.isArray(state.events) ? state.events : [];
  for (const item of events.slice().reverse()) {
    if (!item.id || item.id <= lastRemoteEvent) continue;
    const li = document.createElement('li');
    li.textContent = `${new Date(item.time || Date.now()).toLocaleTimeString('pt-BR')} · ${item.message}`;
    $('automationLog').prepend(li);
    lastRemoteEvent = item.id;
  }
  while ($('automationLog').children.length > 200) $('automationLog').lastChild.remove();
}
async function pollRemoteState() {
  try { renderRemoteState(await readSessionState()); }
  catch {}
}
$('accountForm').addEventListener('submit', async e => {
  e.preventDefault();
  if (connecting || connected || busy) return;
  connecting = true;
  controls();
  $('accountStatus').textContent = 'Localizando e conectando sua conta demo…';
  client = new AccountConnection({onDisconnect:error=>{
    runRequested = false;
    connected = false;
    if (engine) engine.stop();
    $('accountStatus').textContent = error.message;
    controls();
  }});
  try {
    await client.connect({});
    const accountId = client.accountId;
    const response = await client.request({balance:1});
    const balance = response.balance;
    if (!balance || typeof balance.currency !== 'string' || balance.balance == null || !Number.isFinite(Number(balance.balance))) throw new Error('Não foi possível verificar o saldo demo.');
    if (balance.loginid && balance.loginid !== accountId) throw new Error('A conta retornada difere da conta demo localizada.');
    connected = true;
    engine = new DemoAutomation({client,accountId,currency:balance.currency,onEvent:event});
    $('accountStatus').textContent = `Demo conectada: ${accountId} · Saldo: ${Number(balance.balance).toFixed(2)} ${balance.currency}`;
    $('automationStatus').textContent = engine.pending() ? 'Existe compra pendente de conferência. Abra a seção de conferência abaixo.' : 'Revise os valores e clique em Iniciar sessão demo.';
  } catch (error) {
    client.close();
    connected = false;
    $('accountStatus').textContent = error.message;
  } finally {
    connecting = false;
    controls();
  }
});
$('startAutomation').addEventListener('click', async () => {
  if (!connected || busy) return;
  try {
    const input = Object.fromEntries(Object.keys(automationDefaults).map(k=>[k,Number($('auto-'+k).value)]));
    const config = validateAutomation(input);
    busy = true;
    runRequested = true;
    controls();
    await publishSessionEvent({message:'Sessão demo iniciada neste navegador.', trades:engine.trades, profit:engine.profit}, {accountId:engine.accountId, currency:engine.currency, running:true}).catch(()=>{});
    await withSessionLock(`prisma-demo:${engine.accountId}`, async ()=>{
      if (!runRequested || !connected) return;
      await engine.run(config);
    });
    if (!engine.pending()) {
      $('automationStatus').textContent += ' Sessão finalizada.';
      await publishSessionEvent({message:'Sessão finalizada.', trades:engine.trades, profit:engine.profit}, {accountId:engine.accountId, currency:engine.currency, running:false}).catch(()=>{});
    }
  } catch (error) { $('automationStatus').textContent = error.message; }
  finally { runRequested = false; busy = false; controls(); }
});
$('stopAutomation').addEventListener('click',()=>{runRequested = false;engine?.stop();if(engine)publishSessionEvent({message:'Parada solicitada.', trades:engine.trades, profit:engine.profit}, {accountId:engine.accountId, currency:engine.currency, running:false}).catch(()=>{});});
$('disconnectAccount').addEventListener('click',()=>{
  if (busy) return;
  client?.close(); connected = false;
  $('accountStatus').textContent = 'Conta desconectada.'; controls();
});
$('clearPending').addEventListener('click',async()=>{
  if (!connected || busy) return;
  if (!$('pendingChecked').checked) { $('automationStatus').textContent = 'Confira as posições e o histórico na Deriv e marque a confirmação.'; return; }
  busy = true; controls();
  try {
    await withSessionLock(`prisma-demo:${engine.accountId}`,async ()=>{
      await engine.acknowledgeUnknown();
    });
    $('pendingChecked').checked = false;
  } catch(error) { $('automationStatus').textContent = error.message; }
  finally { busy = false; controls(); }
});
window.addEventListener('beforeunload',e=>{if(busy){e.preventDefault();e.returnValue='';}});
window.addEventListener('pagehide',()=>{runRequested = false;engine?.stop();client?.close();});
controls();
pollRemoteState();
setInterval(pollRemoteState, 3000);
