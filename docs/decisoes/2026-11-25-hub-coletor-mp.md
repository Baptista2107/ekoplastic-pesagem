# Hub do almoxarifado no coletor do Bruno: app "Ekoplastic MP" (25/11/2026)

## Pedido
Gustavo, 25/11/2026: "pro coletor do Bruno vou precisar de um hub de aplicativos
onde ele consegue fazer entrada e retirada, mapeamento e inventário; nesse hub
pra ele não ter que usar link nem nada". No mesmo dia ele acrescentou o
lançamento de PA (produto acabado).

O coletor é o CMX Supply TC60 (Android 14), com leitor embutido.

**Situação:** está no ramo `coletor-hub-teste`. Não foi para o main nem para o
Mini PC, e o APK não foi instalado em nenhum aparelho. Nada liga sem a validação
do Gustavo.

## Desenho
Um terceiro app, gerado pelo mesmo código Java dos outros dois (`android/`).
O `build.sh` agora tem `VARIANTE=mp`.

- **Ekoplastic MP** (`br.com.ekoplastic.mp`, v2.0). Instala ao lado do
  Coletor e do Inventário, sem substituir nenhum dos dois.
- Abre em `/hub-mp.html`, que tem 7 botões grandes (eram 5; o Gustavo pediu
  "retorno também" e "residuo" no mesmo dia):
  - Entrada → `/mp-recebimento-retorno.html?aba=recebimento`
  - Retorno → `/mp-recebimento-retorno.html?aba=retorno` (a mesma página; o
    `?aba=` escolhe a aba e a senha, como o toque na aba RETORNO já fazia)
  - Retirada → `/mp-retirada.html`
  - Resíduos → `/outras-pesagens.html` (borra, varredura, pó, aparas)
  - Mapeamento → `/enderecamento.html`
  - Inventário → `/inventario.html`
  - Produto Acabado → `/produto-acabado.html`
- O hub não pede senha e não grava nada. Cada tela continua pedindo o PIN dela,
  como no Mini PC: Entrada, Retorno, Retirada e Resíduos pedem a permissão `mp`, Mapeamento e PA
  pedem `pa`, e o Inventário não pede PIN. No botão aparece "● em andamento"
  quando há sessão aberta daquele tipo, em qualquer aparelho. A informação vem
  de `GET /sessoes/abertas`, que só lê.
- A navegação fica presa ao hub e às telas dele, sem barra de endereço e sem link
  externo. O que levaria a outra página do Mini PC (🏠, ✕, "voltar ao menu" do
  PIN, 📦 da MP) volta ao hub.
- Voltar do Android: fecha a janela que estiver aberta, usando o botão
  Cancelar/Voltar/✕ dela e nunca o Confirmar. Sem janela aberta, aciona o
  "← Voltar" da própria tela (inventário). Se não houver nenhum dos dois, volta
  ao hub. Se o teclado da senha estiver na frente, também volta ao hub. A regra
  está em `android/app/src/main/assets/voltar.js`, que vale para os três apps:
  nos dois de antes o comportamento continua igual.
- A lista de botões fica em `public/hub-mp.js` e a lista de páginas que o app
  abre fica no `build.sh`. O teste `testes/hub-coletor.js` confere que as duas
  batem.

## O que mudou nas telas para funcionar no coletor
Nenhuma regra de negócio mudou. São estas mudanças:

1. **Entrada: peso da balança.** A tela lia `http://localhost:3000/balanca/raw`.
   No coletor, "localhost" é o próprio coletor, e o peso nunca chegava. Passou a
   usar o endereço relativo `/balanca/raw`. No monitor do Mini PC o resultado é
   o mesmo. No coletor, quem responde é o Mini PC, então o peso que aparece é o
   da balança dele.
2. **Entrada e Retirada: leitor do coletor.** As duas telas liam só pelo
   leitor-teclado, que ignora tecla dentro de campo de texto. O app mantém um
   campo invisível em foco para receber o leitor, então nenhum bipe chegava. As
   duas ganharam `onLeu(codigo)`, que o app chama a cada leitura. A função tem
   as mesmas travas do leitor-teclado: teclado da senha na tela, campo de
   verdade em foco e teclado "Digitar código" aberto (que avisa "NÃO saiu"). O
   código vai para o mesmo `processarBipeRaw`/`processarBipe`. No Mini PC
   ninguém chama essa função.
3. **Entrada e Retirada: layout.** As duas foram feitas para o monitor. Em
   360 px a coluna da etiqueta, a lista e o FINALIZAR ficavam cortados. Elas
   passaram a carregar o `celular.css` e viram uma coluna só, que rola. A regra
   vale só abaixo de 900 px, então o monitor do Mini PC não muda (medido a
   1366 px). Na Retirada, o menu lateral (RETIRADA / Voltar) some abaixo de
   900 px, porque a 🏠 faz o mesmo. Abaixo de 400 px o relógio do cabeçalho
   some, porque o coletor já mostra a hora.
4. **Produto Acabado: não pular para o menu.** O `seguranca-saida.js` reabre
   qualquer tela de processo pelo menu (`/?tela=…`), e o app bloqueia o menu.
   Agora, quando o navegador é o app (user-agent `EkoColetor/…`), esse arquivo
   não faz nada: não reabre, não cria o 🔒 de sair nem trata o ESC. No PC e no
   celular pelo navegador continua como antes.

5. **Entrada: aba Retorno de produção.** Fora do quadro da MP (no app e no
   celular), a Entrada mostra as abas RECEBIMENTO | RETORNO DE PRODUÇÃO. A
   senha, o responsável e a conferência de "sessão de outro" vêm da aba que está
   na URL. Tocar RETORNO só trocava o modo e deixava o retorno com a senha do
   recebimento (achado do revisor). Agora a troca reabre a tela com `?aba=` da
   aba escolhida e pede a senha do Retorno. No Mini PC essas abas ficam
   escondidas e nada muda.

O Mapeamento e o Inventário já cabiam em 360 px e não mudaram.

## Defeito de 18/11 do PA, medido abrindo pelo hub
O caso: alguém abre o PA num aparelho, escolhe o turno e ainda não lança nada.
Depois, outro aparelho abre o PA.

O `restaurarSessaoAberta()` do `produto-acabado.html` cancela toda sessão de
PA aberta sem item, sem olhar de quem é nem de qual aparelho veio. Medido com o
servidor de verdade (banco de teste), abrindo o PA pelo hub como o coletor abre
(`testes/navegador/hub_coletor.py`, item 7):

| Situação no outro aparelho | Coletor abre PA pelo hub, teclado da senha na tela | Coletor digita a senha |
|---|---|---|
| Sessão aberta, 0 item | continua aberta | **CANCELADA** |
| Sessão aberta, 1 item | continua aberta | continua aberta, mas o **coletor retoma essa sessão** e passa a lançar nela |

Então o caso acontece (medido uma vez, no banco de teste). Pela leitura do
código, ele se repete toda vez que o Bruno entra no PA com a senha enquanto
houver turno escolhido e vazio em outro aparelho (INFERIDO). Medimos também um
segundo efeito, que vem da mesma função: com a sessão do outro já tendo item, o
coletor entra nela, e o que o Bruno lançar vai para o turno e a data que o
outro escolheu.

Abrir o hub ou tocar no botão PA sem digitar a senha não cancela nada, porque a
função só roda depois da senha.

**Não foi corrigido**: o pedido do PA veio com a ordem de não mexer nessa regra
neste commit.
A correção fica para um commit separado, com validação do Gustavo.

## Tela do hub no TC60 (25/11, depois de instalado)
Gustavo: "não tá legal de ver no android do TC60". O hub já cabia na largura,
mas tinha texto de 12 a 14 px e cores abaixo de 7:1 de contraste. Agora:
uma coluna de 7 botões que enchem a tela, texto ≥ 16 px, contraste ≥ 7:1
(também com o dedo em cima), status numa etiqueta cheia ao lado do nome
("● Conectado" / "✕ Sem conexão", vermelho cheio). Com sessão aberta, o
"● N em andamento" toma o lugar do subtítulo, para o botão não crescer. Cabe
sem rolar a 360×648 (tela do TC60 com as barras do Android) e a 690; a
560 px rola, mas nada sai do botão. Medido por
`testes/navegador/hub_tc60.py`; não visto no aparelho.

## O que ficou fora
- A correção do defeito do PA (acima).
- Ajustar o tamanho de texto ou de toque dentro das telas além do layout. O
  `celular.css` já leva todo botão a 44 px.
- Instalar, pôr no Drive, mudar o main ou o Mini PC.

## O que não foi medido
- **Nada foi testado no TC60 de verdade.** Os testes rodam no Chromium da VPS
  com 360 px de largura e o user-agent do app. Isso imita a WebView, mas não é
  ela. Ficaram sem medir no aparelho:
  - se o aviso (broadcast) do leitor chega ao `onLeu` da Entrada e da Retirada;
  - se o `location.href` da 🏠 volta ao hub;
  - se o Voltar do Android fecha cada janela.
- Se o PIN do Bruno no Mini PC tem as permissões `mp` **e** `pa`. Sem `pa`, ele
  não entra no Mapeamento nem no PA. Não olhamos o banco do Mini PC.
- Onde o Bruno fica na hora de pesar. O peso que aparece no coletor é o da
  balança do Mini PC, e a etiqueta sai na impressora do Mini PC
  (`POST /print/etiqueta`, testado). O coletor não pesa nem imprime sozinho.
- Duas pessoas na mesma tela ao mesmo tempo (Mini PC e coletor). A caixa
  "sessão de outro" das telas da MP já existe. Não testamos com dois aparelhos
  de verdade.
- Bipe com o campo de peso em foco, na Entrada. O leitor do app não lê
  enquanto um campo de verdade está em foco, igual ao leitor-teclado do Mini PC.
  Se o TC60 também "digitar" o código, ele cai dentro do campo de peso. No
  Mini PC acontece o mesmo; no coletor, onde o dedo fica no campo, pode
  acontecer mais. Precisa ser visto no aparelho antes de decidir.
- Se o coletor tem internet. A prévia do código de barras na Entrada usa
  JsBarcode de um CDN. Sem internet, falta só a prévia: a impressão é feita no
  servidor.

## Testes
- `testes/hub-coletor.js` (Node, entra no `rodar-todos.js`): botões do hub,
  lista do app igual à do hub, `voltar.js` com documento de mentira, PA não pula
  para o menu no app, balança relativa, `onLeu` com as travas e CSS só abaixo de
  900 px. Rodado contra o main: 8 itens das telas falham e a parte do app não
  carrega. Mutação no `voltar.js` (apertar Confirmar e ignorar o teclado da
  senha): 3 falhas.
- `testes/navegador/hub_coletor.py` (VPS, fora do `rodar-todos.js`): hub e 7
  telas em 360 px (Entrada e Retorno abrindo direto na aba deles); Entrada pesando e imprimindo pelo servidor; bipe da etiqueta
  na Entrada e na Retirada pelo `onLeu`; `voltar.js` nas janelas de verdade;
  monitor a 1366 px sem mudança; medição do PA. Contra as telas do main ele
  falha em 7 itens e depois trava.
- Testes de navegador já existentes, rodados de novo:
  `aditivo_balanca.py`, `retirada_leitor.py`, `reabrir_com_sessao.py` e
  `inventario_leitor.py` passam. O `enderecamento_coletor.py` falha em 1 item
  ("RETIRAR: botão desligado com o POST no ar"), e falha igual com as telas do
  main: não vem desta mudança.

## Revisão do commit
Um revisor leu o primeiro commit. O que ele achou e o que foi feito:
- Na Entrada aberta pelo hub, o Retorno ficava com a senha do Recebimento:
  corrigido (item 5 acima), com teste.
- O Voltar com o "Resumo do dia" aberto saía da tela: agora fecha o resumo.
- O Voltar com a confirmação "Encerrar a de X?" aberta ia ao hub: agora aperta
  o "Voltar" dela e fica na tela.
- O hub dizia "Mini PC conectado" mesmo com erro do servidor: agora diz "Sem
  conexão".
- Bipe com o campo de peso em foco: ficou para medir no aparelho (acima).
- Ficou como sugestão, sem mudança: o `voltar.js` escolhe o botão de fechar
  pelo texto (Cancelar, Fechar, Voltar, ✕, ←). Um botão novo de confirmar que
  comece com essas palavras seria apertado pelo Voltar. A saída mais segura é
  cada tela marcar o seu botão de cancelar.
- O revisor não achou mudança de comportamento nos apps Coletor e Inventário,
  nem no monitor do Mini PC.

## Para o Gustavo validar
1. Conferir no Mini PC se o PIN do Bruno tem as permissões `mp` e `pa`.
2. Instalar `ekoplastic-mp-2.0.apk` no TC60 do Bruno, confiar no Mini PC, e
   abrir cada um dos 7 botões. Em cada tela: entrar com o PIN, bipar uma
   etiqueta, usar o Voltar do Android e a 🏠.
3. Na Entrada, pesar e imprimir uma etiqueta de verdade a partir do coletor.
4. Decidir sobre o defeito do PA antes de o Bruno lançar PA pelo coletor
   enquanto o Mini PC também lança.
