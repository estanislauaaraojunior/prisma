import {calculate, defaults} from './math.mjs';
import {scanSynthetic} from './deriv.mjs';

export const automationDefaults = Object.freeze({stake:1, stopLoss:5, takeProfit:5, maxTrades:10, duration:1, minADX:25});
export function validateAutomation(input) {
  const c = {...input};
  for (const k of ['stake','stopLoss','takeProfit']) {
    if (!Number.isFinite(c[k]) || c[k] <= 0 || c[k] > 10000 || Math.abs(c[k]*100-Math.round(c[k]*100))>1e-7) throw new Error('Valores monetários: use números positivos com até duas casas decimais.');
  }
  if (c.stake > c.stopLoss) throw new Error('A entrada não pode exceder o limite de perda.');
  if (!Number.isInteger(c.maxTrades) || c.maxTrades < 1 || c.maxTrades > 100) throw new Error('Use de 1 a 100 operações por sessão.');
  if (!Number.isInteger(c.duration) || c.duration < 1 || c.duration > 60) throw new Error('Duração: use de 1 a 60 minutos.');
  if (!Number.isFinite(c.minADX) || c.minADX < 1 || c.minADX > 100) throw new Error('ADX mínimo: use de 1 a 100.');
  return Object.freeze(c);
}
export function entrySignal(candidate, config) {
  if (!['Continuous Volatility Indices','Jump Indices','Step Indices'].includes(candidate.family)) return null;
  if (!Array.isArray(candidate.rows) || candidate.rows.length < 500) return null;
  const m = calculate(candidate.rows, defaults), i = candidate.rows.length-1;
  if (![m.adx[i],m.ema[i],m.dip[i],m.dim[i]].every(Number.isFinite) || m.adx[i] < config.minADX) return null;
  const close = candidate.rows[i].close;
  if (m.dip[i] > m.dim[i] && close > m.ema[i]) return 'CALL';
  if (m.dim[i] > m.dip[i] && close < m.ema[i]) return 'PUT';
  return null;
}
export function supportsDuration(available, type, minutes) {
  const seconds = value => {
    const match = /^(\d+)([smhd])$/.exec(value || '');
    return match ? Number(match[1])*({s:1,m:60,h:3600,d:86400}[match[2]]) : NaN;
  };
  return Array.isArray(available) && available.some(c => c.contract_type === type && c.expiry_type === 'intraday' && seconds(c.min_contract_duration) <= minutes*60 && seconds(c.max_contract_duration) >= minutes*60);
}
const money = value => Math.round(value*100)/100;
export class DemoAutomation {
  constructor({client, accountId, currency, storage = globalThis.localStorage, scan = scanSynthetic, wait = ms => new Promise(r=>setTimeout(r,ms)), onEvent = () => {}}) {
    this.client = client;
    this.accountId = accountId;
    this.currency = currency;
    this.storage = storage;
    this.scan = scan;
    this.wait = wait;
    this.onEvent = onEvent;
    this.key = `prisma-demo-pending:${accountId}`;
    this.running = false;
    this.busy = false;
    this.profit = 0;
    this.trades = 0;
  }
  emit(message, extra = {}) { this.onEvent({message, profit:this.profit, trades:this.trades, ...extra}); }
  stop() { this.running = false; this.emit('Parada solicitada. Uma compra já enviada será acompanhada até a liquidação.'); }
  pending() { const raw = this.storage.getItem(this.key); return raw ? JSON.parse(raw) : null; }
  save(record) { this.storage.setItem(this.key, JSON.stringify(record)); }
  async emptyPortfolio() {
    const result = await this.client.request({portfolio:1});
    if (!Array.isArray(result.portfolio?.contracts)) throw new Error('Não foi possível verificar as posições da conta.');
    if (result.portfolio.contracts.length) throw new Error('Há contratos abertos na conta demo. Aguarde a liquidação antes de iniciar uma sessão.');
  }
  async acknowledgeUnknown() {
    if (this.busy) throw new Error('Pare a sessão antes de conferir pendências.');
    const pending = this.pending();
    if (!pending) return;
    if (pending.contractId) {
      const response = await this.client.request({proposal_open_contract:1,contract_id:pending.contractId});
      if (String(response.proposal_open_contract?.contract_id)!==String(pending.contractId) || Number(response.proposal_open_contract?.is_sold)!==1) throw new Error('O contrato registrado ainda não foi liquidado.');
    }
    await this.emptyPortfolio();
    this.storage.removeItem(this.key);
    this.emit('Conferência confirmada. A próxima execução inicia uma nova sessão.');
  }
  async monitor(record) {
    while (true) {
      const response = await this.client.request({proposal_open_contract:1,contract_id:record.contractId});
      const contract = response.proposal_open_contract;
      if (!contract || String(contract.contract_id)!==String(record.contractId)) throw new Error('Resposta do contrato inconsistente. Confira a posição na Deriv.');
      if (Number(contract.is_sold)===1) {
        const profit = Number(contract.profit);
        if (contract.profit == null || !Number.isFinite(profit)) throw new Error('Resultado do contrato indisponível.');
        this.profit = money(this.profit + profit);
        this.storage.removeItem(this.key);
        this.emit(`Contrato ${record.contractId} liquidado: ${profit.toFixed(2)} ${this.currency}.`, {settled:{...record,profit}});
        return;
      }
      await this.wait(2000);
    }
  }
  async run(input) {
    if (this.busy) throw new Error('A sessão já está em execução.');
    const config = validateAutomation(input);
    if (this.pending()) throw new Error('Existe uma compra pendente de conferência. Verifique-a na Deriv antes de iniciar outra sessão.');
    this.busy = this.running = true;
    this.profit = this.trades = 0;
    let lastBoundary = null;
    try {
      await this.emptyPortfolio();
      while (this.running) {
        if (this.trades >= config.maxTrades || this.profit >= config.takeProfit || money(this.profit-config.stake) < -config.stopLoss) {
          this.emit('Sessão encerrada pelo limite de operações, ganho ou perda.');
          break;
        }
        const clock = await this.client.request({time:1});
        if (!Number.isFinite(clock.time)) throw new Error('Horário da Deriv indisponível.');
        if (Math.floor(clock.time/60)*60 === lastBoundary) { await this.wait(2000); continue; }
        this.emit('Buscando sinais nas três famílias de índices…');
        const result = await this.scan({granularity:60, onProgress:p=>{
          if (!this.running) throw new Error('Busca interrompida.');
          this.emit(`Analisando ${p.done+1}/${p.total}: ${p.name}`);
        }});
        if (!this.running) break;
        lastBoundary = result.boundary;
        let selection;
        for (const candidate of result.ranking) {
          const type = entrySignal(candidate,config);
          if (!type) continue;
          const response = await this.client.request({contracts_for:candidate.symbol});
          if (!this.running) break;
          if (supportsDuration(response.contracts_for?.available,type,config.duration)) { selection={candidate,type}; break; }
        }
        if (!this.running) break;
        if (!selection) { this.emit('Sem sinal compatível com os contratos disponíveis. Aguardando próximo candle.'); continue; }
        const {candidate,type} = selection;
        await this.emptyPortfolio();
        const balanceResponse = await this.client.request({balance:1});
        const balance = balanceResponse.balance;
        if (!balance || balance.currency !== this.currency || balance.balance == null || !Number.isFinite(Number(balance.balance)) || Number(balance.balance)<config.stake) throw new Error('Saldo insuficiente ou moeda da conta inconsistente.');
        if (!this.running) break;
        const quoteResponse = await this.client.request({proposal:1,amount:config.stake,basis:'stake',contract_type:type,currency:this.currency,duration:config.duration,duration_unit:'m',underlying_symbol:candidate.symbol});
        const quote = quoteResponse.proposal;
        const price = Number(quote?.ask_price);
        if (!quote?.id || !Number.isFinite(price) || price<=0 || price>config.stake || !Number.isFinite(Number(quote.spot_time))) throw new Error('Cotação inválida ou acima do valor de entrada.');
        const fresh = await this.client.request({time:1});
        if (!Number.isFinite(fresh.time)) throw new Error('Não foi possível verificar o horário da entrada.');
        if (!this.running) break;
        if (Math.floor(fresh.time/60)*60 !== result.boundary || fresh.time-Number(quote.spot_time)>10 || fresh.time<Number(quote.spot_time)) {
          this.emit('Sinal ou cotação desatualizados. Aguardando nova análise.'); continue;
        }
        const record = {symbol:candidate.symbol,type,stake:price,created:fresh.time,contractId:null};
        this.save(record); // Persist before send; an unconfirmed purchase is never retried.
        let bought;
        try { bought = await this.client.request({buy:quote.id,price:config.stake}); }
        catch (error) {
          // Only an explicit API rejection proves no purchase was made.
          if (error.code && !error.uncertain) this.storage.removeItem(this.key);
          throw error;
        }
        const contractId = bought.buy?.contract_id;
        if (!Number.isSafeInteger(Number(contractId)) || Number(contractId)<=0) throw new Error('Compra sem identificador válido. Confira as posições na Deriv.');
        record.contractId = contractId;
        this.save(record);
        this.trades++;
        this.emit(`Compra demo: ${candidate.name} · ${type==='CALL'?'Alta':'Baixa'} · ${price.toFixed(2)} ${this.currency}.`, {opened:record, chart:{symbol:candidate.symbol,name:candidate.name,family:candidate.family,rows:candidate.rows,boundary:result.boundary,granularity:result.granularity,type}});
        await this.monitor(record);
      }
    } catch (error) {
      if (this.running || this.pending()) throw error;
    } finally { this.running = this.busy = false; }
  }
}
