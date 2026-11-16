# Pedido de retirada de MP na tela do Mini PC — 16/11/2026

**Pedido (Gustavo, 16/11):** "olha a parte do pedido de retirada que não aparece
no Mini PC, o sombreado". Ao perguntar como seguir: "o como é com você, eu só
quero que funcione". Isso vale como validação para ligar os cartões do pedido
na tela de Retirada (regra de 06/11: nada da retirada liga sem o ok dele).

## Como estava
- A VPS já recebia os pedidos do Willian (painel, aba MP) e marcava atendido
  pelas saídas que chegam do Mini PC: 11 pedidos de 13 a 16/11, todos atendidos.
- A tela de Retirada do Mini PC não mostrava nada. A parte dos pedidos só existia
  nos ramos `retirada-mp-teste` e `retirada-sacos-kg-teste`. O main tinha o revert
  fe0062e, e em 12/11 o mapa subiu sem as partes de pedido.

## O que entrou (ramo `ativar-retirada-pedidos`)
- Revert do revert fe0062e, que traz de volta o ac88b7f. Depois, os commits
  067b5b7, 6a0ac91, 38dd738, 84bb192 e 5acdfc0, em cima do main.
- Conflitos em `lib/db.js` e `rotas/etiquetas.js`: ficou o que o main ganhou
  depois (operadores da extrusão, varredura, mapa) mais as linhas do pedido, na
  mesma ordem do ramo de kg.
- **Risco 1, confirmado e corrigido: bag de pedido "por produto" levava 409.**
  - Desde 11/11 a tela da VPS só cria pedido por produto (lote vazio). O Mini PC
    casava pelo lote, então todo bag desses pedidos ficava "fora do pedido".
    - Em teste, abria o painel de motivo a cada bipe.
    - Em produção, daria 409.
  - Agora a ordem de quem serve é a da VPS (`mp_pedido_retirada._atribuir`):
    1. bag escolhido no painel;
    2. lote com o peso escolhido;
    3. lote, qualquer peso;
    4. por produto: material, cor e fornecedor, qualquer lote de bag;
    5. pedido em kg.
- **Risco 2, confirmado e corrigido: o mesmo bag contava 2 vezes.**
  - A VPS lista a S, e o Mini PC juntava o R de origem. Num pedido de 3 bags, o
    2º fechava o pedido e o 3º ficava "fora".
  - Agora o Mini PC também conta pela S. Uma S que a VPS já pôs em qualquer
    pedido não entra na conta daqui.
- **Cartão:** lote vazio mostra "qualquer" (antes ficava em branco). No painel de
  motivo, aparece "qualquer lote".

## Chave `retirada_pedidos_ligado`
Continua **desligada por padrão** no código e é **ligada no próprio Mini PC na
atualização** (`POST /config {"retirada_pedidos_ligado":"1"}`). Motivo: o
endereço padrão da VPS é o de verdade. Ligada por padrão, qualquer outra
instalação ou rodada de teste que suba o servidor (o PC do Gustavo, por exemplo)
consultaria a VPS e mandaria "saiu fora do pedido" para lá. Para desligar, a
mesma chamada com `"0"`.

O modo continua sendo decidido pela VPS: `MODO = "teste"`. Nada trava; o bag
fora do pedido abre o painel de motivo, que registra e deixa sair.

## Medido
- O Mini PC alcança `http://100.107.130.114:8765/api/mp/retirada/abertos`:
  respondeu `{"ok": true, "modo": "teste", "pedidos": []}` às 09h40 de 16/11. O
  config dele não tem `vps_sacoleiras_url`, então vale o endereço padrão.
- Testes:
  - `testes/retirada-pedidos.js` [8]: com o formato real dos pedidos de hoje
    (RM-20261116-002, Carbonato Karina, 3 bags, lote ""; RM-20261116-001,
    Dessecante em kg), vermelho sem a correção (6 e depois 3 falhas) e verde
    com ela;
  - `testes/retirada-tela.js` [5];
  - suíte inteira: 37 de 37;
  - clique no Chromium com servidor isolado e VPS falsa, em 1366, 390 e 360:
    25 de 25 com o conserto e 18 de 25 com a regra antiga.

## Revisão de 16/11 (tarde): o que mudou depois dela
O revisor leu o ramo e achou 5 defeitos; os 5 foram confirmados no código e
corrigidos, cada um com teste que falha sem a correção.

- **Bag com duas saídas (baixa dupla no Bling).** O bipe esperava a VPS (até
  3 s) entre "o bag já saiu?" e a gravação; o 2º bipe do mesmo bag passava pela
  conferência e os dois gravavam uma S. Agora o bipe **não espera a VPS**: decide
  com a lista guardada (a tela renova a cada 15 s) e a busca roda em segundo
  plano. E, dentro da gravação, confere de novo se o bag já tem saída ativa.
  Consequência: um pedido criado no painel vale no Mini PC quando a lista
  renova (até ~15 s), não no bipe seguinte.
- **Fila de motivos travada.** A tela aceitava 300 caracteres e a VPS recusa
  acima de 200; o item recusado ficava na frente da fila e nenhum motivo seguinte
  chegava. Agora os limites são os da VPS (200, etiqueta R/S/T, pedido em texto),
  e a recusa permanente (400 que não seja o teto por hora) sai da fila e fica
  guardada em `retirada_fora_recusados`, com log. Teto por hora e VPS fora
  continuam na fila.
- **Dois bipes seguidos, o 1º sumia.** A janela de motivo do 2º tomava o lugar da
  do 1º, que nunca recebia resposta: o bag saía do barracão sem registro. Agora a
  tela trata **um bipe por vez** (o 2º espera o 1º, inclusive a resposta do
  motivo).
- **Teste sem nenhum pedido aberto** (decisão de 16/11, o Gustavo delegou o
  "como"): em modo teste, com a lista vazia, o bag sai como sempre saiu — **sem
  janela de motivo e sem aviso por bag**. O aviso juntado de "retirada sem pedido"
  da VPS (de 15 em 15 min) já conta essas saídas. A janela só abre quando há
  pedido aberto e o bag não é de nenhum. Antes, cada bipe com a lista vazia (o
  caso mais comum hoje) virava um Telegram ao Willian e o teto de 30 por hora
  travava a fila. Em **produção** nada muda: sem pedido não sai.
- **Lista estranha parava a retirada.** Pedido `null` na lista, ou o último
  retorno guardado sem a forma certa, fazia todo bipe dar erro 500 por até
  30 min. Agora o que não é pedido é ignorado, e qualquer erro na conta deixa o
  bag sair sem registro (com log).
- Menor: a conta local só lê as saídas a partir de um dia antes do pedido aberto
  mais antigo (antes lia todas, desde sempre, 2 vezes por bipe).

Testes: `testes/retirada-pedidos.js` [9]-[12] (13 falhas no código anterior,
88 de 88 com a correção); clique no Chromium com dois bipes seguidos (vermelho
na tela anterior, 30 de 30 com a nova).

## 2ª revisão de 16/11: o leitor com janela aberta
- **Bipe com janela aberta sumia (grave).** Com a janela de motivo (ou a de
  "JÁ FOI RETIRADA") aberta, o leitor jogava o código fora sem som nem aviso:
  quem bipava o 2º bag sem olhar a tela levava o bag sem S e sem baixa no
  Bling. Agora a tela tem UMA entrada do leitor: o bipe sempre entra na fila,
  toca o aviso, mostra "R… lido — espera você responder a janela aberta" (o
  aviso passou para cima das janelas) e sai depois da resposta. As janelas de
  "já foi retirada" e de confirmar finalizar/cancelar também seguram a fila.
- **Fila sem teto.** Com um bipe por vez, uma resposta que nunca vinha travava
  todos os bipes seguintes em silêncio. `/consumir` e a abertura da sessão têm
  teto de 15 s; passado o teto, a tela avisa "confira se saiu: bipe de novo (se
  já saiu, aparece JÁ FOI RETIRADA)" e a fila anda.
- **Enter do leitor clicava o botão em foco** (Digitar código, Reimprimir,
  Relatório) atrás da janela: o Enter do leitor nunca chega a botão.
- **"Outro motivo…"**: o código bipado entrava no texto do motivo. A caixa
  separa pelo ritmo: 8 teclas seguidas a menos de 60 ms + Enter fecham um
  código R/S/T → sai da caixa e vira bipe na fila; o resto é de quem digita.
  Enter na caixa não pula linha (motivo é uma linha).
- **Buffer do leitor:** 1 s sem tecla zera o que sobrou (leitura cortada,
  sem Enter); com o Enter de um bipe perdido, o buffer "R0000005R0000009"
  vale o ÚLTIMO código (o que o leitor acabou de ler), não o primeiro.
- **Fila de motivos:** item que a VPS responde 5xx cinco vezes seguidas vai
  para os recusados (antes travava a fila para sempre); recusados guardam só
  os 200 mais recentes.
- **Fica como decidido em 06/11 (não muda):** em teste, com pedido aberto, bag
  que não é de nenhum pedido abre a janela de motivo e o motivo vai à VPS
  (Telegram ao Willian, teto de 30 por hora na VPS). Sem nenhum pedido aberto,
  sai direto (decisão de hoje, acima).

Testes: `testes/retirada-pedidos.js` [13] (4 falhas no código anterior);
teste de navegador `testes/navegador/retirada_leitor.py` (fora do rodar-todos;
na tela anterior, 14 falhas nos 7 itens; as duas proteções do buffer também provadas por mutação):

    cd ~/bling-claude && venv/bin/python -B <repo>/testes/navegador/retirada_leitor.py <repo>/public /tmp/prints

## Em aberto (não corrigido)
- **Relógio do Mini PC atrás do da VPS:** a VPS só conta a S impressa depois da
  criação do pedido. Se o relógio do Mini PC estiver atrasado, a VPS não conta a
  S e o Mini PC segue contando a dele.
- **Bag escolhido que sai, é estornado e é bipado de novo:** enquanto a VPS não
  atualizar `bags[].saiu`, ele entra como "fora do pedido".
- **Junção com a senha por frame:** o ramo `ativar-pin-por-frame` também mexe em
  `public/mp-retirada.html` (no mesmo ouvinte do leitor). A entrada única já
  traz a guarda `EkoAcesso.bloqueando()` daquele ramo; a junção é feita antes de
  subir.
- **Teto na abertura da sessão:** se o servidor abrir a sessão mas a resposta
  passar dos 15 s, a tela abre outra no bipe seguinte; a vazia é cancelada na
  restauração. Só com o Mini PC muito lento.
- **Lote com troca de produto (menor):** no passo de lote, o Mini PC compara o
  bag de origem e a VPS compara a S (produto novo); podem atribuir o bag a
  pedidos diferentes. Afeta pouco.
- **Régua única:** `norm` (passos de lote/produto) e `nVps`/`chaveProduto`
  (passo de kg) ainda são duas réguas; vale juntar numa só, igual à da VPS.
