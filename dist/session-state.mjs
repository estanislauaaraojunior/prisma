const ENDPOINT = '/api/automation/session';

export async function publishSessionEvent(item, {accountId = '', currency = '', running = false, fetcher = globalThis.fetch} = {}) {
  const body = {
    message: item.message,
    trades: item.trades,
    profit: item.profit,
    currency,
    accountId,
    running
  };
  const response = await fetcher(ENDPOINT, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify(body),
    cache: 'no-store',
    credentials: 'same-origin'
  });
  if (!response.ok) throw new Error('Não foi possível publicar o estado da sessão.');
  return response.json();
}

export async function readSessionState({fetcher = globalThis.fetch} = {}) {
  const response = await fetcher(ENDPOINT, {cache:'no-store', credentials:'same-origin'});
  if (!response.ok) throw new Error('Não foi possível ler o estado da sessão.');
  return response.json();
}
