import {calculate, defaults, parseCSV} from './math.mjs';

export const DERIV_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
export const SCAN_COUNT = 500;
export const SCAN_ADX = 14;

// Only public data requests are exposed by this client.
export class DerivClient {
  constructor({Socket = globalThis.WebSocket, timeout = 15000} = {}) {
    this.Socket = Socket;
    this.timeout = timeout;
    this.pending = new Map();
    this.nextId = 0;
  }
  connect() {
    return new Promise((resolve, reject) => {
      const ws = this.socket = new this.Socket(DERIV_URL);
      const timer = setTimeout(() => fail(new Error('Tempo esgotado ao conectar à Deriv.')), this.timeout);
      const fail = error => {
        clearTimeout(timer);
        reject(error);
        this.close(error);
      };
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => fail(new Error('Não foi possível conectar à Deriv. Verifique sua conexão e tente novamente.'));
      ws.onclose = () => fail(new Error('A conexão com a Deriv foi encerrada.'));
      ws.onmessage = event => {
        let data;
        try { data = JSON.parse(event.data); } catch { return; }
        const item = this.pending.get(data.req_id);
        if (!item) return;
        this.pending.delete(data.req_id);
        clearTimeout(item.timer);
        if (data.error) item.reject(new Error(data.error.message || 'A Deriv recusou a consulta.'));
        else item.resolve(data);
      };
    });
  }
  request(payload) {
    const keys = Object.keys(payload);
    const allowed = 'active_symbols' in payload ? ['active_symbols'] : 'ticks_history' in payload ? ['ticks_history','count','end','style','granularity'] : ['time'];
    if (keys.some(k => !allowed.includes(k)) || !keys.length) return Promise.reject(new Error('Somente consultas públicas de dados são permitidas.'));
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== 1) return reject(new Error('Deriv desconectada.'));
      const req_id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        reject(new Error('Tempo esgotado na consulta à Deriv.'));
      }, this.timeout);
      this.pending.set(req_id, {resolve, reject, timer});
      try { this.socket.send(JSON.stringify({...payload, req_id})); }
      catch (error) { clearTimeout(timer); this.pending.delete(req_id); reject(error); }
    });
  }
  close(error = new Error('Consulta encerrada.')) {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(error); }
    this.pending.clear();
    if (this.socket) {
      this.socket.onclose = this.socket.onerror = null;
      this.socket.close();
    }
  }
}

export function normalizeCandles(candles, boundary, granularity) {
  if (!Array.isArray(candles) || !candles.length) throw new Error('Histórico indisponível.');
  const text = 'timestamp,open,high,low,close\n' + candles.map(c => [c.epoch,c.open,c.high,c.low,c.close].join(',')).join('\n');
  const {rows} = parseCSV(text);
  const closed = rows.filter(r => r.time + granularity <= boundary).slice(-SCAN_COUNT);
  if (closed.length !== SCAN_COUNT) throw new Error('Histórico insuficiente: são necessários 500 candles fechados.');
  if (closed.at(-1).time !== boundary - granularity) throw new Error('Último candle desatualizado ou mercado fechado.');
  return closed;
}

export function scoreSymbol(symbol, rows) {
  const m = calculate(rows, {...defaults, adx: SCAN_ADX});
  const adx = m.adx.at(-1), plus = m.dip.at(-1), minus = m.dim.at(-1);
  if (![adx, plus, minus].every(Number.isFinite)) throw new Error('Indicadores indisponíveis.');
  return {symbol: symbol.symbol, name: symbol.display_name || symbol.symbol, rows, adx,
    direction: plus > minus ? 'Alta' : plus < minus ? 'Baixa' : 'Neutra'};
}

export async function scanSynthetic({granularity = 60, onProgress = () => {}, client = new DerivClient()} = {}) {
  if (![60,300,900,3600].includes(granularity)) throw new Error('Intervalo inválido.');
  try {
    await client.connect();
    const clock = await client.request({time:1});
    if (!Number.isFinite(clock.time)) throw new Error('Horário da Deriv indisponível.');
    const boundary = Math.floor(clock.time / granularity) * granularity;
    const response = await client.request({active_symbols:'brief'});
    if (!Array.isArray(response.active_symbols)) throw new Error('Lista de ativos inválida.');
    const available = response.active_symbols.map(s => ({...s, symbol:s.underlying_symbol || s.symbol, display_name:s.underlying_symbol_name || s.display_name})).filter(s => typeof s.symbol === 'string' && Number(s.exchange_is_open) === 1 && !Number(s.is_trading_suspended));
    const families = {random_index:'Continuous Volatility Indices', jump_index:'Jump Indices', step_index:'Step Indices'};
    const symbols = available.filter(s => s.market === 'synthetic_index' && Object.hasOwn(families, s.submarket));
    const failures = [], ranking = [];
    const market = 'synthetic_index';
    const marketLabel = 'Índices sintéticos · Continuous Volatility, Jump e Step';
    for (const [index, symbol] of symbols.entries()) {
      onProgress({done:index, total:symbols.length, name:symbol.display_name || symbol.symbol, market, marketLabel});
      try {
        const data = await client.request({ticks_history:symbol.symbol, count:SCAN_COUNT + 1, end:boundary - 1, style:'candles', granularity});
        ranking.push({...scoreSymbol(symbol, normalizeCandles(data.candles, boundary, granularity)), family:families[symbol.submarket]});
      } catch (error) { failures.push({symbol:symbol.symbol, message:error.message}); }
    }
    ranking.sort((a,b) => b.adx - a.adx || a.symbol.localeCompare(b.symbol));
    if (ranking.length) return {ranking, failures, total:symbols.length, market, marketLabel, boundary, granularity};
    throw new Error('Nenhum ativo de Continuous Volatility, Jump ou Step pôde ser comparado: ' + (failures[0]?.message || 'nenhum ativo dessas famílias está aberto e disponível.'));
  } finally { client.close(); }
}
