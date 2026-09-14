import {AccountConnection} from './deriv-account.mjs';
import {DemoAutomation, automationDefaults, validateAutomation} from './automation.mjs';
const $ = id => document.getElementById(id);
let client = null, engine = null, connected = false, busy = false, connecting = false, runRequested = false;
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
    if (!navigator.locks) throw new Error('Use um navegador com suporte a bloqueio de sessão (Web Locks) no endereço local.');
    busy = true;
    runRequested = true;
    controls();
    await navigator.locks.request(`prisma-demo:${engine.accountId}`, {ifAvailable:true}, async lock=>{
      if (!lock) throw new Error('Já existe uma sessão ativa desta conta em outra aba.');
      if (!runRequested || !connected) return;
      await engine.run(config);
    });
    if (!engine.pending()) $('automationStatus').textContent += ' Sessão finalizada.';
  } catch (error) { $('automationStatus').textContent = error.message; }
  finally { runRequested = false; busy = false; controls(); }
});
$('stopAutomation').addEventListener('click',()=>{runRequested = false;engine?.stop();});
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
    if (!navigator.locks) throw new Error('Navegador sem suporte a bloqueio de sessão.');
    await navigator.locks.request(`prisma-demo:${engine.accountId}`,{ifAvailable:true},async lock=>{
      if (!lock) throw new Error('Existe uma sessão ativa em outra aba.');
      await engine.acknowledgeUnknown();
    });
    $('pendingChecked').checked = false;
  } catch(error) { $('automationStatus').textContent = error.message; }
  finally { busy = false; controls(); }
});
window.addEventListener('beforeunload',e=>{if(busy){e.preventDefault();e.returnValue='';}});
window.addEventListener('pagehide',()=>{runRequested = false;engine?.stop();client?.close();});
controls();
