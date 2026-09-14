import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {extname, join, normalize, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const DERIV_API = 'https://api.derivws.com/trading/v1/options/accounts';
const base = fileURLToPath(new URL('.', import.meta.url));
const publicDir = resolve(base, 'dist');

const types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml; charset=utf-8']
]);

function loadEnv(path) {
  if (!existsSync(path)) return;
  const text = readFile(path, 'utf8');
  return text.then(content => {
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#') || !line.includes('=')) continue;
      const index = line.indexOf('=');
      const key = line.slice(0, index).trim();
      const value = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key && process.env[key] == null) process.env[key] = value;
    }
  });
}

function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(payload)
  });
  response.end(payload);
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

async function handleAccountSocket(_request, response) {
  const appId = (process.env.DERIV_APP_ID || '').trim();
  const token = (process.env.DERIV_TOKEN || '').trim();
  if (!appId || !token) {
    sendJson(response, 400, {error: 'Configure DERIV_APP_ID e DERIV_TOKEN no arquivo .env.'});
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
      sendJson(response, error.status, {error: `A Deriv recusou a autenticação (HTTP ${error.status}). Confira o .env.`});
    } else if (error.name === 'TimeoutError' || error.name === 'AbortError' || error.cause?.code) {
      sendJson(response, 502, {error: 'Falha de rede ao autenticar na Deriv.'});
    } else {
      sendJson(response, 400, {error: error.message});
    }
  }
}

function safeStaticPath(pathname) {
  const decoded = decodeURIComponent(pathname);
  if (decoded.startsWith('/tests/')) {
    const testFile = normalize(join(base, decoded));
    const testsDir = resolve(base, 'tests');
    if (testFile === testsDir || !testFile.startsWith(testsDir + sep)) return null;
    return testFile;
  }
  const requested = decoded === '/' ? '/index.html' : decoded;
  const file = normalize(join(publicDir, requested));
  if (file !== publicDir && !file.startsWith(publicDir + sep)) return null;
  return file;
}

async function handleStatic(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  const file = safeStaticPath(url.pathname);
  if (!file) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }
  try {
    const content = await readFile(file);
    response.writeHead(200, {'Content-Type': types.get(extname(file)) || 'application/octet-stream'});
    response.end(content);
  } catch {
    response.writeHead(404, {'Content-Type': 'text/plain; charset=utf-8'});
    response.end('Arquivo não encontrado.');
  }
}

function parsePort() {
  const args = process.argv.slice(2);
  const index = args.indexOf('--porta');
  const value = index >= 0 ? args[index + 1] : process.env.PORT || '8000';
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    console.error('Escolha uma porta entre 1024 e 65535.');
    process.exit(1);
  }
  return port;
}

await loadEnv(resolve(base, '.env'));

const port = parsePort();
const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url?.split('?')[0] === '/api/deriv/account-socket') {
    handleAccountSocket(request, response);
    return;
  }
  if (request.method === 'GET' || request.method === 'HEAD') {
    handleStatic(request, response);
    return;
  }
  response.writeHead(405, {'Content-Type': 'text/plain; charset=utf-8'});
  response.end('Método não permitido.');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`Abra no navegador: http://127.0.0.1:${port}`);
  console.log('Para encerrar, pressione Ctrl+C neste terminal.');
});

server.on('error', error => {
  console.error('Não foi possível iniciar:', error.message);
  console.error('Tente outra porta: npm start -- --porta 8001');
  process.exit(1);
});
