# Endereçamento do galpão — Ekoplastic

**Documento de contexto para consulta externa.**
Estado em 04/09/2026. Escrito para ser lido por quem não conhece a operação:
descreve o problema, o que já está construído e funcionando, o que
deliberadamente não existe ainda, e as perguntas em aberto.

---

## 1. O contexto

A Ekoplastic é uma fábrica de sacolas plásticas. Este documento trata de **onde
o produto acabado fica guardado no galpão** e de como o sistema sabe disso.

### O sistema onde isto vive

Uma aplicação Node.js chamada internamente **"estação de pesagem"**:

- **Onde roda:** um Mini PC dentro da fábrica, ligado a uma balança (porta
  serial) e a uma impressora térmica Zebra/Elgin (EPL2, etiquetas 100 × 150 mm).
- **Banco:** SQLite local (`node:sqlite`, WAL, `synchronous=FULL`). Sem servidor
  de banco, sem nuvem.
- **Acesso:** navegador. A tela touch do próprio Mini PC (1024 px de largura) e,
  desde 04/09/2026, **celulares** — todo o pessoal de galpão abre pelo telefone,
  cada um com um aparelho de tamanho diferente.
- **Rede:** a estação é alcançável pela rede interna e por uma VPN privada.
  **O galpão não pode depender de internet** para operar: bibliotecas de
  terceiros (leitor de QR, por exemplo) são servidas pela própria estação, não
  por CDN.
- **Integração:** lançamentos de produção e de matéria-prima vão para o **Bling**
  (ERP) logo após cada operação. O endereçamento **não** toca no Bling — é
  informação interna de galpão.

### O que o sistema já fazia antes do endereçamento

Pesagem e etiquetagem de cinco fluxos: recebimento de matéria-prima, retirada de
MP, retorno de MP, extrusão (bobinas) e produto acabado. Cada etiqueta impressa
vira uma linha no banco; cada operação vira uma "sessão" que ao fim é lançada no
Bling.

---

## 2. O que está sendo endereçado

### A gaiola

O produto acabado sai da produção em **fardos de 25 kg** de sacolas. Os fardos
são acumulados em **gaiolas** — estruturas metálicas paletizáveis. Uma gaiola
contém fardos de **um único SKU** (uma cor e um formato).

Existem **dois tamanhos de gaiola: GRANDE e PEQUENA.**

Quando uma gaiola é fechada, o sistema imprime para ela uma etiqueta com QR e
lhe dá um identificador único no formato `G0000123`. Essa etiqueta existia antes
do endereçamento — foi criada para **contagem de inventário**, não para
localização.

### Os SKUs

```
SKU = {prefixo da cor}.{dígitos do formato}.5K       ex.: BC.5060.5K
```

- **4 cores:** AM (Amarela), BC (Branca), PT (Preta), REC (Colorida)
- **9 formatos:** 30x40, 30x45, 33x46, 35x45, 40x50, 42x53, 50x60, 60x80, 80x100
- **2 máquinas** com travas de formato: P1 faz 40x50, 50x60, 60x80, 80x100; P2
  faz 30x40, 30x45, 33x46, 35x45, 40x50, 42x53. **40x50 é o único formato comum
  às duas.**
- Resultado: **36 SKUs** — 12 exclusivos de P1, 20 exclusivos de P2, 4 comuns.
- **25 kg por fardo**, sempre.

---

## 3. O galpão

### O código de endereço

```
RR-NN-PPP
│  │  └── posição ao longo da rua (001, 002, …)
│  └───── nível de ALTURA: 01 chão · 02 meio · 03 alto
└──────── rua: 01 ou 02
```

O número do meio é **altura**, não coluna nem lado de corredor. Isso foi
confirmado com a operação e é o ponto que costuma ser mal interpretado.

### O inventário de posições

| Rua | Vãos por nível | Níveis | Total | Úteis |
|---|---|---|---|---|
| 01 | 20 | 3 | 60 | 58 |
| 02 | 26 | 3 | 78 | 78 |
| | | | **138** | **136** |

Duas posições existem no papel mas não recebem palete e nascem **bloqueadas** no
sistema:

- `01-01-005` — HIDRANTE
- `01-01-006` — ESPAÇO DA INFORMAÇÃO

### Níveis com alturas diferentes

**O nível 01 (chão) foi construído mais alto de propósito**, para receber as
gaiolas **GRANDES**. Os níveis 02 e 03 recebem as **pequenas**.

| Nível | Gaiola | Posições úteis |
|---|---|---|
| 01 — chão | GRANDE | 44 |
| 02 — meio | pequena | 46 |
| 03 — alto | pequena | 46 |

Alturas usadas nos desenhos: 2,20 m no nível 01 e 1,45 m nos 02 e 03. **São
proporcionais, ainda não medidas em campo** — pendência conhecida.

**Capacidade total: 136 gaiolas, uma por posição.**

---

## 4. As etiquetas e os dois QR

Todo o endereçamento se apoia em duas etiquetas que já existem fisicamente no
galpão.

### QR do endereço (colado na prateleira)

Conteúdo: **o código puro, sem URL.**

```
01-02-007
```

Decisão deliberada: sem URL, o QR é lido por qualquer leitor e **não quebra se o
IP da estação mudar**. Foram impressas 138 etiquetas de 100 × 150 mm, uma por
posição, com faixa indicando GAIOLA GRANDE / PEQUENA. As duas posições
bloqueadas receberam placa de sinalização sem QR ("NÃO OBSTRUIR / NÃO
PALETIZAR").

### QR da gaiola (colado na gaiola)

Conteúdo: campos separados por `|`.

```
EKOPA|G0000123|50x60|BC|24|600|GRANDE
  │      │       │    │  │   │    └── 7º campo: tipo da gaiola (adicionado 04/09/2026)
  │      │       │    │  │   └─────── kg (fardos × 25)
  │      │       │    │  └─────────── nº de fardos
  │      │       │    └────────────── cor (chave: AM/BC/PT/REC)
  │      │       └─────────────────── formato
  │      └─────────────────────────── id único da gaiola
  └────────────────────────────────── prefixo fixo
```

O **7º campo é apêndice de propósito**: o leitor do inventário exige "EKOPA e ao
menos 6 campos", então **toda etiqueta impressa antes continua sendo lida**. Sem
escolher o tipo, a etiqueta sai exatamente como sempre saiu.

### Por que os dois QR são autoexplicativos

O do endereço casa com `^\d{2}-\d{2}-\d{3}$`; o da gaiola começa com `EKOPA|`.
Dá para saber qual é qual **só de olhar o texto lido** — o operador não precisa
dizer de antemão o que vai bipar, e a ordem de leitura é livre.

---

## 5. O que está construído e em operação

### 5.1 Modelo de dados

```sql
-- Um vão de prateleira. 138 linhas, semeadas na subida do servidor.
CREATE TABLE posicoes (
  codigo      TEXT PRIMARY KEY,   -- '01-02-007'
  rua         INTEGER NOT NULL,
  nivel       INTEGER NOT NULL,
  posicao     INTEGER NOT NULL,
  tipo_gaiola TEXT,               -- 'GRANDE' | 'PEQUENA'
  bloqueada   INTEGER NOT NULL DEFAULT 0,
  motivo      TEXT
);

-- Quem morou em cada endereço, e quando. HISTÓRICO, não só estado atual:
-- a linha continua depois da saída, com data de saída preenchida.
CREATE TABLE ocupacoes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  posicao       TEXT NOT NULL,
  gaiola_id     TEXT NOT NULL,
  entrada       TEXT NOT NULL,    -- ISO
  saida         TEXT,             -- NULL = ocupação ABERTA
  operador_e    TEXT,             -- quem guardou
  operador_s    TEXT,             -- quem retirou
  motivo_saida  TEXT,
  formato       TEXT,             -- retrato do produto no momento da entrada
  cor           TEXT,
  fardos        INTEGER,
  kg            REAL,
  tipo_gaiola   TEXT,
  FOREIGN KEY (posicao) REFERENCES posicoes(codigo)
);
```

A semeadura das 138 posições é `INSERT OR IGNORE`: não sobrescreve nada numa
estação que já rodou, inclusive bloqueios criados depois.

O **retrato do produto** (formato, cor, fardos, kg) é copiado para a ocupação em
vez de referenciado, porque a etiqueta da gaiola pode ser reimpressa com outros
números. A ocupação guarda o que estava lá naquele momento.

### 5.2 As duas regras são do BANCO, não do código

```sql
CREATE UNIQUE INDEX idx_ocup_posicao_aberta ON ocupacoes(posicao)   WHERE saida IS NULL;
CREATE UNIQUE INDEX idx_ocup_gaiola_aberta  ON ocupacoes(gaiola_id) WHERE saida IS NULL;
```

**Um endereço tem um morador; uma gaiola mora num lugar só.** Índices parciais
sobre as ocupações abertas. Se fossem verificações em código, duas leituras
simultâneas passariam pelas duas — a suíte testa exatamente isso, disparando
duas requisições em paralelo, e só uma entra; a outra recebe 409 `corrida:true`.

### 5.3 Endpoints HTTP

| Rota | Para quê |
|---|---|
| `GET /enderecamento/mapa` | todas as posições + quem mora nelas + resumo + layout |
| `GET /enderecamento/posicao/:codigo` | detalhe e histórico (20 últimos) da posição |
| `GET /enderecamento/gaiola/:id` | onde esta gaiola está (ou esteve) |
| `POST /enderecamento/ocupar` | `{posicao, gaiola_id, tipo_gaiola?, operador?, formato?, cor?, fardos?, kg?}` |
| `POST /enderecamento/liberar` | `{posicao}` **ou** `{gaiola_id}` (+ `motivo?`, `operador?`) |
| `GET /enderecamento/historico?limit=` | últimos movimentos |

`GET /enderecamento/mapa` devolve, por posição:

```json
{ "codigo":"01-02-007", "rua":1, "nivel":2, "posicao":7,
  "tipo_gaiola":"PEQUENA", "bloqueada":false, "motivo":null, "ocupada":true,
  "gaiola":{ "id":"G0000123","formato":"50x60","cor":"Branca","fardos":24,
             "kg":600,"tipo":"PEQUENA","entrada":"2026-09-01T13:20:00.000Z",
             "operador":"VINICIUS","dias":3 } }
```

mais um `resumo` com `total, uteis, ocupadas, livres, bloqueadas, fardos, kg`.

### 5.4 Travas do `ocupar`

| Situação | Resposta |
|---|---|
| endereço fora do padrão `RR-NN-PPP` | 400 |
| etiqueta que não é de gaiola (big bag `R…`, bobina `E…`) | 400 — "a etiqueta de gaiola começa com G" |
| endereço inexistente | 404 |
| endereço bloqueado | 409 com o motivo (HIDRANTE etc.) |
| endereço já ocupado por outra gaiola | 409 dizendo qual gaiola está lá |
| gaiola já endereçada em outro lugar | 409 dizendo onde |
| **mesma gaiola no mesmo endereço** | **200 `ja_estava:true`** — reler não é erro, só confirma |
| gaiola GRANDE em nível 02 ou 03 | **200 com `aviso`** — avisa, não bloqueia |

A última merece explicação: uma gaiola pequena no chão só desperdiça vão, e uma
grande em cima **o galpão já impede sozinho, porque não cabe**. Bloquear no
software seria criar um problema que a física não tem.

Prioridade dos dados: se a gaiola está registrada no sistema, **o registro
vence o QR** — a etiqueta pode ter sido reimpressa com outros números.

### 5.5 As telas

`public/enderecamento.html`, duas abas. No computador abre no **Mapa**; no
celular, direto em **Endereçar**.

**Mapa** — as duas ruas desenhadas por nível, de cima para baixo como a
prateleira é vista de frente. Cada vão é clicável e mostra endereço, gaiola,
formato, cor, fardos, peso, quando foi guardada, **há quantos dias está parada**
e quem guardou. Busca por endereço, gaiola, formato ou cor destaca as posições.
Botão RETIRAR DAQUI direto do mapa.

**Endereçar** — dois modos:

- **COLOCAR:** lê os dois QR, em qualquer ordem.
- **RETIRAR:** lê **um** dos dois — o sistema resolve o resto.

Botão DIGITAR para quando a câmera não abrir; a tela nunca fica sem saída. O
leitor de câmera é o mesmo já validado no inventário: escolha da melhor traseira
(a ultra-angular não foca de perto), zoom, foco contínuo, diagnóstico de
certificado no iPhone.

Link para o mapa no cabeçalho da tela de Produto Acabado (🗺).

### 5.6 Como foi verificado

- **85 verificações automatizadas** (`testes/enderecamento.js`), incluindo: as
  138 posições e as 2 bloqueadas; as duas travas pela porta da frente **e** com
  duas requisições em paralelo; endereço bloqueado recusando palete; liberar
  devolvendo o endereço e preservando o histórico; liberar pelo endereço e pela
  gaiola; o aviso da gaiola grande; a etiqueta de 7 campos sem quebrar a regra
  de 6 do inventário; e sobrevivência ao reinício da atualização.
- Conferência em navegador real com 8 gaiolas espalhadas: 138 vãos desenhados,
  clique abrindo detalhe, busca, retirada pelo mapa, e o ciclo completo colocar
  → conferir no banco → retirar.
- Total do projeto: **327 verificações** em sete suítes, que rodam como portão
  antes de qualquer atualização chegar à fábrica.

---

## 6. O fluxo operacional hoje

**Guardar uma gaiola:**

1. O operador leva a gaiola até um vão livre.
2. Abre o sistema no celular → Endereçar → COLOCAR.
3. Bipa o QR da prateleira e o QR da gaiola (ordem livre).
4. Confirma. O sistema grava a ocupação.

**Retirar:**

1. Endereçar → RETIRAR.
2. Bipa **um** dos dois QR.
3. Confirma. A ocupação recebe data de saída e o endereço volta a ficar livre.

**Endereçar o estoque que já existe:** como todas as gaiolas do galpão já têm
QR, endereçar o estoque atual é só percorrer e ler — nada precisa ser reimpresso.

---

## 7. O que NÃO existe — e é aqui que a discussão interessa

Esta seção é o motivo do documento. Nada abaixo é omissão acidental.

### 7.1 O risco central: o mapa envelhece calado

**Não existe hoje nenhum momento em que o sistema fique sabendo que uma gaiola
deixou o galpão.** A saída acontece no carregamento do caminhão, fora do
sistema. Se a baixa depender só de alguém lembrar de bipar, o mapa começa certo
e em duas semanas mente. E **mapa que mente é pior que mapa nenhum**, porque as
pessoas param de conferir.

Mitigação atual, que é paliativo e não solução: o mapa mostra **há quantos dias**
cada endereço está ocupado e marca em amarelo o que está parado há 30 dias ou
mais. O esquecimento aparece sozinho, sem ninguém procurar.

### 7.2 Não existe conferência / auditoria

Não há como varrer uma rua com o celular e comparar o que o sistema diz que está
lá contra o que está de fato. Estava previsto como "ponto 3", não foi feito.

### 7.3 Não existe separação (picking) nem FIFO

O sistema sabe onde cada gaiola está, mas não ajuda a decidir **qual** gaiola
pegar. Não há sugestão de rota de coleta, não há reserva de gaiola para um
pedido, não há política FIFO/FEFO aplicada, não há noção de "esta gaiola está
prometida para a carga de amanhã".

### 7.4 Não existe integração com pedidos ou carga

O endereçamento é uma ilha. Não conversa com o Bling, nem com a carteira de
pedidos, nem com o processo de montagem de carga (que hoje é feito à parte).

### 7.5 Não existe sugestão de posição

Quando o operador vai guardar uma gaiola, o sistema não diz onde. Ele escolhe o
vão, e o sistema só valida. Não há critério de proximidade, agrupamento por SKU,
nem balanceamento entre ruas.

### 7.6 Não existe visão de ocupação no tempo

Existe o histórico linha a linha, mas nenhuma leitura de taxa de ocupação,
giro por posição, tempo médio de permanência, ou sazonalidade.

### 7.7 Ainda pendente do lado físico

As alturas reais dos níveis nunca foram medidas — os desenhos usam valores
proporcionais.

---

## 8. Restrições que qualquer proposta precisa respeitar

Estas são condições da operação, não preferências.

1. **A fábrica está em operação total.** Nada pode introduzir risco de parar a
   pesagem. Qualquer mudança precisa ser reversível e provada antes de subir.
2. **O envio ao Bling é imediato** após cada finalização de operação. Nada pode
   atrasar ou enfileirar isso.
3. **O galpão não pode depender de internet.** O que roda no celular tem que
   funcionar com a estação na rede local, sem CDN e sem serviço externo.
4. **A leitura é por celular, com luva.** Alvos de toque de no mínimo 44 px,
   texto legível, e sempre um caminho alternativo quando a câmera falha
   (digitação manual).
5. **Etiquetas já impressas não podem ser invalidadas.** Qualquer extensão de
   formato de QR tem que ser retrocompatível, como foi o 7º campo.
6. **Nada de atualização sem consentimento.** Quem publica é o responsável, e a
   atualização remota só entra em janela segura (sem sessão com bipagem
   pendente).
7. **O banco é SQLite local, num Mini PC.** Sem servidor de banco, sem nuvem,
   sem fila de mensagens. Soluções que exijam infraestrutura nova precisam
   justificar o custo operacional numa fábrica sem equipe de TI dedicada.
8. **Regra de negócio importante vira trava de banco**, não verificação em
   código. É o padrão adotado no projeto.

---

## 9. Perguntas em aberto

As que valem discussão, em ordem de impacto:

1. **Como amarrar a baixa a um evento que já acontece?** O carregamento é o
   candidato natural. Existe uma conferência de carga? Uma nota fiscal? Um
   momento em que alguém já conta o que está subindo no caminhão? A baixa
   precisa pegar carona em algo que já é feito — se depender de um passo novo,
   será esquecido.
2. **Vale um "modo conferência" periódico** (varrer uma rua e reconciliar) como
   rede de segurança, mesmo com a baixa automática? Com que frequência? Quem
   faz?
3. **Sugerir posição na hora de guardar vale a pena?** O critério óbvio seria
   agrupar por SKU para facilitar a coleta depois — mas isso conflita com
   "guarde no vão mais próximo", que é o que a operação faz naturalmente.
4. **Reserva de gaiola para um pedido** resolveria retrabalho no carregamento,
   ou criaria um estado a mais para alguém esquecer de limpar?
5. **FIFO importa neste produto?** Sacola plástica não vence, mas gaiola parada
   ocupa vão. O indicador de dias parados já expõe isso — falta decidir se vira
   regra ou continua sendo informação.
6. **Qual o custo real do endereçamento errado hoje?** Sem essa medida, é
   difícil dizer quanto vale automatizar a baixa.

---

## 10. Números de referência

| | |
|---|---|
| Posições no galpão | 138 (136 úteis) |
| Capacidade | 136 gaiolas, uma por posição |
| Ruas | 2 (20 e 26 vãos por nível) |
| Níveis | 3 (01 chão = GRANDE; 02 e 03 = PEQUENA) |
| SKUs de produto acabado | 36 (4 cores × 9 formatos, com trava de máquina) |
| Peso do fardo | 25 kg |
| Etiqueta | 100 × 150 mm, térmica, EPL2 |
| Banco | SQLite local (WAL, synchronous=FULL) |
| Verificações automatizadas do endereçamento | 85 |
| Verificações automatizadas do sistema todo | 327 |

---

## 11. Glossário

| Termo | Significado |
|---|---|
| **Gaiola** | estrutura metálica paletizável que acumula fardos de um mesmo SKU; a unidade que é endereçada |
| **Fardo** | pacote de sacolas de 25 kg |
| **Vão / posição** | um lugar de prateleira, identificado por `RR-NN-PPP` |
| **Ocupação** | o vínculo entre uma gaiola e uma posição, com entrada e (talvez) saída |
| **Bipar** | ler um código com a câmera do celular ou com leitor |
| **Estação de pesagem** | a aplicação Node.js que roda no Mini PC da fábrica |
| **Big bag** | embalagem de matéria-prima; etiqueta começa com `R`, **não** é endereçável |
| **Bobina** | produto da extrusão; etiqueta começa com `E`, **não** é endereçável |
| **Bling** | o ERP usado pela empresa |
| **P1 / P2** | as duas máquinas de produção de sacola |
