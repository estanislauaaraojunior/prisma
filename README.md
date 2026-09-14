# Prisma

Prisma e um laboratorio local para observar candles historicos, calcular indicadores tecnicos e, opcionalmente, executar uma automacao experimental de contratos Alta/Baixa na Deriv usando somente conta demo de Options.

O sistema roda no proprio computador com Node.js e arquivos estaticos em `dist/`. A pagina inicial funciona com uma serie matematica sem moeda real, permite importar CSV localmente e pode consultar dados publicos da Deriv para comparar indices sinteticos.

## Componentes

- `iniciar.mjs`: servidor HTTP local em `127.0.0.1`, carrega `.env` e expoe o endpoint local `/api/deriv/account-socket` para autenticar a conta demo sem enviar o token ao navegador.
- `functions/index.js`: Cloud Function em Node.js com o mesmo endpoint para uso no Firebase Hosting.
- `firebase.json`: publica `dist/` no Firebase Hosting e redireciona `/api/deriv/account-socket` para a Cloud Function.
- `dist/index.html`: interface principal.
- `dist/app.mjs`: importacao CSV, controles da analise, graficos, ranking publico da Deriv e troca do grafico para o simbolo do contrato aberto.
- `dist/math.mjs`: parsing de candles, validacoes e calculos de EMA, RSI, ATR, DMI/ADX, MACD, Bollinger e VWAP por candles.
- `dist/deriv.mjs`: cliente WebSocket publico da Deriv, normalizacao de candles fechados, ranking por ADX e consulta de um simbolo especifico.
- `dist/deriv-account.mjs`: descoberta de conta demo, geracao de conexao OTP e cliente autenticado com lista restrita de operacoes permitidas.
- `dist/automation.mjs`: motor da sessao demo, validacao de limites, escolha de sinal, cotacao, compra, acompanhamento da liquidacao e controle de pendencias.
- `dist/automation-ui.mjs`: conexao da conta, botoes da sessao, bloqueio de abas, log de eventos e conferencia de pendencias.
- `tests/`: testes matematicos em Node.js e testes de integracao no navegador com respostas simuladas.

## Como Executar

1. Instale Node.js 18 ou superior.
2. Na pasta do projeto, rode `npm start`.
3. Abra `http://127.0.0.1:8000`.

Se a porta estiver ocupada, use outra:

```sh
npm start -- --porta 8001
```

A pagina deve ser aberta pelo servidor local. Abrir `dist/index.html` diretamente pode impedir o carregamento dos modulos JavaScript.

## Dados e Analise

O exemplo inicial e didatico e nao representa cotacao real. A importacao aceita CSV com `timestamp,open,high,low,close` e volume opcional. O arquivo e lido no navegador, sem upload.

A busca publica da Deriv consulta somente `Continuous Volatility Indices`, `Jump Indices` e `Step Indices` do mercado `synthetic_index`. O ranking usa 500 candles fechados, ADX de 14 periodos e horario de corte fornecido pela Deriv. O maior ADX e carregado no grafico. Essa busca nao faz login, nao usa token e nao envia CSV para a Deriv.

## Automacao Demo

A automacao compra somente contratos Alta/Baixa (`CALL`/`PUT`) em conta demo de Options. Conta real e recusada por validacao de tipo de conta e pela URL WebSocket demo retornada pela Deriv.

Para conectar:

1. Crie uma aplicacao PAT em `https://developers.deriv.com`.
2. Gere um token PAT com permissao `trade`.
3. Copie `.env.example` para `.env`.
4. Preencha `DERIV_APP_ID` e `DERIV_TOKEN`.
5. Inicie `npm start` e clique em `Conectar conta demo`.

O token fica no servidor local e e usado apenas em requisicoes HTTPS para localizar uma conta demo ativa e pedir uma URL WebSocket OTP de uso unico. O navegador recebe a URL temporaria e o ID da conta demo selecionada.

## Como a Abertura de Contratos Funciona

1. O usuario conecta a conta demo e inicia manualmente a sessao.
2. A interface usa Web Locks para evitar duas sessoes na mesma conta no mesmo navegador/origem.
3. O motor valida entrada, perda maxima, meta, maximo de operacoes, duracao, ADX minimo e configuracao de martingale.
4. Antes de operar, consulta `portfolio` e bloqueia a sessao se houver contrato aberto na conta.
5. A cada novo candle, procura um sinal nas tres familias autorizadas. No modo automatico, compara 1m, 5m, 15m e 1h e escolhe o melhor tempo pelo score de confluencia, com desempate pelo ADX.
6. Para cada candidato, calcula ADX/DMI, EMA, MACD, RSI e ATR com os parametros padrao.
7. Abre `CALL` quando `+DI > -DI`, o fechamento esta acima da EMA, o MACD confirma alta, o RSI esta em zona compradora e o ATR esta dentro do limite de volatilidade.
8. Abre `PUT` quando `-DI > +DI`, o fechamento esta abaixo da EMA, o MACD confirma baixa, o RSI esta em zona vendedora e o ATR esta dentro do limite de volatilidade.
9. Consulta `contracts_for` e so continua se existir contrato intraday Alta/Baixa compativel com a duracao configurada.
10. Verifica novamente portfolio e saldo.
11. Solicita uma cotacao `proposal` com `basis: "stake"`, valor da proxima entrada, moeda da conta, duracao em minutos e simbolo escolhido.
12. Revalida o horario: a cotacao precisa pertencer ao candle atual e ter `spot_time` recente.
13. Grava uma pendencia no `localStorage` antes de enviar `buy`.
14. Envia uma unica compra com `buy: quote.id` e `price` igual a entrada configurada.
15. Salva o `contract_id`, atualiza o grafico para o simbolo comprado e acompanha `proposal_open_contract` ate `is_sold = 1`.
16. Ao liquidar, soma o lucro/prejuizo da sessao, remove a pendencia e decide se continua ou encerra pelos limites.

Depois da primeira compra, se o contrato liquidar e a tendencia continuar na mesma direcao com a mesma confluencia de MACD, RSI e ATR, o sistema reavalia primeiro o mesmo simbolo. O ranking completo so e consultado novamente quando a tendencia muda, perde forca suficiente para o ADX minimo, perde confluencia ou o contrato deixa de ser compativel.

O martingale e opcional e vem desligado por padrao. Quando ligado, uma liquidacao negativa aumenta a proxima entrada pelo multiplicador configurado, limitada ao numero maximo de passos; uma liquidacao positiva reseta a entrada para o valor base. O limite de perda considera tambem essa proxima entrada aumentada.

Nao ha operacao simultanea, conta real, transferencia, saque, assinatura WebSocket, repeticao automatica de compra incerta, backtest de rentabilidade ou calculo de probabilidade de acerto.

## Pendencias e Falhas

Uma compra e marcada localmente antes do envio. Se a resposta de `buy` for incerta por timeout ou queda de conexao, o sistema mantem a pendencia e nao tenta comprar de novo. A proxima sessao fica bloqueada ate o usuario conferir historico/posicoes na Deriv e concluir a conferencia na interface.

O botao `Parar novas entradas` impede novas compras ainda nao enviadas. Se a compra ja foi enviada, o sistema continua acompanhando ate a liquidacao. Fechar a pagina ou perder conexao nao cancela contratos existentes na Deriv.

## Testes

Teste matematico em Node.js:

```sh
node --test tests/math.test.mjs
```

Testes no navegador:

```sh
npm start -- --porta 8002
```

Depois abra:

- `http://127.0.0.1:8002/tests/deriv.browser.html`
- `http://127.0.0.1:8002/tests/automation.browser.html`

As paginas usam respostas simuladas e nao enviam ordens reais.

## Firebase

O deploy usa Firebase Hosting para os arquivos de `dist/` e Cloud Functions para o endpoint autenticado da Deriv.

Configure os secrets antes do deploy:

```sh
firebase functions:secrets:set DERIV_APP_ID
firebase functions:secrets:set DERIV_TOKEN
```

Depois publique:

```sh
firebase deploy --only functions,hosting
```
