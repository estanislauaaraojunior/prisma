import {calculate, defaults} from './math.mjs';
import {scanSynthetic, scanSyntheticSymbol} from './deriv.mjs';

export const automationDefaults = Object.freeze({stake:1, stopLoss:5, takeProfit:5, maxTrades:10, duration:1, granularity:0, minADX:25, martingale:0, martingaleMultiplier:2, martingaleMaxSteps:2});
export const automationGranularities = Object.freeze([60,300,900,3600]);
export const granularityLabel = seconds => seconds === 3600 ? '1 hora' : `${seconds / 60} min`;
export function validateAutomation(input) {
  const c = {...automationDefaults, ...input};
  for (const k of ['stake','stopLoss','takeProfit']) {
    if (!Number.isFinite(c[k]) || c[k] <= 0 || c[k] > 10000 || Math.abs(c[k]*100-Math.round(c[k]*100))>1e-7) throw new Error('Valores monetários: use números positivos com até duas casas decimais.');
  }
  if (c.stake > c.stopLoss) throw new Error('A entrada não pode exceder o limite de perda.');
  if (!Number.isInteger(c.maxTrades) || c.maxTrades < 1 || c.maxTrades > 100) throw new Error('Use de 1 a 100 operações por sessão.');
  if (!Number.isInteger(c.duration) || c.duration < 1 || c.duration > 60) throw new Error('Duração: use de 1 a 60 minutos.');
  if (![0,...automationGranularities].includes(c.granularity)) throw new Error('Tempo dos candles: use automático, 1 minuto, 5 minutos, 15 minutos ou 1 hora.');
  if (!Number.isFinite(c.minADX) || c.minADX < 1 || c.minADX > 100) throw new Error('ADX mínimo: use de 1 a 100.');
  c.martingale = c.martingale ? 1 : 0;
  if (!Number.isFinite(c.martingaleMultiplier) || c.martingaleMultiplier < 1.1 || c.martingaleMultiplier > 5) throw new Error('Multiplicador do martingale: use de 1,10 a 5.');
  if (!Number.isInteger(c.martingaleMaxSteps) || c.martingaleMaxSteps < 1 || c.martingaleMaxSteps > 10) throw new Error('Passos do martingale: use de 1 a 10.');
  return Object.freeze(c);
}
export function entrySignal(candidate, config) {
  return entryAnalysis(candidate, config)?.type ?? null;
}
export function entryAnalysis(candidate, config) {
  if (!['Continuous Volatility Indices','Jump Indices','Step Indices'].includes(candidate.family)) return null;
  if (!Array.isArray(candidate.rows) || candidate.rows.length < 500) return null;
  const m = calculate(candidate.rows, defaults), i = candidate.rows.length-1;
  if (![m.adx[i],m.ema[i],m.dip[i],m.dim[i],m.macd[i],m.signal[i],m.histogram[i],m.rsi[i],m.atr[i]].every(Number.isFinite) || m.adx[i] < config.minADX) return null;
  const close = candidate.rows[i].close;
  const atrRatio = m.atr[i] / close;
  if (!Number.isFinite(atrRatio) || atrRatio <= 0 || atrRatio > 0.01) return null;
  let type = null;
  if (m.dip[i] > m.dim[i] && close > m.ema[i]) type = 'CALL';
  if (m.dim[i] > m.dip[i] && close < m.ema[i]) type = 'PUT';
  if (!type) return null;
  const bullish = type === 'CALL';
  const eps = Math.max(1e-10, Math.abs(close)*1e-12);
  const macdOk = bullish ? m.macd[i] > 0 && m.histogram[i] >= -eps : m.macd[i] < 0 && m.histogram[i] <= eps;
  const rsiOk = bullish ? m.rsi[i] >= 50 : m.rsi[i] <= 50;
  if (!macdOk || !rsiOk) return null;
  const bodyOk = bullish ? candidate.rows[i].close >= candidate.rows[i].open : candidate.rows[i].close <= candidate.rows[i].open;
  const score = 75 + (macdOk ? 10 : 0) + (rsiOk ? 10 : 0) + (bodyOk ? 5 : 0);
  return {type, score, adx:m.adx[i], rsi:m.rsi[i], atr:m.atr[i], atrRatio, macd:m.macd[i], signal:m.signal[i], histogram:m.histogram[i], bodyOk};
}
export function supportsDuration(available, type, minutes) {
  const seconds = value => {
    const match = /^(\d+)([smhd])$/.exec(value || '');
    return match ? Number(match[1])*({s:1,m:60,h:3600,d:86400}[match[2]]) : NaN;
  };
  return Array.isArray(available) && available.some(c => c.contract_type === type && c.expiry_type === 'intraday' && seconds(c.min_contract_duration) <= minutes*60 && seconds(c.max_contract_duration) >= minutes*60);
}
const money = value => Math.round(value*100)/100;
const boundaryFor = (time, granularity) => Math.floor(time/granularity)*granularity;
const boundaryKey = (time, granularity) => `${granularity}:${boundaryFor(time, granularity)}`;
const candidateGranularities = config => config.granularity ? [config.granularity] : automationGranularities;
const betterSelection = (selection, candidate, analysis, granularity) => !selection || analysis.score > selection.analysis.score || (analysis.score === selection.analysis.score && analysis.adx > selection.analysis.adx) || (analysis.score === selection.analysis.score && analysis.adx === selection.analysis.adx && granularity < selection.granularity);
export class DemoAutomation {
  constructor({client, accountId, currency, storage = globalThis.localStorage, scan = scanSynthetic, scanCurrent = scanSyntheticSymbol, wait = ms => new Promise(r=>setTimeout(r,ms)), onEvent = () => {}}) {
    this.client = client;
    this.accountId = accountId;
    this.currency = currency;
    this.storage = storage;
    this.scan = scan;
    this.scanCurrent = scanCurrent;
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
  async reconcilePendingBeforeRun() {
    const pending = this.pending();
    if (!pending) return;
    this.emit('Verificando pendência local antes de iniciar nova sessão.');
    if (pending.contractId) {
      const response = await this.client.request({proposal_open_contract:1,contract_id:pending.contractId});
      if (String(response.proposal_open_contract?.contract_id)!==String(pending.contractId) || Number(response.proposal_open_contract?.is_sold)!==1) throw new Error('O contrato registrado ainda não foi liquidado.');
    }
    await this.emptyPortfolio();
    this.storage.removeItem(this.key);
    this.emit('Pendência local liberada: não há contrato aberto na conta demo.');
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
        return profit;
      }
      await this.wait(2000);
    }
  }
  async keepCurrentSelection(current, config) {
    if (!current?.candidate || !current.analysis?.type) return null;
    const granularity = current.granularity || config.granularity || automationDefaults.granularity;
    this.emit(`Reavaliando ${current.candidate.name} em ${granularityLabel(granularity)} antes de buscar outro símbolo.`);
    try {
      const candidate = await this.scanCurrent({
        symbol:current.candidate.symbol,
        name:current.candidate.name,
        family:current.candidate.family,
        granularity
      });
      const analysis = entryAnalysis(candidate, config);
      if (analysis?.type !== current.analysis.type) return null;
      const response = await this.client.request({contracts_for:candidate.symbol});
      if (!supportsDuration(response.contracts_for?.available, analysis.type, config.duration)) return null;
      this.emit(`Tendência mantida em ${candidate.name} · ${granularityLabel(candidate.granularity)}. Mantendo o mesmo símbolo.`);
      return {candidate, analysis, boundary:candidate.boundary, granularity:candidate.granularity};
    } catch (error) {
      this.emit(`Não foi possível reavaliar ${current.candidate.name}: ${error.message}`);
      return null;
    }
  }
  async run(input) {
    if (this.busy) throw new Error('A sessão já está em execução.');
    const config = validateAutomation(input);
    await this.reconcilePendingBeforeRun();
    this.busy = this.running = true;
    this.profit = this.trades = 0;
    const usedBoundaries = new Set();
    let currentSelection = null;
    let martingaleStep = 0;
    try {
      await this.emptyPortfolio();
      while (this.running) {
        const nextStake = money(config.stake * (config.martingale ? config.martingaleMultiplier ** martingaleStep : 1));
        if (this.trades >= config.maxTrades || this.profit >= config.takeProfit || money(this.profit-nextStake) < -config.stopLoss) {
          this.emit('Sessão encerrada pelo limite de operações, ganho ou perda.');
          break;
        }
        const clock = await this.client.request({time:1});
        if (!Number.isFinite(clock.time)) throw new Error('Horário da Deriv indisponível.');
        const pendingGranularities = candidateGranularities(config).filter(g => !usedBoundaries.has(boundaryKey(clock.time, g)));
        if (!pendingGranularities.length) { await this.wait(2000); continue; }
        let selection = currentSelection && pendingGranularities.includes(currentSelection.granularity) ? await this.keepCurrentSelection(currentSelection, config) : null;
        let result = selection ? {boundary:selection.boundary, granularity:selection.granularity} : null;
        if (!this.running) break;
        if (!selection) {
          if (currentSelection) this.emit('Tendência mudou ou perdeu compatibilidade. Buscando novo símbolo.');
          else this.emit(config.granularity ? `Buscando sinais em ${granularityLabel(config.granularity)}…` : 'Buscando o melhor tempo entre 1m, 5m, 15m e 1h…');
          const failures = [];
          const scannedBoundaries = [];
          for (const granularity of pendingGranularities) {
            this.emit(`Comparando tempo ${granularityLabel(granularity)}.`);
            try {
              const scanResult = await this.scan({granularity, onProgress:p=>{
                if (!this.running) throw new Error('Busca interrompida.');
                this.emit(`${granularityLabel(granularity)} · analisando ${p.done+1}/${p.total}: ${p.name}`);
              }});
              scannedBoundaries.push(`${granularity}:${scanResult.boundary}`);
              if (!this.running) break;
              for (const candidate of scanResult.ranking) {
                const analysis = entryAnalysis(candidate,config);
                if (!analysis) continue;
                const response = await this.client.request({contracts_for:candidate.symbol});
                if (!this.running) break;
                if (supportsDuration(response.contracts_for?.available,analysis.type,config.duration) && betterSelection(selection,candidate,analysis,granularity)) {
                  selection={candidate,analysis,boundary:scanResult.boundary,granularity};
                  result = {boundary:scanResult.boundary, granularity};
                }
              }
            } catch (error) { failures.push(`${granularityLabel(granularity)}: ${error.message}`); }
            if (!this.running) break;
          }
          for (const key of scannedBoundaries) usedBoundaries.add(key);
          if (!selection && failures.length) this.emit('Tempos sem sinal elegível: ' + failures.join(' | '));
        }
        if (!this.running) break;
        if (!selection) { this.emit('Sem sinal compatível com os contratos disponíveis. Aguardando próximo candle.'); continue; }
        const {candidate,analysis} = selection;
        const type = analysis.type;
        await this.emptyPortfolio();
        const balanceResponse = await this.client.request({balance:1});
        const balance = balanceResponse.balance;
        if (!balance || balance.currency !== this.currency || balance.balance == null || !Number.isFinite(Number(balance.balance)) || Number(balance.balance)<nextStake) throw new Error('Saldo insuficiente ou moeda da conta inconsistente.');
        if (!this.running) break;
        const quoteResponse = await this.client.request({proposal:1,amount:nextStake,basis:'stake',contract_type:type,currency:this.currency,duration:config.duration,duration_unit:'m',underlying_symbol:candidate.symbol});
        const quote = quoteResponse.proposal;
        const price = Number(quote?.ask_price);
        if (!quote?.id || !Number.isFinite(price) || price<=0 || price>nextStake || !Number.isFinite(Number(quote.spot_time))) throw new Error('Cotação inválida ou acima do valor de entrada.');
        const fresh = await this.client.request({time:1});
        if (!Number.isFinite(fresh.time)) throw new Error('Não foi possível verificar o horário da entrada.');
        if (!this.running) break;
        if (boundaryFor(fresh.time,result.granularity) !== result.boundary || fresh.time-Number(quote.spot_time)>10 || fresh.time<Number(quote.spot_time)) {
          this.emit('Sinal ou cotação desatualizados. Aguardando nova análise.'); continue;
        }
        const record = {symbol:candidate.symbol,type,stake:price,created:fresh.time,contractId:null,analysis};
        this.save(record); // Persist before send; an unconfirmed purchase is never retried.
        let bought;
        try { bought = await this.client.request({buy:quote.id,price:nextStake}); }
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
        currentSelection = {candidate,analysis,granularity:result.granularity};
        usedBoundaries.add(`${result.granularity}:${result.boundary}`);
        this.emit(`Compra demo: ${candidate.name} · ${granularityLabel(result.granularity)} · ${type==='CALL'?'Alta':'Baixa'} · ${price.toFixed(2)} ${this.currency}.`, {opened:record, chart:{symbol:candidate.symbol,name:candidate.name,family:candidate.family,rows:candidate.rows,boundary:result.boundary,granularity:result.granularity,type}});
        const profit = await this.monitor(record);
        martingaleStep = config.martingale && profit < 0 ? Math.min(martingaleStep + 1, config.martingaleMaxSteps) : 0;
      }
    } catch (error) {
      if (this.running || this.pending()) throw error;
    } finally { this.running = this.busy = false; }
  }
}
