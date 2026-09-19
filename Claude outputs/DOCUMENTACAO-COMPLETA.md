# Sistema Ekoplastic — Documentação Completa

> \\\\\\\\\\\\\\\*\\\\\\\\\\\\\\\*Versão documentada:\\\\\\\\\\\\\\\*\\\\\\\\\\\\\\\* v156
> \\\\\\\\\\\\\\\*\\\\\\\\\\\\\\\*Última atualização:\\\\\\\\\\\\\\\*\\\\\\\\\\\\\\\* agosto/2026
> \\\\\\\\\\\\\\\*\\\\\\\\\\\\\\\*Propósito deste documento:\\\\\\\\\\\\\\\*\\\\\\\\\\\\\\\* permitir que qualquer pessoa (ou outra IA) entenda o
> sistema por inteiro — o que ele faz, por que foi feito assim, e quais armadilhas
> já custaram caro — sem precisar do histórico das conversas que o originaram.

\---

## 1\. O que é este sistema

Software de chão de fábrica da **Ekoplastic** (Aparecida de Goiânia/GO), fabricante de
embalagens plásticas. Ele controla o ciclo completo do material:

```
MATÉRIA-PRIMA          EXTRUSÃO            PRODUTO ACABADO       SAÍDA
recebimento    →    bobinas de filme   →   sacolas em fardos  →  venda
(big bags)          (etiqueta + peso)      (lançamento turno)
```

Cada movimentação gera **etiqueta térmica com código de barras** e é **enviada
automaticamente ao Bling** (o ERP da empresa), sem digitação dupla.

### Números do sistema

|||
|-|-|
|`server.js`|\~6.250 linhas (Node.js puro)|
|Telas|12 arquivos HTML|
|Endpoints HTTP|\~70|
|Tabelas no banco|4 (`etiquetas`, `sessoes`, `seqs`, `config`)|
|Testes automatizados|36 (piso mínimo)|
|Dependências externas|2 (`serialport`, `node-forge`)|

\---

## 2\. Arquitetura

### Princípios que guiaram as decisões

1. **Dependências mínimas.** Node.js puro com `http.createServer` — **não usa Express**.
Banco com `node:sqlite` **nativo** (Node 22.5+), sem ORM. Isso mantém o sistema
instalável copiando uma pasta, sem `npm install` demorado.
2. **Nada quebra em silêncio.** Falha de rede, de impressora ou do Bling sempre gera
aviso visível ao operador e registro no log — nunca um erro mudo.
3. **O banco é a fonte da verdade.** Nada crítico vive só na memória do navegador.
4. **Conferência antes de enviar.** Todo envio ao Bling passa por uma tela de resumo.

### Como roda

```
Mini PC TANCA (Windows, touchscreen, sem teclado físico)
└── Pasta: C:\\\\\\\\\\\\\\\\Users\\\\\\\\\\\\\\\\usuario\\\\\\\\\\\\\\\\Desktop\\\\\\\\\\\\\\\\PROJETO AUTOMAÇÃO\\\\\\\\\\\\\\\\
    ├── server.js              ← todo o backend
    ├── public/                ← todas as telas
    ├── etiquetas.db           ← banco (NUNCA vai no pacote de atualização)
    ├── credenciais-bling.json ← tokens OAuth (NUNCA vai no pacote)
    ├── cert/                  ← certificado HTTPS (gerado local)
    ├── logs/ e backups/
    └── \\\\\\\\\\\\\\\*.bat                  ← utilitários
```

**Três portas:**

|Porta|Escuta|Para quê|
|-|-|-|
|3000|`127.0.0.1`|HTTP local — as telas do Mini PC|
|3443|`0.0.0.0`|HTTPS na rede — **celular** (câmera exige HTTPS)|
|8888|`127.0.0.1`|Callback do OAuth do Bling|

Variáveis de ambiente para testes: `EKO\\\\\\\\\\\\\\\_PORT`, `EKO\\\\\\\\\\\\\\\_PORT\\\\\\\\\\\\\\\_HTTPS`, `EKO\\\\\\\\\\\\\\\_PORT\\\\\\\\\\\\\\\_CB`,
`EKO\\\\\\\\\\\\\\\_DB\\\\\\\\\\\\\\\_FILE`, `EKO\\\\\\\\\\\\\\\_LOG\\\\\\\\\\\\\\\_DIR`, `EKO\\\\\\\\\\\\\\\_SERIAL\\\\\\\\\\\\\\\_PORT`.

### Hardware

* **Balança Weightech** via serial (`COM1`, 9600 baud) — leitura contínua do peso.
* **Impressora térmica** (4BARCODE 4B-2074B / compatível EPL2) — impressão **RAW**
via PowerShell (`enviar\\\\\\\\\\\\\\\_raw.ps1`), **sem passar pelo driver do Windows**.
* **Etiquetas 100 × 150 mm** (800 × 1200 dots a 203 dpi).

\---

## 3\. Módulos (telas)

### 3.1 Matéria-Prima (`materia-prima.html` — contêiner com 3 abas)

|Aba|Arquivo|O que faz|
|-|-|-|
|Recebimento|`mp-recebimento-retorno.html`|Entrada de big bags. Pesa, imprime etiqueta `R…`, bipa, envia como **pedido de compra**.|
|Retirada|`mp-retirada.html`|Saída para produção. Bipa a etiqueta do big bag ou lança sacos (aditivos). Vira **pedido de venda** para contato interno.|
|Retorno|`mp-recebimento-retorno.html`|Material que volta da produção. Etiqueta `T…`. Aceita retorno de retorno (2ª volta).|

**Materiais:** GBD (Grão Baixa Densidade), POLI (Polinylon), CARBO (Carbonato),
PIG (Pigmento), DESSEC (Dessecante).

**Código gravimétrico:** código curto (CAN1, PT3, D5…) que a extrusão usa na máquina.
Existe **só neste sistema** — não é cadastrado no Bling.

### 3.2 Extrusão (`etiqueta-producao.html`)

Pesa bobinas, imprime etiqueta `E…`, bipa para confirmar. Ao finalizar o turno,
mostra resumo e envia ao Bling. Também produz **capas**.

A etiqueta tem, na metade de baixo, campos manuscritos para as sacoleiras anotarem
quanto a bobina rendeu (`TURNO A / PESO: \\\\\\\\\\\\\\\_\\\\\\\\\\\\\\\_\\\\\\\\\\\\\\\_` e `TURNO C / PESO: \\\\\\\\\\\\\\\_\\\\\\\\\\\\\\\_\\\\\\\\\\\\\\\_`).

### 3.3 Produto Acabado (`produto-acabado.html`)

Lança a produção de sacolas por **turno**, em fardos de **25 kg**.

* **Cores:** AM (Amarela), BC (Branca), PT (Preta), REC (Colorida = **verde**).
* **Formatos:** 30×40, 30×45, 33×46, 35×45, 40×50, 42×53, 50×60, 60×80, 80×100.
* **Máquinas:** P1 e P2 — com **trava**: cada máquina só produz certos formatos.

  * P1: 40×50, 50×60, 60×80, 80×100
  * P2: 30×40, 30×45, 33×46, 35×45, 40×50, 42×53
  * (40×50 é o único comum às duas)
* **Alerta de cor incomum:** não há regra fixa de cor, então o sistema usa o
**histórico** — se aquela cor nunca rodou naquela máquina/formato nos últimos
120 dias, ele pergunta antes de aceitar. Não bloqueia, só confirma.
* **Etiqueta de gaiola (QR):** gera etiqueta com QR gigante (91 mm) para o
inventário contar. **Não vai ao Bling** — é só para contagem.

**Turnos e datas:** A, C e EXTRA. O turno C atravessa a meia-noite, e a produção
conta no dia em que **começou** — por isso a data sugerida do C é **ontem**.

### 3.4 Resíduos (`outras-pesagens.html`)

Antes chamado "Outras Pesagens". Borra, varredura, **pó**, refile etc.

⚠️ **Pó e Varredura são o mesmo produto no Bling** (SKU `RES.VARREDURA`,
ID `16572867344`). O que distingue é a **observação do pedido**, que informa
quantos kg daquele lançamento foram de pó.

### 3.5 Inventário (`inventario.html`) — celular

Contagem física comparada ao saldo do Bling. Dois universos:

**Matéria-Prima:** lê a etiqueta do big bag (código de barras). Pigmento, dessecante
e carbonato são contados **por sacos** (25 kg cada), com campo para **sacos abertos**
de peso fora do padrão.

**Produto Acabado:** lê o **QR da gaiola**.

Dois modos, ambos disponíveis nos dois universos:

* **Por produto:** escolhe o item e conta só ele.
* **Leitura livre:** lê qualquer etiqueta, o sistema agrupa sozinho por produto.

**Regras críticas:**

* Contagem **cega** — o saldo do Bling só aparece depois de contar.
* Etiqueta **não pode ser contada duas vezes no mesmo ciclo** de inventário
(mesmo em contagens diferentes; só libera ao encerrar o inventário).
* Etiqueta de outro produto é recusada.
* A contagem em andamento **sobrevive a atualizar a página**.
* **Prévia:** confere divergências sem finalizar nada.
* PDF por cor, formatos em ordem crescente, com opção de **compartilhar** (WhatsApp).

### 3.6 Retirada de Bobinas (`retirada-bobinas.html`) — celular

Operador lê o código da bobina, escolhe o destino (Sacoleira P1/P2) e dá baixa.
**Cada bobina vira um pedido de venda próprio**, no cliente do turno (A, C, Extra).

O envio ao Bling acontece **antes** de marcar como baixada — se o Bling recusar,
a bobina continua disponível. Nunca fica baixada aqui e não lá.

### 3.7 Dashboard (`dashboard.html`)

Histórico consolidado de todos os módulos, com filtros (período, turno, máquina,
fornecedor, material, módulo, situação, busca) e 7 abas.

Gera um **arquivo HTML autônomo** (`GERAR-DASHBOARD.bat`) com todos os dados
embutidos — funciona sem servidor, dá para mandar por e-mail ou pôr no Drive.

### 3.8 Opções (`manutencao.html`)

Antes "Manutenção". Protegida por senha de supervisor. Organizada em categorias:
diagnóstico e autenticação soltos no topo; depois **Telas de operação**,
**Senhas e permissões**, **Envios ao Bling** e **Cadastros**.

\---

## 4\. Banco de dados

### `etiquetas` — cada item pesado/lançado

Campos-chave: `id` (R0000123), `seq`, `seq\\\\\\\\\\\\\\\_sessao`, `tipo`, `sub\\\\\\\\\\\\\\\_tipo`,
`material\\\\\\\\\\\\\\\_key`, `cor`, `fornecedor`, `lote`, `peso`, `qtd\\\\\\\\\\\\\\\_sacos`, `codigo`, `sku`,
`status`, `hora\\\\\\\\\\\\\\\_impressao`, `hora\\\\\\\\\\\\\\\_bipagem`, `sessao\\\\\\\\\\\\\\\_id`, `operador`, `maquina`,
`largura`, `tipo\\\\\\\\\\\\\\\_bobina`, `turno\\\\\\\\\\\\\\\_codigo`, `bling\\\\\\\\\\\\\\\_pedido\\\\\\\\\\\\\\\_id`, `peso\\\\\\\\\\\\\\\_bruto`, `tara`.

**Prefixos do ID:**

|Prefixo|Significa|
|-|-|
|`R`|Recebimento de MP|
|`T`|Retorno de MP|
|`S`|Retirada (etiqueta virtual de saída)|
|`E`|Bobina de extrusão|
|`O`|Resíduos|
|`P`|Produto acabado|
|`G`|Gaiola (QR de contagem)|

**Status:** `aguardando\\\\\\\\\\\\\\\_bipe` → `bipada` → `consumida` (retirada) ou `cancelada`.

### `sessoes` — agrupamento de itens

`id`, `tipo`, `inicio`, `fim`, `fornecedor`, `total\\\\\\\\\\\\\\\_kg`, `total\\\\\\\\\\\\\\\_etiquetas`,
`bling\\\\\\\\\\\\\\\_status`, `bling\\\\\\\\\\\\\\\_id`, `bling\\\\\\\\\\\\\\\_erro`, `operador`, `maquina`, `turno\\\\\\\\\\\\\\\_codigo`,
`data\\\\\\\\\\\\\\\_lancamento`.

`bling\\\\\\\\\\\\\\\_status`: `pendente` → `enviado` | `erro` | `pendente\\\\\\\\\\\\\\\_config`.

### `config` — chave/valor

|Chave|Guarda|
|-|-|
|`mapa\\\\\\\\\\\\\\\_produto\\\\\\\\\\\\\\\_bling`|`"GBD:Canela:Cedro"` → ID do produto no Bling|
|`mapa\\\\\\\\\\\\\\\_fornecedor\\\\\\\\\\\\\\\_bling`|`"Cedro"` → ID do contato no Bling|
|`mapa\\\\\\\\\\\\\\\_sku\\\\\\\\\\\\\\\_variacao\\\\\\\\\\\\\\\_mp`|chave → SKU (para produtos **com variação**)|
|`mapa\\\\\\\\\\\\\\\_bobina\\\\\\\\\\\\\\\_bling`|`"COR|
|`mapa\\\\\\\\\\\\\\\_variacao\\\\\\\\\\\\\\\_pa\\\\\\\\\\\\\\\_bling`|produto acabado|
|`mapa\\\\\\\\\\\\\\\_turno\\\\\\\\\\\\\\\_extrusao` / `mapa\\\\\\\\\\\\\\\_turno\\\\\\\\\\\\\\\_bobina`|turno → contato no Bling|
|`mp\\\\\\\\\\\\\\\_materiais`, `mp\\\\\\\\\\\\\\\_fornecedores`, `mp\\\\\\\\\\\\\\\_codigos\\\\\\\\\\\\\\\_gravimetricos`|catálogo de MP|
|`colaboradores`|usuários + hash do PIN|
|`inventario\\\\\\\\\\\\\\\_atual`, `gaiolas\\\\\\\\\\\\\\\_pa`, `baixas\\\\\\\\\\\\\\\_bobinas\\\\\\\\\\\\\\\_AAAA-MM-DD`|operação|
|`bling\\\\\\\\\\\\\\\_simular`, `print\\\\\\\\\\\\\\\_simular`|modos de teste|
|`senha\\\\\\\\\\\\\\\_saida\\\\\\\\\\\\\\\_hash`|senha do supervisor|

\---

## 5\. Integração com o Bling

### Autenticação

OAuth 2.0 (Bling API v3). Tokens em `credenciais-bling.json`, renovados
automaticamente. Reautenticação em **Opções → Autenticação OAuth**.

### Como cada movimento vira documento

|Módulo|Documento no Bling|Contato|
|-|-|-|
|Recebimento / Retorno MP|**Pedido de compra** (entrada)|Fornecedor real|
|Retirada MP|**Pedido de venda** (saída)|EKOPLASTIC IND (interno)|
|Extrusão|Entrada|Contato do turno|
|Produto Acabado|Entrada|Contato do turno|
|Resíduos|Entrada|EKOPLASTIC IND|
|Retirada de bobinas|**Pedido de venda**, 1 por bobina|Contato do turno|

### Produtos simples × com variação — **a maior fonte de erro histórica**

No Bling, alguns produtos são "simples" (ID próprio) e outros têm "variação"
(vários itens sob um **ID-pai**, distinguidos pelo **SKU**).

**Enviar o ID-pai de um produto com variação faz o Bling recusar o pedido**
(erro `VALIDATION\\\\\\\\\\\\\\\_ERROR: "O produto informado é do formato 'com variação'"`).

Solução: `mapa\\\\\\\\\\\\\\\_sku\\\\\\\\\\\\\\\_variacao\\\\\\\\\\\\\\\_mp` guarda o SKU; na hora do envio, o sistema chama
`resolverIdVariacaoPA(token, sku, idPaiFallback)`, que busca o produto pelo SKU e
usa o ID retornado. **Isso funciona nos dois casos** (simples e variação) — por isso
todo produto novo deve ser cadastrado com SKU de variação, por segurança.

**Exemplos reais:**

* COLLOR-X e INNOVACOLOR: mesmo ID-pai `16571944289`, SKUs diferentes.
* Cromex: ID próprio `16684154422`.

### Consulta de saldo (inventário)

`GET /Api/v3/estoques/saldos?idsProdutos\\\\\\\\\\\\\\\[]={id}` → `data\\\\\\\\\\\\\\\[0].saldoFisicoTotal`.
⚠️ Exige que o app no Bling tenha o escopo **"Controle de estoque"**.

### Sincronização automática de MP (v155)

**Opções → Cadastros → Sincronizar matéria-prima com o Bling**: varre os produtos
do Bling, identifica material/cor/fornecedor pelo nome, mostra só os que ainda não
estão no sistema. O operador confere, informa o código gravimétrico e confirma.

⚠️ A identificação procura o **fornecedor primeiro** e o remove do texto antes de
procurar a cor — senão "PIGMENTO AMARELO **CRISTAL** MASTER" seria lido com a cor
"Cristal".

\---

## 6\. Impressão (EPL2)

Comandos enviados direto à impressora, sem driver:

```
N              limpa o buffer
q800           largura 800 dots (100 mm)
Q1200,24       comprimento 1200 dots (150 mm) + gap
A<x>,<y>,<rot>,<fonte>,<mult-h>,<mult-v>,N,"texto"
B<x>,<y>,...   código de barras
b<x>,<y>,Q,m2,s<escala>,"dados"    QR Code
LO<x>,<y>,<larg>,<alt>             linha
P1             imprime 1 etiqueta
```

**Larguras reais das fontes** (dots por caractere, antes do multiplicador):
`{1:8, 2:10, 3:12, 4:14, 5:32}` — usar valores errados desalinha o texto centralizado.

**Ao trocar o tamanho da etiqueta**, rodar `CALIBRAR-IMPRESSORA.bat` (envia `xa`,
o autosense). Se a impressora ignorar, segurar o botão FEED até puxar 2–3 etiquetas.

\---

## 7\. Segurança e acesso

* **Senha por colaborador (PIN):** cada pessoa tem PIN próprio; o nome fica gravado
na sessão e sai no **resumo impresso** como responsável.
* **Liberação por módulo:** a senha é pedida **uma vez** ao entrar no módulo e vale
para as abas internas, por até 8 horas ou até fechar o navegador.
* **Senha de supervisor:** protege a tela Opções e a saída do modo quiosque.
* **Hash SHA-256 com sal** — a senha nunca é guardada em texto.
* **HTTPS** com certificado autoassinado que inclui os IPs da máquina no SAN
(o Safari exige isso para liberar a câmera).

⚠️ **Nunca usar `alert()` / `confirm()` nas telas do Mini PC**: a janela nativa do
navegador **tira o sistema do modo tela cheia**, expondo a barra de endereço. Usar
os modais próprios de cada tela.

\---

## 8\. Testes e qualidade

```
node testes/piso-testes.js     →  36 testes, devem passar 36/0
```

**Procedimento obrigatório antes de qualquer entrega:**

1. `node --check server.js` — sintaxe do backend
2. Validar o JavaScript de cada tela alterada
3. Rodar o piso (36/0)
4. **Regressão**: comparar arquivo a arquivo com a versão anterior — só devem
aparecer os arquivos que a mudança justifica
5. Testar o comportamento no **navegador simulado** (jsdom), não só a sintaxe

⚠️ **Lição cara:** validar sintaxe **não** pega erro de ordem de carregamento nem
elemento escondido. Duas falhas em produção vieram disso:

* Um script incluído depois de quem o usava → tela preta.
* Esconder o "elemento-pai" de um botão escondeu a tela inteira.
Sempre verificar **visibilidade real** (o elemento ou algum ancestral tem `oculto`?).

\---

## 9\. Regras de negócio que não são óbvias

1. **Big bag retirado antes de finalizar a entrada continua contando na entrada.**
Ele fica com status `consumida`, mas o pedido de compra precisa incluí-lo — senão
o Bling registra saída de material que nunca entrou. Isso vale no envio, no
resumo impresso, no total da tela e na confirmação.
2. **1 fardo = 25 kg** (produto acabado). **1 saco = 25 kg** (pigmento, dessecante,
carbonato).
3. **Turno C conta no dia em que começou**, não no dia em que termina.
4. **QR de gaiola é só contagem** — nunca vira lançamento no Bling.
5. **Retirada de bobina: um pedido por bobina**, por decisão da operação.
6. **Pó e varredura compartilham produto** — a distinção está na observação.
7. **Inventário é cego** — mostrar o saldo antes enviesaria a contagem.

\---

## 10\. Instalação e atualização

### Atualizar o sistema

1. **Backup da pasta inteira** (copiar e colar ao lado, renomeando).
2. Fechar o servidor (janela preta) e o Chrome.
3. Extrair o zip, entrar na pasta `vXXX`, copiar **o conteúdo** para dentro de
`PROJETO AUTOMAÇÃO`, substituindo.
4. Abrir `INICIAR.bat`.
5. Conferir `/healthcheck` → campo `versao`.

⚠️ O pacote **nunca** contém `etiquetas.db`, `credenciais-bling.json`, `logs/`,
`backups/` ou `cert/` — por isso atualizar não apaga dados nem exige reautenticar.

### Utilitários

|Arquivo|Para quê|
|-|-|
|`INICIAR.bat`|Sobe o servidor e abre a tela|
|`GERAR-DASHBOARD.bat`|Gera o dashboard autônomo|
|`CALIBRAR-IMPRESSORA.bat`|Calibra ao trocar o tamanho da etiqueta|
|`DIAGNOSTICO.bat`|Diagnóstico geral|
|`RODAR-TESTES.bat`|Executa o piso de testes|
|`ATIVAR-INICIO-AUTOMATICO.bat`|Sobe o sistema junto com o Windows|

### Celular

`https://<IP-do-MiniPC>:3443` no mesmo Wi-Fi. Aceitar o aviso de certificado
(Safari: Mostrar detalhes → visitar este site). Liberar a porta no firewall se
necessário.

\---

## 11\. Pendências e ideias em aberto

|Item|Situação|
|-|-|
|**Bot do Telegram**|Viabilidade confirmada, não implementado. Lançar produção por voz/texto, confirmar no chat, imprimir QR. Recomendação: acumular no turno e finalizar pelo chat (1 pedido por turno). Voz exige serviço de transcrição (\~US$ 0,003/min).|
|**Editar pedido no Bling**|A gestão quer parar de excluir pedidos e passar a editar. Investigação iniciada, não concluída.|
|**Histórico de lançamentos do dia (PA)**|Planejado, não implementado. Mostrar os lançamentos já feitos no turno para evitar duplicação.|
|**Edição de item na extrusão**|Planejado. Corrigir dados (menos o peso) e reimprimir a etiqueta.|
|**Sincronização de produto acabado**|A sincronização atual cobre só matéria-prima.|
|**"SecMil" × "Secmil"**|Divergência de maiúscula entre a tela e o mapa de produtos. Nunca causou problema, mas está lá.|

\---

## 12\. Histórico resumido de versões

|Faixa|O que entrou|
|-|-|
|v106–v111|Catálogo de MP no banco; retorno de material inteiro; retorno de retorno; fornecedores COLLOR-X e Cromex|
|v112–v116|**HTTPS** para acesso por celular; certificado com IP no SAN; **tela de inventário**; INNOVACOLOR|
|v117|Confirmação antes de enviar ao Bling (PA e extrusão)|
|v118–v122|Ajustes de câmera e layout mobile do inventário; PDF com saldo atual|
|v123–v126|**Retirada de bobinas** por QR/código, por turno, com destino|
|v127–v128|**Senhas por colaborador**; correção de carregamento que derrubou telas|
|v129–v130|Trava máquina × formato; contagem por sacos; renomeações|
|v131–v138|**Dashboard**; correção do big bag retirado; dashboard autônomo|
|v139–v147|**QR de gaiola**; inventário de produto acabado; zoom de câmera; layout enxuto|
|v148–v153|Leitura livre; sacos abertos; trava de leitura duplicada; prévia|
|v154–v156|Cores no QR; data do turno C; **Pó**; tela **Opções**; **sincronização com o Bling**; peso avulso na retirada|

\---

## 13\. Como continuar o trabalho

Se você é uma IA ou pessoa retomando este projeto:

1. **Leia o código antes de mudar.** O `server.js` tem comentários explicando o
*porquê* das decisões não óbvias — especialmente onde já houve erro.
2. **Nunca entregue sem regressão.** Comparar com a versão anterior e conferir que
só mudou o que devia é o que impede estragos.
3. **Teste no navegador simulado.** Sintaxe válida não significa tela funcionando.
4. **Pergunte antes de assumir** se um produto no Bling é simples ou com variação —
essa suposição já custou um pedido recusado e um retrabalho.
5. **O sistema roda em produção real.** Erro aqui para uma fábrica. Na dúvida entre
entregar rápido e entregar conferido, conferir.

\---

*Documento gerado a partir do código da versão v156.*

