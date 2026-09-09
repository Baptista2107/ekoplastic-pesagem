# Separação e carregamento — o Ponto 2 do endereçamento

**Desenho para aprovação.** 09/09/2026
Fecha o ciclo: hoje o sistema sabe **onde** cada gaiola está; falta ele saber
**quando ela sai** — e é a separação que dá essa informação de graça.

---

## 1. Por que esta etapa é a que faz o resto valer

No documento do endereçamento eu apontei o risco central: *não existe nenhum
momento em que o sistema fique sabendo que uma gaiola deixou o galpão*. Se a
baixa depender de alguém lembrar de bipar, o mapa começa certo e em duas semanas
mente.

A separação resolve isso sem criar passo novo: **o separador já vai até o
endereço e já tira a gaiola de lá.** Bipar naquele instante não é trabalho a
mais — é o mesmo gesto, com o celular na mão. A baixa pega carona num evento que
já acontece, que era exatamente a condição para ela não ser esquecida.

---

## 2. O ciclo, ponta a ponta

```
1. GUIA DE SEPARAÇÃO  →  enviada como foto/PDF na tela de endereçamento
2. CONFERÊNCIA        →  as linhas aparecem na tela; você confirma ou corrige
3. ORDEM DE CARREGAMENTO → você define (padrão: a mesma ordem da guia)
4. PLANO DE COLETA    →  o sistema diz, por pedido, de qual endereço tirar
5. COLETA             →  o separador bipa cada gaiola ao pegar
        ├── gaiola 100% usada  → endereço LIBERADO na hora
        └── gaiola com sobra   → vai para a aba SOBRAS
6. SOBRAS             →  imprime a etiqueta nova, cola, bipa no novo endereço
```

O passo 5 é a baixa automática. O passo 6 é o retrabalho de etiquetagem, que
deixa de ser improviso e vira uma fila com fim.

---

## 3. O pulo do gato: o alocador

Este é o miolo. Foi construído e testado antes de qualquer tela, porque é onde
errar custa caro — instrução errada de separação faz o galpão inteiro andar para
o lado errado.

### 3.1 A ideia

**A demanda é somada da carga inteira antes de alocar.** É isso, e só isso, que
faz uma mesma gaiola atender o pedido de agora e o de depois. Se cada pedido for
resolvido por si, cada um abre gaiola nova e cada um deixa uma sobra.

Depois de somada a demanda de um produto, o sistema procura **um conjunto de
gaiolas cuja soma dê exatamente essa demanda**. Quando existe, ninguém fica pela
metade: todos os endereços são liberados e não há reetiquetagem nenhuma. É um
problema de subconjunto-soma, resolvido por programação dinâmica — os números
aqui são pequenos (dezenas de gaiolas, centenas de fardos), então é instantâneo.

Quando não existe soma exata, ele escolhe o conjunto de **menor sobra possível**,
e essa sobra fica concentrada em **uma única gaiola** — nunca espalhada em
várias.

### 3.2 A ordem de prioridade

1. **Sobra zero**, se for possível.
2. **Menor sobra**, concentrada numa gaiola só.
3. **Menos gaiolas abertas.**
4. **FIFO** — as mais antigas saem inteiras, a **mais nova** fica como parcial.
   Assim o estoque gira e a sobra é sempre a mercadoria que entrou por último.

### 3.3 O que ele devolve

Por gaiola, uma linha de coleta:

```
G0000002   ·   01-01-002   ·   BC 50x60   ·   20 fardos na gaiola
   → 6 fardos para o pedido 1 (CLIENTE A / Teresina)
   → 14 fardos para o pedido 2 (CLIENTE B / Parnaíba)
   → sobra 0 — endereço será liberado
```

A linha "atende também o pedido 2" é o aviso que impede o separador de abrir uma
gaiola nova quando chegar no pedido seguinte. Como você separa **pedido a pedido,
cada um na sua pilha**, a gaiola compartilhada fica na doca entre um pedido e o
outro — e o plano diz isso com todas as letras. Por isso o alocador consome as
gaiolas **na ordem de carregamento**: o corte cai entre pedidos vizinhos, não
entre o primeiro e o último da fila.

### 3.4 O que já está provado

Seis cenários, todos passando:

| Teste | O que prova |
|---|---|
| [1] Soma exata | Demanda 44 com gaiolas de 24/20/16 → usa 24+20, **sobra zero**, dois endereços liberados |
| [2] Sem soma exata | Demanda 55 com gaiolas de 30 → abre 2, sobra 5 num só lugar, e a parcial é a mais nova |
| [3] Uma gaiola, três pedidos | 28 fardos atendem 10+8+10 numa **única ida** ao galpão, e ainda zeram a gaiola |
| [4] Comparação | ver abaixo |
| [5] Invariantes | **200 cargas sorteadas**: todo pedido recebe exatamente o que pediu, nenhuma gaiola entrega mais fardos do que tem, e nunca há duas sobras do mesmo produto |
| [6] Falta | Se não há produto endereçado suficiente, o sistema **avisa o déficit** em vez de mandar separar o que não existe |

**Teste [4] — média de 60 cargas sorteadas (6 pedidos, 3 itens cada):**

| | gaiolas abertas | sobras para reetiquetar |
|---|---|---|
| Processo de hoje (modelado) | 19,2 | 16,4 |
| Com o alocador | 15,1 | **8,6** |
| | −21% | **−48%** |

O "processo de hoje" aqui é um **modelo** do que você descreveu — cada pedido
separado por si, a gaiola que sobra saindo de circulação para reetiquetagem — e
não uma medição de campo. Serve para mostrar a ordem de grandeza, não para virar
meta.

> **Um bug que o teste pegou.** A primeira versão do alocador reconstruía a
> escolha por um único vetor de "pai", e isso permitia usar **a mesma gaiola duas
> vezes** no mesmo conjunto. O sistema achava que tinha mais fardos do que existe
> e mandava separar menos do que o pedido pedia. Só apareceu na semente 30 de 200
> cargas sorteadas — não apareceria em teste manual. A correção foi montar a
> programação dinâmica em camadas, uma por gaiola. Ficou registrado no código.

---

## 4. O que ainda precisa da sua decisão

**Como a guia vira lista de linhas.** Você quer enviar a foto/PDF pela própria
tela de endereçamento, num campo da guia de separação — isso está entendido e é
o que vou fazer. A pergunta que sobra é quem **lê** a imagem:

| Caminho | Como funciona | O preço |
|---|---|---|
| **A. Conferência na tela** (mais simples) | O arquivo sobe e fica exibido ao lado de uma grade já preenchida com os SKUs; você só digita as quantidades e a ordem | Zero dependência nova no Mini PC, funciona offline sempre. Mas é digitação |
| **B. OCR no Mini PC** | O script de leitura que já existe passa a rodar na estação | Precisa instalar tesseract e Python no Mini PC de produção. O OCR lê bem as quantidades e mal o nome do cliente — que, para separar, não faz falta |
| **C. Leitura aqui, importação lá** | Você manda a foto aqui como já faz; devolvo a lista conferida e a tela importa com um botão | Nada novo na estação, e passa por um olho antes de virar ordem de serviço. Mas depende de você estar aqui na hora |

**Minha recomendação: começar pelo A e deixar o B como aceleração depois.** O
motivo é que a conferência é obrigatória de qualquer jeito — quantidade errada na
guia manda o galpão inteiro para o lado errado —, então o A entrega o ciclo
completo já, sem colocar dependência nova numa máquina que não pode parar. Com o
ciclo rodando e a tela pronta, ligar o OCR depois é só trocar a origem dos
números.

---

## 5. O que muda no banco

Tudo aditivo. Nenhuma tabela existente muda de forma, nenhum dado atual se mexe.

```sql
-- Uma carga / guia de separação.
CREATE TABLE separacoes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  criada_em  TEXT NOT NULL,
  arquivo    TEXT,          -- caminho da foto/PDF enviada
  status     TEXT NOT NULL, -- rascunho | conferida | em_separacao | concluida | cancelada
  operador   TEXT,
  obs        TEXT
);

-- Os pedidos da carga, na ORDEM DE CARREGAMENTO definida pelo gestor.
CREATE TABLE separacao_pedidos (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  separacao_id INTEGER NOT NULL,
  ordem      INTEGER NOT NULL,     -- 1 = primeiro a carregar
  cliente    TEXT, cidade TEXT, uf TEXT,
  FOREIGN KEY (separacao_id) REFERENCES separacoes(id)
);
CREATE UNIQUE INDEX idx_sep_ordem ON separacao_pedidos(separacao_id, ordem);

-- As linhas do pedido, já em fardos (a guia vem em kg; 1 fardo = 25 kg).
CREATE TABLE separacao_itens (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  pedido_id  INTEGER NOT NULL,
  cor_key    TEXT NOT NULL,   -- AM | BC | PT | REC
  formato    TEXT NOT NULL,
  fardos     INTEGER NOT NULL,
  FOREIGN KEY (pedido_id) REFERENCES separacao_pedidos(id)
);

-- O plano: de qual endereço tirar, quanto vai para cada pedido.
CREATE TABLE separacao_coletas (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  separacao_id INTEGER NOT NULL,
  gaiola_id  TEXT NOT NULL,
  posicao    TEXT NOT NULL,
  cor_key    TEXT, formato TEXT,
  fardos_na_gaiola INTEGER NOT NULL,
  reparticao TEXT NOT NULL,     -- JSON {"1": 6, "2": 14}
  sobra      INTEGER NOT NULL DEFAULT 0,
  status     TEXT NOT NULL,     -- planejada | coletada | nao_encontrada | trocada
  coletada_em TEXT, operador TEXT
);

-- A fila de reetiquetagem. É a "aba do processo" com banco próprio.
CREATE TABLE sobras (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  separacao_id INTEGER,
  gaiola_origem TEXT NOT NULL,
  gaiola_nova   TEXT,           -- preenchido quando a etiqueta é gerada
  cor_key TEXT, formato TEXT, tipo_gaiola TEXT,
  fardos      INTEGER NOT NULL,
  posicao_sugerida TEXT,
  posicao_final    TEXT,
  status      TEXT NOT NULL,    -- aguardando_impressao | impressa | enderecada
  criada_em TEXT NOT NULL, resolvida_em TEXT
);
CREATE INDEX idx_sobras_status ON sobras(status);
```

**O estoque disponível não precisa de tabela nova.** As gaiolas endereçadas já
são as ocupações abertas (`ocupacoes WHERE saida IS NULL`), com formato, cor,
fardos e endereço. O alocador consulta exatamente isso.

**Uma mudança que eu recomendo junto:** hoje o cadastro das gaiolas vive num JSON
dentro da tabela `config`, guardando só as 2000 mais recentes. Com a
reetiquetagem gerando IDs novos a cada carga, esse teto passa a ser apertado, e
um ID que "cai da lista" vira uma etiqueta que o sistema não reconhece mais.
Vale promover para tabela de verdade, com `encerrada_em` — que é o que permite
**recusar a leitura de uma etiqueta antiga** que tenha sobrevivido colada na
gaiola.

---

## 6. As telas

Na tela de endereçamento, que hoje tem **Mapa** e **Endereçar**, entram duas:

### Separação
- Campo para enviar a **guia** (foto ou PDF), como você pediu. O arquivo fica
  visível na tela durante toda a conferência.
- **Conferência**: as linhas por cliente / cor / formato / quantidade, para
  confirmar ou corrigir. Mostra kg e fardos lado a lado e avisa quando um valor
  não é múltiplo de 25 kg.
- **Ordem de carregamento**: numeração dos pedidos, começando igual à guia. Com
  um lembrete de que o primeiro a carregar é o último a entregar.
- **Plano de coleta**: por pedido, a lista de endereços na ordem de caminhada
  pelo galpão — rua, depois vão crescente, para não ir e voltar no corredor.
  Cada linha diz quantos fardos, para quais pedidos, e se sobra.
- **Bipar ao coletar**: o separador lê o QR da gaiola (ou o do endereço) e a
  coleta é confirmada. É aqui que o endereço é liberado.

### Sobras
- A fila do que precisa ser reetiquetado, com produto, quantidade nova e o
  **endereço sugerido** — vão livre, preferindo o nível do chão e a ponta da rua
  mais perto da doca, porque sobra costuma sair de novo em breve.
- Botão **imprimir etiqueta**: sai a etiqueta de gaiola com **número novo**,
  mesmo produto, quantidade nova.
- O operador cola, leva ao endereço sugerido e **bipa** — e aí o sistema passa a
  saber que aquela posição tem aquele produto com aquela quantidade.
- Enquanto a sobra não for endereçada, ela aparece na aba como pendência. A fila
  tem fim visível.

---

## 7. Duas coisas que o chão de fábrica vai exigir

**O plano é uma foto de um instante.** Se o mapa estiver desatualizado, o
separador chega no endereço e não acha nada. A tela precisa do botão **"não está
aqui"**, que marca a coleta e **refaz a alocação na hora** com o que resta. Sem
isso, o primeiro erro de mapa trava a separação inteira e o pessoal abandona o
sistema.

**O separador pode pegar outra gaiola.** Ele está lá, viu uma mais perto, do
mesmo produto. O sistema deve **aceitar e replanejar**, não bloquear — a mesma
filosofia do "avisa, não impede" que já vale para gaiola grande em nível de cima.
Quem impede de verdade é a realidade do galpão.

---

## 8. Ordem de construção sugerida

Cada etapa é entregável e testável sozinha, e nenhuma mexe na pesagem.

| # | O que | Por que nesta ordem |
|---|---|---|
| 1 | **Alocador** portado para o `server.js` + suíte de testes | Já está pronto e provado em protótipo; portar é mecânico. Nada aparece na tela ainda |
| 2 | Tabelas + rotas de separação (criar, conferir, ordenar, planejar) | Testável por requisição, sem tela |
| 3 | Aba **Separação** com envio da guia, conferência e plano | Aqui você já consegue rodar uma carga de verdade lendo o plano na tela |
| 4 | **Bipe de coleta** → baixa automática do endereço | O ponto que fecha o ciclo. Só depois que o plano estiver confiável |
| 5 | Aba **Sobras** + etiqueta nova + endereçamento da sobra | O retrabalho vira fila com fim |
| 6 | "Não está aqui" e troca de gaiola com replanejamento | Endurece para o uso diário |

Sugiro rodar as etapas 3 e 4 em **paralelo com o papel** por uma ou duas cargas:
o separador segue a guia impressa como sempre, e alguém acompanha pelo celular
conferindo se o plano bate. É barato e é o que dá confiança para desligar o papel.

---

## 9. O que continua fora deste ciclo

Para não haver expectativa errada:

- **Não conversa com o Bling.** A separação é interna do galpão.
- **Não decide a carga nem a rota** — isso é a montagem de carga, que continua
  como está. A ordem de carregamento é informada por você, não calculada.
- **Não faz conferência de inventário.** Continua sendo o ponto 3.
- **Não reserva gaiola** para pedido futuro. A alocação vale para a carga que
  está sendo separada agora.

---

## 10. Arquivos deste desenho

| Arquivo | O que é |
|---|---|
| `alocador.py` | O alocador completo, comentado — é a referência para portar ao `server.js` |
| `testar_alocador.py` | Os seis cenários, incluindo as 200 cargas sorteadas |
