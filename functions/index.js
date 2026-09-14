const {onRequest} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');

const DERIV_API = 'https://api.derivws.com/trading/v1/options/accounts';
const derivAppId = defineSecret('DERIV_APP_ID');
const derivToken = defineSecret('DERIV_TOKEN');

function sendJson(response, status, body) {
  response.status(status).set('Cache-Control', 'no-store').json(body);
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
