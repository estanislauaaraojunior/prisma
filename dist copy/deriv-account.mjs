const API = 'https://api.derivws.com/trading/v1/options/accounts';
const LOCAL_ACCOUNT_SOCKET = '/api/deriv/account-socket';

// Credentials are used for account discovery and OTP only; never persisted or logged.
export function selectDemoAccount(body) {
  const accounts = body?.data;
  if (!Array.isArray(accounts)) throw new Error('A Deriv retornou uma lista de contas inválida.');
  const demos = accounts.filter(account => account?.account_type === 'demo' && account.status === 'active' && typeof account.account_id === 'string' && /^[A-Za-z0-9]+$/.test(account.account_id));
  // Stable selection when more than one demo account is available.
  demos.sort((a,b) => Number(b.currency === 'USD') - Number(a.currency === 'USD') || a.account_id.localeCompare(b.account_id));
  if (!demos.length) throw new Error('Nenhuma conta demo de Options ativa foi encontrada para este token. Verifique sua conta na Deriv.');
  return demos[0];
}

export async function requestAccountSocket({appId, token, accountType = 'demo'}, {fetcher = globalThis.fetch, timeout = 15000} = {}) {
  if (accountType !== 'demo') throw new Error('Este robô aceita somente conta demo.');
  if ((!appId || !appId.trim()) && (!token || !token.trim())) return requestLocalAccountSocket({fetcher, timeout});
  if (typeof appId !== 'string' || !appId.trim() || typeof token !== 'string' || !token.trim()) throw new Error('Configure DERIV_APP_ID e DERIV_TOKEN no arquivo .env.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const options = {headers:{Authorization:`Bearer ${token.trim()}`, 'Deriv-App-ID':appId.trim()}, signal:controller.signal, cache:'no-store', credentials:'omit', redirect:'error'};
  try {
    const accountsResponse = await fetcher(API, {...options, method:'GET'});
    if (!accountsResponse.ok) throw new Error(`A Deriv recusou a consulta de contas (HTTP ${accountsResponse.status}). Confira DERIV_APP_ID e a permissão trade do DERIV_TOKEN.`);
    const account = selectDemoAccount(await accountsResponse.json());
    const response = await fetcher(`${API}/${encodeURIComponent(account.account_id)}/otp`, {...options, method:'POST'});
    if (!response.ok) throw new Error(`A Deriv recusou a autenticação (HTTP ${response.status}). Confira DERIV_APP_ID e a permissão trade do DERIV_TOKEN.`);
    const body = await response.json();
    let url;
    try { url = new URL(body?.data?.url); } catch { throw new Error('A Deriv não retornou uma conexão válida.'); }
    if (url.origin !== 'wss://api.derivws.com' || url.pathname !== '/trading/v1/options/ws/demo' || !url.searchParams.get('otp') || url.username || url.password || url.hash) {
      throw new Error('A conexão retornada não corresponde ao tipo de conta selecionado.');
    }
    return {url:url.href, accountId:account.account_id};
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Tempo esgotado ao autenticar na Deriv.');
    if (error instanceof TypeError) throw new Error('Falha de rede ao autenticar na Deriv.');
    throw error;
  } finally { clearTimeout(timer); }
}

async function requestLocalAccountSocket({fetcher = globalThis.fetch, timeout = 15000} = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetcher(LOCAL_ACCOUNT_SOCKET, {method:'POST', signal:controller.signal, cache:'no-store', credentials:'same-origin', redirect:'error'});
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Falha ao autenticar pelo servidor local (HTTP ${response.status}).`);
    let url;
    try { url = new URL(body.url); } catch { throw new Error('O servidor local não retornou uma conexão válida.'); }
    if (url.origin !== 'wss://api.derivws.com' || url.pathname !== '/trading/v1/options/ws/demo' || !url.searchParams.get('otp') || url.username || url.password || url.hash) throw new Error('A conexão local retornada não corresponde ao tipo de conta selecionado.');
    if (typeof body.accountId !== 'string' || !/^[A-Za-z0-9]+$/.test(body.accountId)) throw new Error('O servidor local não retornou uma conta demo válida.');
    return {url:url.href, accountId:body.accountId};
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('Tempo esgotado ao autenticar pelo servidor local.');
    if (error instanceof TypeError) throw new Error('Falha de rede ao autenticar pelo servidor local.');
    throw error;
  } finally { clearTimeout(timer); }
}

// One-shot requests only. Reconnection and retries never replay an order.
export class AccountConnection {
  constructor({Socket = globalThis.WebSocket, timeout = 15000, onDisconnect = () => {}} = {}) {
    this.Socket = Socket;
    this.timeout = timeout;
    this.onDisconnect = onDisconnect;
    this.pending = new Map();
    this.sequence = 0;
  }
  async connect(credentials, options) {
    if (this.socket || this.connecting) throw new Error('A conexão da conta já foi iniciada.');
    this.connecting = true;
    try {
      const {url, accountId} = await requestAccountSocket(credentials, options);
      this.accountId = accountId;
      await new Promise((resolve, reject) => {
        const ws = this.socket = new this.Socket(url);
        let opened = false;
        const timer = setTimeout(() => fail(new Error('Tempo esgotado ao conectar a conta.')), this.timeout);
        const fail = error => {
          clearTimeout(timer);
          this.close(error);
          reject(error);
          if (opened) this.onDisconnect(error);
        };
        ws.onopen = () => { opened = true; clearTimeout(timer); resolve(); };
        ws.onerror = () => fail(new Error('Falha na conexão da conta.'));
        ws.onclose = () => fail(new Error('Conta desconectada. Confira posições antes de retomar.'));
        ws.onmessage = event => {
          let data;
          try { data = JSON.parse(event.data); } catch { return; }
          const item = this.pending.get(data.req_id);
          if (!item) return;
          clearTimeout(item.timer);
          this.pending.delete(data.req_id);
          if (data.error) {
            const error = new Error(data.error.message || 'Consulta recusada pela Deriv.');
            error.code = data.error.code;
            item.reject(error);
          } else item.resolve(data);
        };
      });
    } finally { this.connecting = false; }
  }
  request(payload) {
    // No transfers, withdrawals, subscriptions or account mutations.
    const operations = {
      balance:['balance'], portfolio:['portfolio'], time:['time'],
      contracts_for:['contracts_for'],
      proposal:['proposal','amount','basis','contract_type','currency','duration','duration_unit','underlying_symbol'],
      buy:['buy','price'], proposal_open_contract:['proposal_open_contract','contract_id']
    };
    const command = Object.keys(operations).find(k => Object.hasOwn(payload, k));
    if (!command || Object.keys(payload).some(k => !operations[command].includes(k))) return Promise.reject(new Error('Operação não permitida neste cliente.'));
    return new Promise((resolve, reject) => {
      if (this.socket?.readyState !== 1) return reject(new Error('Conta desconectada.'));
      const req_id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(req_id);
        const error = new Error(command === 'buy' ? 'Compra sem confirmação. Não repita a ordem; confira as posições da conta.' : 'Tempo esgotado na consulta da conta.');
        error.uncertain = command === 'buy';
        reject(error);
      }, this.timeout);
      this.pending.set(req_id, {resolve, reject, timer, command});
      try { this.socket.send(JSON.stringify({...payload, req_id})); }
      catch { clearTimeout(timer); this.pending.delete(req_id); reject(new Error('Não foi possível enviar a solicitação.')); }
    });
  }
  close(error = new Error('Conexão encerrada.')) {
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      const failure = new Error(item.command === 'buy' ? 'Conexão perdida durante a compra. Confira posições antes de retomar.' : error.message);
      failure.uncertain = item.command === 'buy';
      item.reject(failure);
    }
    this.pending.clear();
    if (this.socket) {
      this.socket.onopen = this.socket.onclose = this.socket.onerror = this.socket.onmessage = null;
      this.socket.close();
      this.socket = null;
    }
  }
}
