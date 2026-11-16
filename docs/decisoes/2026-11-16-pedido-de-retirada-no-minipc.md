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

## Em aberto (não corrigido)
- **Relógio do Mini PC atrás do da VPS:** a VPS só conta a S impressa depois da
  criação do pedido. Se o relógio do Mini PC estiver atrasado, a VPS não conta a
  S e o Mini PC segue contando a dele.
- **Bag escolhido que sai, é estornado e é bipado de novo:** enquanto a VPS não
  atualizar `bags[].saiu`, ele entra como "fora do pedido".
- **Junção com a senha por frame:** o ramo `ativar-pin-por-frame` também mexe em
  `public/mp-retirada.html`. A junção é feita antes de subir.
