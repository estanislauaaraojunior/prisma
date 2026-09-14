from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from functools import partial
from pathlib import Path
import argparse
import json
import os
import urllib.error
import urllib.parse
import urllib.request

DERIV_API = 'https://api.derivws.com/trading/v1/options/accounts'

def load_env(path):
    if not path.exists():
        return
    for raw in path.read_text(encoding='utf-8').splitlines():
        line = raw.strip()
        if not line or line.startswith('#') or '=' not in line:
            continue
        key, value = line.split('=', 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value

def json_response(handler, status, body):
    payload = json.dumps(body).encode('utf-8')
    handler.send_response(status)
    handler.send_header('Content-Type', 'application/json; charset=utf-8')
    handler.send_header('Cache-Control', 'no-store')
    handler.send_header('Content-Length', str(len(payload)))
    handler.end_headers()
    handler.wfile.write(payload)

def deriv_request(url, method, app_id, token):
    request = urllib.request.Request(
        url,
        method=method,
        headers={
            'Authorization': f'Bearer {token}',
            'Deriv-App-ID': app_id,
            'Accept': 'application/json',
        },
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        return response.status, json.loads(response.read().decode('utf-8'))

def select_demo_account(body):
    accounts = body.get('data')
    if not isinstance(accounts, list):
        raise ValueError('A Deriv retornou uma lista de contas inválida.')
    demos = [
        account for account in accounts
        if account.get('account_type') == 'demo'
        and account.get('status') == 'active'
        and isinstance(account.get('account_id'), str)
        and account.get('account_id').isalnum()
    ]
    demos.sort(key=lambda account: (account.get('currency') != 'USD', account.get('account_id')))
    if not demos:
        raise ValueError('Nenhuma conta demo de Options ativa foi encontrada para este token.')
    return demos[0]

class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, '.mjs': 'text/javascript', '.js': 'text/javascript'}

    def do_POST(self):
        if self.path != '/api/deriv/account-socket':
            return super().do_POST()
        app_id = os.environ.get('DERIV_APP_ID', '').strip()
        token = os.environ.get('DERIV_TOKEN', '').strip()
        if not app_id or not token:
            json_response(self, 400, {'error': 'Configure DERIV_APP_ID e DERIV_TOKEN no arquivo .env.'})
            return
        try:
            _, accounts = deriv_request(DERIV_API, 'GET', app_id, token)
            account = select_demo_account(accounts)
            account_id = urllib.parse.quote(account['account_id'], safe='')
            _, otp = deriv_request(f'{DERIV_API}/{account_id}/otp', 'POST', app_id, token)
            url = otp.get('data', {}).get('url')
            if not isinstance(url, str) or not url.startswith('wss://api.derivws.com/trading/v1/options/ws/demo?otp='):
                raise ValueError('A Deriv não retornou uma conexão válida.')
            json_response(self, 200, {'url': url, 'accountId': account['account_id']})
        except urllib.error.HTTPError as error:
            json_response(self, error.code, {'error': f'A Deriv recusou a autenticação (HTTP {error.code}). Confira o .env.'})
        except (urllib.error.URLError, TimeoutError):
            json_response(self, 502, {'error': 'Falha de rede ao autenticar na Deriv.'})
        except Exception as error:
            json_response(self, 400, {'error': str(error)})

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Iniciar o Prisma localmente')
    parser.add_argument('--porta', type=int, default=8000)
    args = parser.parse_args()
    if not 1024 <= args.porta <= 65535:
        parser.error('Escolha uma porta entre 1024 e 65535.')
    base = Path(__file__).resolve().parent
    load_env(base / '.env')
    directory = base / 'dist'
    try:
        server = ThreadingHTTPServer(('127.0.0.1', args.porta), partial(Handler, directory=str(directory)))
    except OSError as error:
        print('Não foi possível iniciar:', error)
        print('Tente outra porta: python3 iniciar.py --porta 8001')
        raise SystemExit(1)
    print(f'Abra no navegador: http://127.0.0.1:{args.porta}')
    print('Para encerrar, pressione Ctrl+C neste terminal.')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('Servidor encerrado.')
    finally:
        server.server_close()
