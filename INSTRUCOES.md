# Prisma local

Esta cópia contém a página atual com identificação de ativo, importação local de CSV, gráficos e cálculos sem IA. O exemplo inicial é uma série matemática, sem moeda real. A busca na Deriv consulta dados públicos pela API, sem login ou token. A seção de automação permite executar contratos de Alta/Baixa exclusivamente em conta demo de Options, mediante autenticação e início manual da sessão. A versão publicada está em https://prisma-b4c64.web.app.

## Requisito

Node.js 18 ou superior para rodar localmente; a Cloud Function publicada usa Node.js 22. Também é necessário um navegador moderno. Não é necessário instalar bibliotecas externas para rodar localmente. O exemplo e a importação CSV funcionam sem internet. A consulta à Deriv requer internet.

## Abrir

1. Extraia o ZIP. Abra a pasta prisma-local que contém `iniciar.mjs`.
2. Abra um terminal nessa pasta.
3. Execute `npm start`.
4. Acesse http://127.0.0.1:8000 no navegador.

Mantenha o terminal aberto enquanto usa a página. Encerre com Ctrl+C.
Se a porta estiver ocupada, use `npm start -- --porta 8001` e abra http://127.0.0.1:8001.

Abra a página pelo endereço local, pois módulos JavaScript podem não carregar ao clicar diretamente no index.html.

## Abrir no Firebase

Acesse https://prisma-b4c64.web.app. O Firebase Hosting serve os arquivos de `dist/` e redireciona `/api/deriv/account-socket` para a Cloud Function `derivAccountSocket` em `us-central1`.

Para publicar novamente:

```sh
firebase deploy --only functions,hosting --project prisma-b4c64
```

Se mudar somente arquivos do site, use `firebase deploy --only hosting --project prisma-b4c64`. Se mudar somente `functions/index.js` ou `functions/package.json`, use `firebase deploy --only functions --project prisma-b4c64`.

## Seus dados

O CSV é lido no navegador, sem upload. Amostra, nome do ativo e leituras ficam em memória e são apagados ao recarregar a página. O servidor atende somente no próprio computador (127.0.0.1).

## Editar

- dist/index.html: estrutura e textos.
- dist/style.css: aparência.
- dist/app.mjs: controles e gráficos.
- dist/math.mjs: cálculos e importação.

Após salvar alterações, atualize o navegador. Os testes matemáticos opcionais podem ser executados com Node.js: `node --test tests/math.test.mjs`.

## Buscar na Deriv

1. Abra o painel e escolha o intervalo: 1, 5, 15 ou 60 minutos.
2. Clique em **Buscar na Deriv**. O painel consulta exclusivamente Continuous Volatility Indices (incluindo as variantes de 1 segundo), Jump Indices e Step Indices abertos disponibilizados pela API. O filtro usa os submercados `random_index`, `jump_index` e `step_index` do mercado `synthetic_index`.
3. O ranking compara o ADX de 14 períodos em 500 candles fechados por ativo, com o mesmo horário de corte obtido do servidor Deriv. O maior ADX fica em primeiro lugar e seus candles são carregados automaticamente.
4. A direção vem de +DI e −DI. “Força” significa força de tendência do ativo; não é força relativa de uma moeda isolada, previsão ou recomendação de operação. Empates são ordenados pelo símbolo.

O ranking tem parâmetros fixos, independentes dos parâmetros editáveis do gráfico. Ativos com histórico insuficiente, último candle desatualizado ou erro da API são excluídos e listados no resultado. Lacunas históricas de sessões são preservadas. Se nenhum ativo dessas três famílias puder ser comparado, o painel informa a indisponibilidade e preserva a amostra anterior. O ranking reúne as três famílias e identifica a família de cada ativo. Forex, Boom/Crash, Range Break e outros grupos ficam fora da busca. A consulta é pontual: clique novamente para atualizar. Os candles da Deriv não fornecem volume nesta integração, portanto VWAP fica indisponível.

A conexão do ranking usa `wss://api.derivws.com/trading/v1/options/ws/public` e apenas `time`, `active_symbols` e `ticks_history`. É encerrada após a busca. Nenhum arquivo CSV é enviado à Deriv. O nome do ativo consultado vem da API e não pode ser editado. A busca considera somente os ativos que essa API disponibiliza, não todo o catálogo de outras plataformas Deriv.

- `dist/deriv.mjs`: cliente público, validação dos candles e ranking.
- Documentação oficial: https://developers.deriv.com/docs/options/ws-public/ e https://developers.deriv.com/docs/data/ticks-history/

## Testes no navegador

Execute `npm start -- --porta 8002` na pasta do projeto e abra `http://127.0.0.1:8002/tests/deriv.browser.html`. A página executa os testes matemáticos existentes, testes da integração com respostas simuladas e verifica a interface. O resultado deve começar com `PASS`. Encerre esse servidor ao terminar; para o uso normal, continue usando `npm start`.

## Automação em conta demo

A automação opera somente as três famílias autorizadas. Conta real é recusada pela validação do tipo de conta e pela conferência do endereço WebSocket retornado pela Deriv. A conexão pública usada no ranking continua separada da conexão autenticada.

### Conectar

1. No portal https://developers.deriv.com, registre uma aplicação do tipo PAT e gere um token com permissão `trade`. Esta integração utiliza a API atual: App IDs e tokens antigos não são intercambiáveis.
2. Copie `.env.example` para `.env` e preencha **DERIV_APP_ID** e **DERIV_TOKEN** (token PAT). O arquivo `.env` fica fora do Git. Ao iniciar com `npm start`, o servidor local usa essas credenciais para consultar `GET /trading/v1/options/accounts` e localizar automaticamente uma conta demo de Options ativa. A conta MT5 não serve para este fluxo.
3. Clique em **Conectar conta demo**. O sistema utiliza internamente o ID da conta localizada para pedir uma URL autenticada de uso único (OTP), verifica que ela aponta para o ambiente demo e consulta o saldo/moeda.
4. Revise as regras e clique em **Iniciar sessão demo**. Conectar não compra contratos. A sessão depende de esta página e do computador permanecerem ativos.

O token é usado pelo servidor local em um cabeçalho HTTPS para a Deriv e não é enviado ao JavaScript do navegador. Não há autenticação automática depois de recarregar a página.

### Estratégia experimental

A regra da automação fica em `dist/automation.mjs` e reutiliza os cálculos de `dist/math.mjs`. Ela utiliza 500 candles fechados por ativo. No modo automático, compara 1 minuto, 5 minutos, 15 minutos e 1 hora, então escolhe o melhor sinal pelo score de confluência, com desempate pelo ADX. Também é possível travar a sessão em um desses tempos. Esses candles são obtidos pela mesma busca pública das três famílias autorizadas. Configurações do gráfico não alteram a estratégia da automação.

Para cada candidato, a automação calcula ADX/DMI, EMA, MACD, RSI e ATR com os parâmetros padrão e aplica o ADX mínimo configurado na sessão. Quando +DI é maior que -DI, o fechamento está acima da EMA, o MACD confirma alta, o RSI está em zona compradora e o ATR está dentro do limite de volatilidade, a direção elegível é Alta (`CALL`). Quando -DI é maior que +DI, o fechamento está abaixo da EMA, o MACD confirma baixa, o RSI está em zona vendedora e o ATR está dentro do limite de volatilidade, a direção elegível é Baixa (`PUT`). Caso contrário, não há entrada.

A busca inicial retorna os ativos ordenados pelo maior ADX. A automação percorre esse ranking e escolhe o candidato com melhor score de confluência entre os que tenham sinal válido e contrato de Alta/Baixa compatível com a duração configurada; em empate, usa o maior ADX. Depois que um contrato é liquidado, a automação reavalia primeiro o mesmo símbolo; se ADX/DMI, preço, MACD, RSI e ATR continuarem validando a mesma direção, ela mantém o símbolo e abre a próxima entrada nele. O ranking completo só é consultado novamente quando a tendência fica contrária, perde força suficiente para o ADX mínimo, perde confluência ou deixa de ter contrato compatível. Não há Bollinger como filtro de entrada, reconhecimento de padrões, backtest de rentabilidade ou cálculo de probabilidade de acerto.

Mantidos: início manual em conta demo, uma operação por vez, uma entrada por candle em cada tempo avaliado, validação de contrato/duração, saldo, cotação e limites da sessão. Martingale é opcional e vem desligado por padrão; quando ligado, aumenta a próxima entrada após perda pelo multiplicador configurado, até o máximo de passos, e reseta após ganho. Padrões: busca automática de tempo, ADX mínimo 25, entrada 1, duração 1 minuto, perda máxima 5, meta 5, máximo 10 contratos, martingale desligado, multiplicador 2 e máximo 2 passos. Reiniciar manualmente zera os contadores da sessão.

Os testes verificam cálculos, autenticação, bloqueios e fluxo de compra com dados artificiais; não medem probabilidade de acerto. Não foi acrescentado volume/VWAP à decisão porque a integração não fornece volume.

### Fluxo de abertura de contratos

A compra é sempre iniciada pelo usuário, depois da conexão demo e do clique em **Iniciar sessão demo**. O botão de conexão apenas autentica e consulta saldo; ele não abre contratos.

1. A interface cria um bloqueio com Web Locks para a chave da conta demo. Esse bloqueio evita duas sessões na mesma conta, aba/origem e navegador.
2. O motor valida os limites informados: entrada, perda máxima, meta, quantidade máxima de operações, duração em minutos e ADX mínimo.
3. Antes de procurar sinal, consulta `portfolio`. Se existir contrato aberto na conta demo, a sessão é recusada.
4. O motor aguarda candles novos nos tempos avaliados. Ele não abre mais de uma entrada no mesmo candle de corte de cada tempo.
5. Se já houve uma compra liquidada na sessão, o sistema tenta primeiro reavaliar o mesmo símbolo pelo histórico público atualizado. Se a direção continuar igual, o ADX ainda respeitar o mínimo, MACD/RSI/ATR ainda confirmarem e houver contrato compatível, o símbolo é mantido.
6. Quando não há símbolo mantido, a busca pública percorre Continuous Volatility, Jump e Step, ordena por ADX e testa os candidatos nessa ordem.
7. O sinal elegível é `CALL` quando `+DI > -DI`, o fechamento está acima da EMA, o MACD confirma alta, o RSI está em zona compradora e o ATR está dentro do limite de volatilidade. O sinal elegível é `PUT` quando `-DI > +DI`, o fechamento está abaixo da EMA, o MACD confirma baixa, o RSI está em zona vendedora e o ATR está dentro do limite de volatilidade. Fora dessas condições, não há entrada.
8. Para o candidato com sinal, a conta autenticada consulta `contracts_for`. A compra só segue se houver contrato intraday do tipo `CALL` ou `PUT` que cubra a duração configurada.
9. Antes da cotação, o motor consulta novamente `portfolio` e depois `balance`. A moeda retornada precisa ser a mesma moeda da conexão e o saldo precisa cobrir a entrada.
10. A cotação é solicitada com `proposal`, usando `amount` igual à próxima entrada calculada, `basis: "stake"`, `duration_unit: "m"`, o tipo `CALL`/`PUT` e o símbolo escolhido.
11. A cotação precisa ter ID, preço válido, preço menor ou igual à entrada e `spot_time` recente. O sistema consulta `time` novamente e descarta a entrada se o candle mudou ou se a cotação ficou velha.
12. Antes de enviar `buy`, grava em `localStorage` um marcador pendente com conta, símbolo, tipo, entrada, horário e `contractId: null`.
13. A compra é enviada uma única vez com `buy` igual ao ID da cotação e `price` igual à entrada configurada.
14. Se a Deriv confirma a compra, o `contract_id` é salvo no mesmo marcador, o contador de operações aumenta e o gráfico da página é atualizado com os candles do símbolo comprado.
15. O contrato é acompanhado com `proposal_open_contract` até `is_sold` ser `1`. Ao liquidar, o lucro/prejuízo é somado ao resultado da sessão e a pendência local é removida.
16. A sessão continua somente se ainda estiver dentro dos limites de perda, meta e quantidade máxima. Caso contrário, encerra novas entradas.

Se `buy` falhar com uma recusa explícita da API, a pendência local é removida porque a compra foi rejeitada. Se houver timeout, queda de conexão ou resposta incerta, a pendência permanece e o sistema não repete a ordem automaticamente. A liberação exige conferência manual na Deriv pela seção **Conferir compra pendente após interrupção**.

### Parada, falhas e pendências

**Parar novas entradas** impede compras ainda não enviadas. Uma compra que já foi enviada continua sendo acompanhada até a liquidação. O botão não vende ou cancela um contrato existente. Ao fechar a página ou perder a conexão, contratos já comprados continuam na Deriv.

Antes de cada compra, é registrado localmente um marcador com conta, símbolo, tipo, valor, horário e, quando confirmado, ID do contrato. Nenhum token fica nesse registro. Em caso de resposta incerta, o sistema nunca repete a compra automaticamente. Um marcador pendente bloqueia outra sessão, inclusive após recarregar a página. Confira o histórico na Deriv e use a seção de conferência; ela exige confirmação manual e ausência de posições abertas. Quando há ID conhecido, também verifica se esse contrato está liquidado.

O bloqueio de abas usa Web Locks no mesmo navegador/origem. Ele não impede operações por outros dispositivos, perfis, portas locais ou plataformas. A conta é consultada para posições abertas antes de iniciar e antes de comprar; evite operar nela em paralelo durante a sessão. Se o armazenamento local estiver indisponível, a compra não é enviada. Não apague o armazenamento enquanto houver pendência.

### Arquivos e testes

- `dist/deriv-account.mjs`: autenticação PAT/OTP e solicitações autenticadas, sem repetição automática de ordens.
- `dist/automation.mjs`: sinais, limites, compra, liquidação e pendência.
- `dist/automation-ui.mjs`: conexão e controles da sessão.
- Abra `http://127.0.0.1:8002/tests/automation.browser.html` usando o servidor de testes descrito acima para executar os testes de automação com respostas simuladas. Nenhuma ordem é enviada à Deriv nesses testes.

Referências oficiais: https://developers.deriv.com/docs/options/websocket/ e https://developers.deriv.com/docs/workflows/.

A conexão não exige ID de conta ou moeda digitados pelo usuário. Quando há várias contas demo ativas, a seleção prefere USD e depois ordena por ID para ser estável. A conta escolhida aparece no estado da conexão. Se não houver demo ativa, a conexão é interrompida; uma conta real nunca é selecionada. Referência: https://developers.deriv.com/docs/options/get-accounts/.
