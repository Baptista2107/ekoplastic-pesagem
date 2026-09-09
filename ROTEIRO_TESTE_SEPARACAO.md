# Roteiro do primeiro teste de separação

**Para a carga de 7.700 kg.** Ordem das coisas, o que esperar em cada
ponto e o que fazer quando não sair como esperado.

---

## Antes de tudo: enviar a atualização

No PC de Pesagem, rodar `ENVIAR-ATUALIZACAO.bat`. Ele roda as oito suítes
(**396 asserções**) e só publica se todas passarem. A estação reinicia — escolha
um momento sem pesagem no meio.

Depois, conferir em Opções → Diagnóstico que o commit é o novo.

---

## Parte 1 — Encher o mapa (o responsável toma a frente)

**Isto é o que precisa acontecer antes de qualquer separação.** O sistema só
sabe onde as coisas estão depois que alguém ler.

Pelo celular: **Endereçamento → 📷 ENDEREÇAR → COLOCAR**.

Para cada gaiola do galpão: bipar a etiqueta da prateleira e a da gaiola, em
qualquer ordem, e confirmar. A tela se limpa sozinha e já fica pronta para a
próxima.

**Como saber que está indo bem:** a aba **🗺 MAPA** mostra o total de posições
ocupadas. Ele tem que crescer a cada leitura. É o placar do trabalho.

**Se a gaiola não tiver etiqueta com QR**, gere uma em Produto Acabado antes —
sem etiqueta não há como endereçar.

**Não precisa terminar tudo para testar a separação.** O que não estiver
endereçado vai aparecer como falta, que é exatamente o comportamento que
queremos exercitar.

---

## Parte 2 — A separação

Pelo celular: **Endereçamento → 📋 SEPARAÇÃO**.

### 1. Fotografar a guia
Botão grande de câmera. É a foto que inicia o processo — sem ela nada começa.
Ela fica no alto da tela durante toda a conferência, tocável para ampliar.

### 2. Conferir
Escolha primeiro se **a guia está em kg ou em fardos** (a guia da seleção vem em
kg). Depois, para cada cliente: nome, cor, formato e quantidade. `+ item` para
mais linhas do mesmo cliente, `+ PEDIDO` para o próximo cliente.

> O sistema converte kg em fardos de 25 kg. Se algum valor não fechar em
> múltiplo de 25, ele **arredonda para cima e avisa** — faltar produto no
> caminhão é pior que sobrar um fardo.

### 3. Ordem de carregamento
O número à esquerda de cada pedido. As setas ↑ ↓ mudam a posição. Lembre que o
**primeiro a carregar é o último a entregar**.

### 4. Gerar o plano
Botão **✓ CONFERIDO — GERAR PLANO**.

---

## Parte 3 — Ler o plano

O plano vem por pedido, na ordem de carregamento, e dentro de cada pedido na
ordem de caminhada pelo galpão (rua, depois vão crescente).

**As três tarjas que importam:**

| Tarja | O que fazer |
|---|---|
| **atende também: CLIENTE X (14)** | Traga a gaiola uma vez só. Ela serve este pedido e o outro — não abra gaiola nova lá na frente |
| **já está na doca — não busque de novo** | A mesma gaiola aparecendo no pedido seguinte. Ela já está com você |
| **sobram N fardos — vai para reetiquetagem** | Depois de bipar, essa gaiola vira pendência na aba SOBRAS |

**O bloco laranja "⏳ FALTAM N FARDOS NO GALPÃO"** aparece quando parte da guia
ainda não está endereçada — o normal, porque parte está na máquina. Ele diz
**quanto** falta de cada produto e **de qual pedido**. Nada trava: o que existe
é separado do mesmo jeito.

> Quando a produção ficar pronta, endereça as gaiolas novas (Parte 1) e toque em
> **↻ refazer** no plano. A falta some sozinha e as gaiolas novas entram.

---

## Parte 4 — Coletar

**No plano, toque em ▶ LIGAR CÂMERA e vá bipando.** Pode ler a etiqueta da
prateleira **ou** a da gaiola — o sistema acha a coleta sozinho. Se a câmera não
abrir, cada linha tem **✓ COLETEI** para confirmar na mão.

**O que acontece a cada bipe:**

- gaiola 100% usada → *"Endereço 01-02-007 liberado no mapa"*. Acabou.
- gaiola com sobra → *"Sobram N fardos — a etiqueta nova está na aba SOBRAS"*.

**Se a gaiola não estiver no endereço:** botão **✗ não está aqui**. O mapa é
corrigido na hora e o plano é refeito com o que resta. Não trave a separação
por causa disso — é para isso que o botão existe.

---

## Parte 5 — As sobras

Aba **🏷 SOBRAS** (o número na aba é quantas estão pendentes).

Para cada uma: **🖨 IMPRIMIR ETIQUETA** — sai uma etiqueta com **número novo**,
mesmo produto, quantidade nova. Cole na gaiola, leve ao **endereço sugerido** e
bipe na aba ENDEREÇAR.

A pendência fecha sozinha nesse bipe. Não há passo a mais.

> A etiqueta antiga não vale mais. Se alguém tentar endereçá-la, o sistema
> recusa e diz qual é a nova.

---

## O que observar durante o teste

Anote o que não bater — é isso que vale mais que o teste dar certo.

1. **O plano bate com o que você faria?** Se o alocador mandar abrir mais gaiola
   do que o necessário, quero o caso.
2. **A ordem de caminhada faz sentido no galpão de verdade?** Hoje é rua, depois
   vão crescente. Se a doca ficar do outro lado, a ordem está invertida e dá
   para virar.
3. **O endereço sugerido para a sobra é bom?** Hoje é o vão livre de menor
   número no nível do chão. Se a doca não for nessa ponta, muda.
4. **Quanto tempo levou** para separar comparado ao normal.

---

## Se algo der errado

Nada aqui apaga pesagem, etiqueta nem lançamento do Bling — a separação é uma
área nova do banco, ao lado do que já existe.

- **Errou a conferência da guia:** enquanto ninguém coletou, dá para corrigir —
  botão "← corrigir a guia". Depois da primeira coleta o sistema recusa, de
  propósito: mudar os números com carga na doca faria o plano brigar com a
  realidade.
- **Bipou a gaiola errada:** o sistema recusa a leitura que não está no plano.
- **Quer desistir da carga:** deixe como está e comece outra. As separações
  ficam listadas, sem atrapalhar.
- **O mapa ficou errado:** endereçar de novo por cima resolve; e o botão
  "não está aqui" corrige durante a separação.

---

## O que ainda NÃO existe

Para não haver expectativa errada:

- **Não conversa com o Bling.** Separação é interna do galpão.
- **Não monta carga nem rota.** A ordem de carregamento é sua.
- **Não confere inventário.** Isso é o ponto 3.
- **Não reserva gaiola** para carga futura.
