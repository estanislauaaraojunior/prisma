const {onRequest} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');

const DERIV_API = 'https://api.derivws.com/trading/v1/options/accounts';
const derivAppId = defineSecret('DERIV_APP_ID');
const derivToken = defineSecret('DERIV_TOKEN');
const SESSION_TTL = 5 * 60 * 1000;
let automationState = {
  running: false,
  message: 'Nenhuma sessão demo ativa.',
  trades: 0,
  profit: 0,
  currency: '',
  updatedAt: 0,
  events: []
};

function sendJson(response, status, body) {
  response.status(status).set('Cache-Control', 'no-store').json(body);
}

function publicState() {
  if (automationState.running && Date.now() - automationState.updatedAt > SESSION_TTL) {
    automationState = {...automationState, running:false, message:'Sessão sem atualização recente.', updatedAt:Date.now()};
  }
  return automationState;
}

function cleanEvent(body) {
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 240) : '';
  if (!message) throw new Error('Evento sem mensagem.');
  return {
    id: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
    time: Date.now(),
    message,
    trades: Number.isFinite(Number(body.trades)) ? Number(body.trades) : 0,
    profit: Number.isFinite(Number(body.profit)) ? Number(body.profit) : 0,
    currency: typeof body.currency === 'string' ? body.currency.slice(0, 12) : '',
    running: Boolean(body.running),
    accountId: typeof body.accountId === 'string' ? body.accountId.replace(/[^A-Za-z0-9]/g, '').slice(0, 24) : ''
  };
}

async function derivRequest(url, method, appId, token) {
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Deriv-App-ID': appId,
      Accept: 'application/json'
    },
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

function selectDemoAccount(body) {
  const accounts = body?.data;
  if (!Array.isArray(accounts)) throw new Error('A Deriv retornou uma lista de contas inválida.');
  const demos = accounts.filter(account =>
    account?.account_type === 'demo' &&
    account.status === 'active' &&
    typeof account.account_id === 'string' &&
    /^[A-Za-z0-9]+$/.test(account.account_id)
  );
  demos.sort((a, b) => Number(b.currency === 'USD') - Number(a.currency === 'USD') || a.account_id.localeCompare(b.account_id));
  if (!demos.length) throw new Error('Nenhuma conta demo de Options ativa foi encontrada para este token.');
  return demos[0];
}

exports.derivAccountSocket = onRequest({
  region: 'us-central1',
  secrets: [derivAppId, derivToken],
  cors: false
}, async (request, response) => {
  if (request.method !== 'POST') {
    sendJson(response, 405, {error: 'Método não permitido.'});
    return;
  }
  const appId = derivAppId.value().trim();
  const token = derivToken.value().trim();
  if (!appId || !token) {
    sendJson(response, 400, {error: 'Configure DERIV_APP_ID e DERIV_TOKEN nos secrets do Firebase.'});
    return;
  }
  try {
    const accounts = await derivRequest(DERIV_API, 'GET', appId, token);
    const account = selectDemoAccount(accounts);
    const otp = await derivRequest(`${DERIV_API}/${encodeURIComponent(account.account_id)}/otp`, 'POST', appId, token);
    const url = otp?.data?.url;
    if (typeof url !== 'string' || !url.startsWith('wss://api.derivws.com/trading/v1/options/ws/demo?otp=')) {
      throw new Error('A Deriv não retornou uma conexão válida.');
    }
    sendJson(response, 200, {url, accountId: account.account_id});
  } catch (error) {
    if (error.status) {
      sendJson(response, error.status, {error: `A Deriv recusou a autenticação (HTTP ${error.status}). Confira os secrets.`});
    } else if (error.name === 'TimeoutError' || error.name === 'AbortError' || error.cause?.code) {
      sendJson(response, 502, {error: 'Falha de rede ao autenticar na Deriv.'});
    } else {
      sendJson(response, 400, {error: error.message});
    }
  }
});

exports.automationSession = onRequest({
  region: 'us-central1',
  cors: false,
  maxInstances: 1
}, async (request, response) => {
  if (request.method === 'GET') {
    sendJson(response, 200, publicState());
    return;
  }
  if (request.method !== 'POST') {
    sendJson(response, 405, {error: 'Método não permitido.'});
    return;
  }
  try {
    const event = cleanEvent(request.body || {});
    automationState = {
      running: event.running,
      message: event.message,
      trades: event.trades,
      profit: event.profit,
      currency: event.currency,
      accountId: event.accountId,
      updatedAt: event.time,
      events: [event, ...automationState.events].slice(0, 80)
    };
    sendJson(response, 200, automationState);
  } catch (error) {
    sendJson(response, 400, {error: error.message});
  }
});
