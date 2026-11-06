// ════════════════════════════════════════════════════════════════════
//  BANCO SQLITE — abertura, tabelas, migrações e consultas comuns
//
//  Roda na subida, nesta ordem: esquema, tabelas do coletor, migrações v3→v7,
//  importação legada e as consultas preparadas (dbStmts, configGet/configSet).
// ════════════════════════════════════════════════════════════════════

const fs     = require('fs');

const { DB_FILE, LEGACY_JSON } = require('./config');
const { logI, logW } = require('./log');

// ════════════════════════════════════════════════════════════════════
//  BANCO SQLITE (node:sqlite — built-in do Node 22.5+)
//  Tabelas: etiquetas, sessoes, seqs, config
// ════════════════════════════════════════════════════════════════════

let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch(e) {
  console.error('\n[FATAL] node:sqlite não disponível.');
  console.error('Requer Node.js 22.5 ou superior. Sua versão: ' + process.version);
  console.error('Atualize Node em https://nodejs.org/\n');
  process.exit(1);
}

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA synchronous = FULL');
db.exec('PRAGMA foreign_keys = ON');

// Wrapper de transaction (este projeto usa node:sqlite built-in, Node 22.5+;
// a API de transação é manual via BEGIN/COMMIT/ROLLBACK, ao contrário do
// db.transaction() do better-sqlite3)
function makeTransaction(fn) {
  return (...args) => {
    db.exec('BEGIN');
    try {
      const r = fn(...args);
      db.exec('COMMIT');
      return r;
    } catch(e) {
      try { db.exec('ROLLBACK'); } catch(e2) {}
      throw e;
    }
  };
}

// ─── Schema (idempotente — só cria o que não existir) ───
function aplicarSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS etiquetas (
      id              TEXT PRIMARY KEY,
      seq             INTEGER NOT NULL,
      seq_sessao      INTEGER,
      tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao','outras','produto-acabado')),
      sub_tipo        TEXT,
      material_key    TEXT NOT NULL,
      material_nome   TEXT,
      material_label  TEXT,
      cor             TEXT,
      fornecedor      TEXT NOT NULL,
      lote            TEXT NOT NULL,
      peso            REAL NOT NULL CHECK(peso >= 0),
      qtd_sacos       INTEGER,
      codigo          TEXT NOT NULL,
      sku             TEXT NOT NULL,
      status          TEXT NOT NULL CHECK(status IN ('aguardando_bipe','bipada','cancelada','consumida')),
      ref_id          TEXT,
      hora_impressao  TEXT NOT NULL,
      hora_bipagem    TEXT,
      sessao_id       INTEGER,
      impressora      TEXT,
      -- Campos específicos da Extrusão (NULL pros tipos de MP)
      operador        TEXT,
      maquina         TEXT,
      largura         TEXT,
      tipo_bobina     TEXT,
      turno_codigo    TEXT,
      bling_pedido_id INTEGER,
      peso_bruto      REAL,
      tara            REAL,
      FOREIGN KEY (sessao_id) REFERENCES sessoes(id)
    );

    CREATE TABLE IF NOT EXISTS sessoes (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao','outras','produto-acabado')),
      inicio          TEXT NOT NULL,
      fim             TEXT,
      fornecedor      TEXT,
      total_kg        REAL,
      total_etiquetas INTEGER,
      bling_status    TEXT CHECK(bling_status IN ('pendente_config','pendente','enviado','erro','cancelada','parcial') OR bling_status IS NULL),
      bling_id        TEXT,
      bling_erro      TEXT,
      -- Campos específicos da Extrusão (NULL pros tipos de MP)
      operador        TEXT,
      maquina         TEXT,
      turno_codigo    TEXT
    );

    CREATE TABLE IF NOT EXISTS seqs (
      tipo  TEXT PRIMARY KEY,
      valor INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS config (
      chave TEXT PRIMARY KEY,
      valor TEXT
    );

    -- ── ENDEREÇAMENTO DO GALPÃO (04/09/2026) ──────────────────────
    -- Uma linha por vão de prateleira. Código RR-NN-PPP: rua, nível de
    -- ALTURA (01 chão, 02 meio, 03 alto) e posição ao longo da rua.
    -- O nível 01 é mais alto de propósito: é onde entram as gaiolas
    -- grandes. Duas posições existem no papel mas não recebem palete
    -- (hidrante e espaço da informação) e nascem bloqueadas.
    CREATE TABLE IF NOT EXISTS posicoes (
      codigo      TEXT PRIMARY KEY,
      rua         INTEGER NOT NULL,
      nivel       INTEGER NOT NULL,
      posicao     INTEGER NOT NULL,
      tipo_gaiola TEXT,
      bloqueada   INTEGER NOT NULL DEFAULT 0,
      motivo      TEXT
    );

    -- Quem morou em cada endereço, e quando. Não é só o estado atual: a
    -- linha continua depois da saída, com a data de saída preenchida. É
    -- o que permite responder "o que estava nesta posição semana passada".
    -- O retrato da gaiola (formato, cor, fardos, kg) fica gravado aqui
    -- porque a etiqueta pode ser reimpressa com outros números.
    CREATE TABLE IF NOT EXISTS ocupacoes (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      posicao       TEXT NOT NULL,
      gaiola_id     TEXT NOT NULL,
      entrada       TEXT NOT NULL,
      saida         TEXT,
      operador_e    TEXT,
      operador_s    TEXT,
      motivo_saida  TEXT,
      formato       TEXT,
      cor           TEXT,
      fardos        INTEGER,
      kg            REAL,
      tipo_gaiola   TEXT,
      FOREIGN KEY (posicao) REFERENCES posicoes(codigo)
    );

    CREATE INDEX IF NOT EXISTS idx_etiq_tipo_status ON etiquetas(tipo, status);
    CREATE INDEX IF NOT EXISTS idx_etiq_sessao      ON etiquetas(sessao_id);
    CREATE INDEX IF NOT EXISTS idx_etiq_hora        ON etiquetas(hora_impressao DESC);
    CREATE INDEX IF NOT EXISTS idx_sessoes_status   ON sessoes(bling_status);

    -- As duas regras do endereçamento viram TRAVA DE BANCO, não de código:
    -- um endereço só tem um morador, e uma gaiola só mora num lugar.
    -- Índice parcial (só as ocupações abertas) — código com erro esbarra
    -- aqui antes de sujar o dado.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ocup_posicao_aberta ON ocupacoes(posicao)   WHERE saida IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ocup_gaiola_aberta  ON ocupacoes(gaiola_id) WHERE saida IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ocup_gaiola ON ocupacoes(gaiola_id);

    -- ── SEPARAÇÃO E CARREGAMENTO (09/09/2026) ─────────────────────
    -- Fecha o ciclo do endereçamento. O separador já vai até o vão e já
    -- tira a gaiola de lá; bipar naquele instante não é trabalho a mais,
    -- e é o que dá a BAIXA sem depender de alguém lembrar depois.

    -- Uma carga. Nasce quando a foto da guia de separação é enviada.
    CREATE TABLE IF NOT EXISTS separacoes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      criada_em  TEXT NOT NULL,
      arquivo    TEXT,               -- nome do arquivo da foto/PDF da guia
      status     TEXT NOT NULL,      -- rascunho|conferida|em_separacao|concluida|cancelada
      operador   TEXT,
      obs        TEXT
    );

    -- Os pedidos da carga, na ORDEM DE CARREGAMENTO que o gestor definir.
    -- Primeiro a carregar = último a entregar; quem decide é ele, não o
    -- sistema — o alocador só respeita a sequência.
    CREATE TABLE IF NOT EXISTS separacao_pedidos (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      separacao_id INTEGER NOT NULL,
      ordem        INTEGER NOT NULL,
      cliente      TEXT, cidade TEXT, uf TEXT,
      FOREIGN KEY (separacao_id) REFERENCES separacoes(id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sep_ordem ON separacao_pedidos(separacao_id, ordem);

    -- As linhas do pedido, já em FARDOS (a guia vem em kg; 1 fardo = 25 kg).
    CREATE TABLE IF NOT EXISTS separacao_itens (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      pedido_id INTEGER NOT NULL,
      cor_key   TEXT NOT NULL,
      formato   TEXT NOT NULL,
      fardos    INTEGER NOT NULL,
      FOREIGN KEY (pedido_id) REFERENCES separacao_pedidos(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sep_itens_pedido ON separacao_itens(pedido_id);

    -- O plano: de qual endereço tirar e quanto vai para cada pedido.
    CREATE TABLE IF NOT EXISTS separacao_coletas (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      separacao_id INTEGER NOT NULL,
      gaiola_id    TEXT NOT NULL,
      posicao      TEXT NOT NULL,
      cor_key      TEXT, formato TEXT, tipo_gaiola TEXT,
      fardos_na_gaiola INTEGER NOT NULL,
      reparticao   TEXT NOT NULL,     -- JSON {"1":6,"2":14} = fardos por ordem de pedido
      sobra        INTEGER NOT NULL DEFAULT 0,
      status       TEXT NOT NULL,     -- planejada|coletada|nao_encontrada
      coletada_em  TEXT, operador TEXT,
      FOREIGN KEY (separacao_id) REFERENCES separacoes(id)
    );
    CREATE INDEX IF NOT EXISTS idx_sep_coletas ON separacao_coletas(separacao_id, status);

    -- A fila de reetiquetagem: gaiola que saiu do endereço mas não foi
    -- 100% usada. Enquanto não for endereçada de novo, fica aqui.
    CREATE TABLE IF NOT EXISTS sobras (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      separacao_id  INTEGER,
      gaiola_origem TEXT NOT NULL,
      gaiola_nova   TEXT,
      cor_key TEXT, formato TEXT, tipo_gaiola TEXT,
      fardos        INTEGER NOT NULL,
      posicao_origem   TEXT,
      posicao_sugerida TEXT,
      posicao_final    TEXT,
      status        TEXT NOT NULL,   -- aguardando_impressao|impressa|enderecada
      criada_em TEXT NOT NULL, resolvida_em TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sobras_status ON sobras(status);

    INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('recebimento', 1), ('retorno', 1), ('retirada', 1), ('extrusao', 1);
  `);

  // Duas colunas que a guia traz e o banco jogava fora: o rótulo da
  // coluna ("CARGA 1 · Entrega #4") e o número do pedido. São a
  // referência que o gestor usa para decidir a ORDEM DE CARREGAMENTO —
  // sem elas a tela de ordem mostra só nomes de cliente repetidos e ele
  // não tem como saber qual carga é qual. Aditivo: banco que já rodou
  // ganha a coluna vazia, sem perder nada.
  // Retirada de bobina para a sacoleira (28/09/2026, VPS): para onde a bobina
  // foi, quando, em que turno e quem bipou. Antes o destino só ia para a
  // observação do Bling e para a lista do dia em `config` — não chegava ao
  // rastreio bobina → sacola. `baixa_em` é separado de `hora_bipagem` para
  // não depender do que a bipagem da extrusão gravou ali.
  for (const [tabela, coluna, tipo] of [
    ['separacao_pedidos', 'carga', 'TEXT'],
    ['separacao_pedidos', 'pedido_numero', 'TEXT'],
    ['etiquetas', 'destino', 'TEXT'],
    ['etiquetas', 'baixa_em', 'TEXT'],
    ['etiquetas', 'baixa_turno', 'TEXT'],
    ['etiquetas', 'baixa_operador', 'TEXT'],
    // Quantos fardos a bobina rendeu na sacoleira, informado pelo operador
    // ao trocar a bobina ou ao encerrar o turno. NULL = ninguém informou
    // (ex.: turno anterior não foi encerrado) — nunca vira zero.
    ['etiquetas', 'fardos', 'INTEGER'],
    ['etiquetas', 'encerrada_em', 'TEXT'],
    ['etiquetas', 'encerrada_motivo', 'TEXT'],   // troca | finalizada
    // Carimbo de TODA mudança de bobina na sacoleira (entrada, troca,
    // finalizar, desfazer). É por ele que o exportador acha o que mudou
    // mesmo em bobina impressa há mais de 7 dias — a janela normal do
    // exportador é por data de IMPRESSÃO. Não dá para usar baixa_em: o
    // desfazer apaga esse campo, e a bobina desfeita nunca seria reenviada.
    ['etiquetas', 'alterado_em', 'TEXT'],
    // 29/09/2026 (Gustavo): o formato que a bobina virou na sacoleira, dito
    // (ou confirmado) pelo operador quando ela sai. formato_origem diz se o
    // operador aceitou a sugestão do sistema ('sugerido') ou escolheu outro
    // ('escolhido'). É o que liga bobina → formato → fardos → quem cortou.
    ['etiquetas', 'formato_cortado', 'TEXT'],
    ['etiquetas', 'formato_origem', 'TEXT'],
    // 30/09/2026: total exato da bobina em pacotes (fardo = 5). Ver lerParte.
    ['etiquetas', 'pacotes', 'INTEGER'],
    // 01/10/2026 (Gustavo): quantas emendas a bobina tem, dito na pesagem da
    // extrusão. A VPS usa o número para procurar ONDE elas aconteceram nos
    // sinais da extrusora (o CLP não vê toda emenda: há emenda sem a máquina
    // parar nem desacelerar). NULL = não informado (etiqueta antiga).
    ['etiquetas', 'emendas', 'INTEGER'],
  ]) {
    const tem = db.prepare(`PRAGMA table_info(${tabela})`).all().some(c => c.name === coluna);
    if (!tem) db.exec(`ALTER TABLE ${tabela} ADD COLUMN ${coluna} ${tipo}`);
  }
}
aplicarSchema();

// ── INVENTÁRIO DE BOBINAS (28/09/2026, VPS) ─────────────────────────────
// O operador bipa toda bobina que está fisicamente no estoque. SÓ REGISTRA:
// não muda status de etiqueta nenhuma. Até hoje a baixa de bobina não era
// usada, então 1.547 etiquetas de extrusão constam "bipada" (em estoque) só
// porque nunca foram baixadas. A lista contada é que diz o estoque real; o
// que fazer com as que não aparecerem é decisão à parte, com a lista na mão.
// A `situacao` guarda o que o SISTEMA achava da bobina na hora da leitura.
db.exec(`
  CREATE TABLE IF NOT EXISTS inventario_bobinas (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    inicio    TEXT NOT NULL,
    fim       TEXT,
    operador  TEXT
  );
  CREATE TABLE IF NOT EXISTS inventario_bobinas_itens (
    inventario_id INTEGER NOT NULL,
    etiqueta_id   TEXT NOT NULL,
    lido_em       TEXT NOT NULL,
    situacao      TEXT,          -- estoque | na_sacoleira | usada | cancelada | refugo
    operador      TEXT,
    PRIMARY KEY (inventario_id, etiqueta_id)
  );
`);

// ── TURNO DO CORTE (30/09/2026, VPS, pedido do Gustavo) ──────────────────
// O turno das sacoleiras é MARCADO pelo supervisor no coletor, não tirado do
// relógio: o painel de operação da VPS corta a linha do tempo da máquina
// nestes registros. Uma linha por sacoleira (as duas costumam ir juntas, mas
// podem não ir). Turno aberto = fim NULL; no máximo um aberto por sacoleira.
// Iniciar um turno numa sacoleira que já tem outro aberto ENCERRA o anterior
// no mesmo instante (motivo 'troca') — na virada é um toque só. "Encerrar"
// fecha sem abrir outro (motivo 'encerrado'): a máquina fica fora de turno.
// Não mexe em bobina: a bobina montada segue na máquina de um turno para o outro.
db.exec(`
  CREATE TABLE IF NOT EXISTS turnos_corte (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    maquina       TEXT NOT NULL,   -- P1 | P2
    turno         TEXT NOT NULL,   -- A | C | EXTRA
    inicio        TEXT NOT NULL,   -- ISO UTC
    fim           TEXT,            -- NULL = aberto
    fim_motivo    TEXT,            -- troca | encerrado
    aberto_por    TEXT,
    encerrado_por TEXT,
    alterado_em   TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_turnos_corte_maq ON turnos_corte (maquina, inicio);
`);

// ── FARDOS POR TURNO (30/09/2026, pedido do Gustavo) ─────────────────────
// Encerrar o turno NÃO é acabar a bobina: ela continua montada e o próximo
// turno segue cortando. Então, ao fechar o turno de uma sacoleira que tem
// bobina montada, o supervisor informa quantos fardos ela deu NAQUELE turno
// (momento 'turno'). Quando a bobina sai de vez (troca ou Finalizar), o
// operador informa só a parte do turno dele (momento 'final'). O total da
// bobina, em etiquetas.fardos, é a SOMA das partes.
// Cada parte guarda o turno do corte aberto na hora: é por ela que o painel
// da VPS soma fardos por turno.
db.exec(`
  CREATE TABLE IF NOT EXISTS bobina_parciais (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    etiqueta_id     TEXT NOT NULL,   -- a bobina
    maquina         TEXT NOT NULL,   -- P1 | P2
    turno_corte_id  INTEGER,         -- turnos_corte.id aberto na hora (NULL = fora de turno)
    turno           TEXT,            -- A | C | EXTRA (cópia, para ler sem join)
    fardos          INTEGER NOT NULL,
    formato         TEXT,
    formato_origem  TEXT,            -- sugerido | escolhido
    momento         TEXT NOT NULL,   -- turno (bobina segue montada) | final (bobina saiu)
    registrado_em   TEXT NOT NULL,
    operador        TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_bobina_parciais_etq ON bobina_parciais (etiqueta_id);
  CREATE INDEX IF NOT EXISTS ix_bobina_parciais_reg ON bobina_parciais (registrado_em);
`);
// 30/09/2026 (pacotes soltos, ver lerParte): `fardos` passa a ser os fardos
// FECHADOS informados; `pacotes` é a produção da parte; `soltos_fim` o que
// ficou no fardo aberto. Partes antigas (sem pacotes) valem fardos × 5.
// 01/10/2026 (Gustavo): a parte pode ser corrigida no resumo do turno
// (fardos digitados a mais). `fardos_antes` guarda o que foi digitado na
// primeira vez; `editado_em` faz o exportador reenviar a parte para a VPS.
for (const [col, tipo] of [['pacotes', 'INTEGER'], ['soltos_fim', 'INTEGER'],
                           ['editado_em', 'TEXT'], ['editado_por', 'TEXT'], ['fardos_antes', 'INTEGER']]) {
  if (!db.prepare(`PRAGMA table_info(bobina_parciais)`).all().some(c => c.name === col))
    db.exec(`ALTER TABLE bobina_parciais ADD COLUMN ${col} ${tipo}`);
}

// ── TROCA DE FORMATO COM A BOBINA MONTADA (02/10/2026, pedido do Gustavo) ─
// Mudar o formato da sacola no meio de uma bobina: o operador toca "Trocar
// formato" e informa os fardos fechados + soltos do formato QUE ESTAVA rodando
// (parte 'setup', com esse formato). Ele NÃO escolhe o novo: o sistema espera
// o comprimento do CLP da sacoleira mudar (ex.: 505 → 455 mm) e decide pela
// regra de sempre (máquina → largura da bobina → comprimento). Até lá a bobina
// fica "aguardando". Os soltos do formato antigo não se misturam com o novo
// (soltosNaMaquina). Sem senha. A leitura do CLP só define o novo quando DUAS
// leituras seguidas (carimbos diferentes) dão o mesmo formato diferente do
// antigo — o comprimento passa por valores no meio do ajuste.
db.exec(`
  CREATE TABLE IF NOT EXISTS bobina_setups (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    etiqueta_id          TEXT NOT NULL,
    maquina              TEXT NOT NULL,
    parte_id             INTEGER,        -- a parte 'setup' com os fardos do formato antigo
    formato_antes        TEXT,
    comprimento_antes_mm REAL,           -- o que o CLP mostrava ao tocar (só para mostrar)
    pedido_em            TEXT NOT NULL,
    operador             TEXT,
    candidato            TEXT,           -- formato novo visto numa leitura, esperando confirmar
    candidato_tempo      TEXT,           -- carimbo do CLP dessa leitura
    formato_novo         TEXT,
    comprimento_novo_mm  REAL,
    definido_em          TEXT
  );
  CREATE INDEX IF NOT EXISTS ix_bobina_setups_etq ON bobina_setups (etiqueta_id);
`);

// ── REFUGO DE BOBINA (02/10/2026, Gustavo) ───────────────────────────────
// Bobina que entrou na sacoleira, deu 1 ou 2 fardos e não serve para o
// produto acabado. O operador FINALIZA no coletor (como sempre), leva ao Mini
// PC, e em Outras pesagens → REFUGO bipa a ETIQUETA ANTIGA e pesa: ela volta
// ao estoque como refugo. Não imprime etiqueta nova, não vai ao Bling.
// O peso da etiqueta (o da extrusão) NÃO muda — é ele que mede o aproveitamento
// e o comprimento da bobina; o peso do refugo fica aqui, à parte.
// Ela PODE voltar à produção: bipada de novo em /bobinas/baixa, abre uma nova
// montagem (reaproveitado_em). Os fardos das duas montagens somam na etiqueta;
// estado_antes guarda a montagem anterior para o "desfazer" poder voltar atrás.
db.exec(`
  CREATE TABLE IF NOT EXISTS bobina_refugos (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    etiqueta_id      TEXT NOT NULL,
    peso             REAL NOT NULL,   -- líquido (bruto − eixo)
    peso_bruto       REAL,
    tara             REAL,
    pesado_em        TEXT NOT NULL,
    operador         TEXT,
    destino_antes    TEXT,            -- sacoleira de onde saiu (P1/P2)
    pacotes_antes    INTEGER,         -- pacotes da etiqueta ao virar refugo
    reaproveitado_em TEXT,            -- NULL = está no estoque como refugo
    reaproveitado_destino TEXT,
    estado_antes     TEXT,            -- JSON da montagem anterior (para desfazer)
    cancelado_em     TEXT,
    alterado_em      TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS ix_bobina_refugos_etq ON bobina_refugos (etiqueta_id);
`);

// ─── Migração v3: estender CHECK das tabelas pra aceitar tipo='retirada' ───
// SQLite não permite ALTER de CHECK; recria a tabela mantendo os dados.
// Detecta a necessidade tentando inserir uma linha sentinela.
function migrarSchemaParaV3() {
  // Tenta inserir uma sessão sentinela com tipo='retirada' — se aceitar, schema já está v3
  let precisaMigrar = false;
  try {
    db.prepare(`INSERT INTO sessoes (tipo, inicio) VALUES ('retirada', '__migrate_test__')`).run();
    db.prepare(`DELETE FROM sessoes WHERE inicio = '__migrate_test__'`).run();
  } catch(e) {
    if (/CHECK constraint failed/i.test(e.message) || /constraint/i.test(e.message)) {
      precisaMigrar = true;
    } else {
      throw e;
    }
  }
  if (!precisaMigrar) return;

  logI('db', 'Migrando schema para v3 (suporte a tipo=retirada)...');
  // SQLite recomenda desligar FKs durante migrações que recriam tabelas
  // (ALTER TABLE ... RENAME quebraria temporariamente as referências).
  // Ref: https://www.sqlite.org/lang_altertable.html#otheralter
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    const tr = makeTransaction(() => {
      // ── etiquetas: recriar com novo CHECK ──
      db.exec(`
        CREATE TABLE etiquetas_v3 (
          id              TEXT PRIMARY KEY,
          seq             INTEGER NOT NULL,
          tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada')),
          sub_tipo        TEXT,
          material_key    TEXT NOT NULL,
          material_nome   TEXT,
          material_label  TEXT,
          cor             TEXT,
          fornecedor      TEXT NOT NULL,
          lote            TEXT NOT NULL,
          peso            REAL NOT NULL CHECK(peso >= 0),
          qtd_sacos       INTEGER,
          codigo          TEXT NOT NULL,
          sku             TEXT NOT NULL,
          status          TEXT NOT NULL CHECK(status IN ('aguardando_bipe','bipada','cancelada','consumida')),
          ref_id          TEXT,
          hora_impressao  TEXT NOT NULL,
          hora_bipagem    TEXT,
          sessao_id       INTEGER,
          impressora      TEXT,
          FOREIGN KEY (sessao_id) REFERENCES sessoes(id)
        );
        INSERT INTO etiquetas_v3 SELECT * FROM etiquetas;
        DROP TABLE etiquetas;
        ALTER TABLE etiquetas_v3 RENAME TO etiquetas;
      `);

      // ── sessoes: recriar com novo CHECK ──
      db.exec(`
        CREATE TABLE sessoes_v3 (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada')),
          inicio          TEXT NOT NULL,
          fim             TEXT,
          fornecedor      TEXT,
          total_kg        REAL,
          total_etiquetas INTEGER,
          bling_status    TEXT CHECK(bling_status IN ('pendente_config','pendente','enviado','erro','cancelada') OR bling_status IS NULL),
          bling_id        TEXT,
          bling_erro      TEXT
        );
        INSERT INTO sessoes_v3 SELECT * FROM sessoes;
        DROP TABLE sessoes;
        ALTER TABLE sessoes_v3 RENAME TO sessoes;
      `);

      // ── índices ──
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_etiq_tipo_status ON etiquetas(tipo, status);
        CREATE INDEX IF NOT EXISTS idx_etiq_sessao      ON etiquetas(sessao_id);
        CREATE INDEX IF NOT EXISTS idx_etiq_hora        ON etiquetas(hora_impressao DESC);
        CREATE INDEX IF NOT EXISTS idx_sessoes_status   ON sessoes(bling_status);
      `);

      // ── seq de retirada ──
      db.exec(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('retirada', 1)`);
    });
    tr();
    // Verifica integridade das FKs após migração
    const orfas = db.prepare(`PRAGMA foreign_key_check`).all();
    if (orfas.length > 0) {
      logW('db', `Migração v3: ${orfas.length} referência(s) FK órfã(s) encontradas`, { exemplo: orfas[0] });
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
  logI('db', 'Schema migrado para v3 com sucesso');
}
migrarSchemaParaV3();

// ──────────────────────────────────────────────────────────────────
// Migração v4 — coluna seq_sessao (numeração da etiqueta DENTRO da sessão)
// Permite rastreabilidade visual "Big Bag #1, #2, #3" nos logs, etiqueta
// impressa e na descrição dos itens do Bling.
// ──────────────────────────────────────────────────────────────────
function migrarSchemaParaV4() {
  const cols = db.prepare("PRAGMA table_info(etiquetas)").all();
  const tem = cols.some(c => c.name === 'seq_sessao');
  if (tem) return;
  logI('db', 'Migrando schema para v4 (adicionando seq_sessao)...');
  db.exec('ALTER TABLE etiquetas ADD COLUMN seq_sessao INTEGER');
  logI('db', 'Schema migrado para v4 com sucesso');
}
migrarSchemaParaV4();

// ──────────────────────────────────────────────────────────────────
// Migração v5 — Suporte completo à Extrusão de Bobinas
//   1) Estende CHECK de tipo pra incluir 'extrusao' em etiquetas e sessoes
//   2) Estende CHECK de bling_status com 'parcial' (envio individual fracionado)
//   3) Adiciona colunas específicas da Extrusão:
//      etiquetas:  operador, maquina, largura, tipo_bobina, turno_codigo,
//                  bling_pedido_id, peso_bruto, tara
//      sessoes:    operador, maquina, turno_codigo
//   4) Adiciona seq 'extrusao' (prefixo E)
// ──────────────────────────────────────────────────────────────────
function migrarSchemaParaV5() {
  // Detecta se CHECK aceita 'extrusao'
  let checkOk = true;
  try {
    db.prepare(`INSERT INTO sessoes (tipo, inicio) VALUES ('extrusao', '__migrate_v5_test__')`).run();
    db.prepare(`DELETE FROM sessoes WHERE inicio = '__migrate_v5_test__'`).run();
  } catch(e) {
    if (/CHECK constraint failed/i.test(e.message) || /constraint/i.test(e.message)) checkOk = false;
    else throw e;
  }

  const colsE = db.prepare("PRAGMA table_info(etiquetas)").all().map(c => c.name);
  const colsS = db.prepare("PRAGMA table_info(sessoes)").all().map(c => c.name);
  const temOperadorE = colsE.includes('operador');
  const temOperadorS = colsS.includes('operador');

  if (checkOk && temOperadorE && temOperadorS) {
    // Já está em v5 — só garante a seq extrusao
    db.prepare(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('extrusao', 1)`).run();
    return;
  }

  logI('db', 'Migrando schema para v5 (suporte à Extrusão)...');

  if (!checkOk) {
    // Precisa recriar as tabelas pra trocar o CHECK
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      const tr = makeTransaction(() => {
        // ── etiquetas: recriar com novo CHECK + colunas extras ──
        db.exec(`
          CREATE TABLE etiquetas_v5 (
            id              TEXT PRIMARY KEY,
            seq             INTEGER NOT NULL,
            seq_sessao      INTEGER,
            tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao')),
            sub_tipo        TEXT,
            material_key    TEXT NOT NULL,
            material_nome   TEXT,
            material_label  TEXT,
            cor             TEXT,
            fornecedor      TEXT NOT NULL,
            lote            TEXT NOT NULL,
            peso            REAL NOT NULL CHECK(peso >= 0),
            qtd_sacos       INTEGER,
            codigo          TEXT NOT NULL,
            sku             TEXT NOT NULL,
            status          TEXT NOT NULL CHECK(status IN ('aguardando_bipe','bipada','cancelada','consumida')),
            ref_id          TEXT,
            hora_impressao  TEXT NOT NULL,
            hora_bipagem    TEXT,
            sessao_id       INTEGER,
            impressora      TEXT,
            operador        TEXT,
            maquina         TEXT,
            largura         TEXT,
            tipo_bobina     TEXT,
            turno_codigo    TEXT,
            bling_pedido_id INTEGER,
            peso_bruto      REAL,
            tara            REAL,
            FOREIGN KEY (sessao_id) REFERENCES sessoes(id)
          );
          INSERT INTO etiquetas_v5 (
            id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome,
            material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo,
            sku, status, ref_id, hora_impressao, hora_bipagem, sessao_id, impressora
          )
          SELECT
            id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome,
            material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo,
            sku, status, ref_id, hora_impressao, hora_bipagem, sessao_id, impressora
          FROM etiquetas;
          DROP TABLE etiquetas;
          ALTER TABLE etiquetas_v5 RENAME TO etiquetas;
          CREATE INDEX IF NOT EXISTS idx_etiq_tipo_status ON etiquetas(tipo, status);
          CREATE INDEX IF NOT EXISTS idx_etiq_sessao      ON etiquetas(sessao_id);
          CREATE INDEX IF NOT EXISTS idx_etiq_hora        ON etiquetas(hora_impressao DESC);
        `);

        // ── sessoes: recriar com novo CHECK + colunas extras ──
        db.exec(`
          CREATE TABLE sessoes_v5 (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao')),
            inicio          TEXT NOT NULL,
            fim             TEXT,
            fornecedor      TEXT,
            total_kg        REAL,
            total_etiquetas INTEGER,
            bling_status    TEXT CHECK(bling_status IN ('pendente_config','pendente','enviado','erro','cancelada','parcial') OR bling_status IS NULL),
            bling_id        TEXT,
            bling_erro      TEXT,
            operador        TEXT,
            maquina         TEXT,
            turno_codigo    TEXT
          );
          INSERT INTO sessoes_v5 (
            id, tipo, inicio, fim, fornecedor, total_kg, total_etiquetas,
            bling_status, bling_id, bling_erro
          )
          SELECT
            id, tipo, inicio, fim, fornecedor, total_kg, total_etiquetas,
            bling_status, bling_id, bling_erro
          FROM sessoes;
          DROP TABLE sessoes;
          ALTER TABLE sessoes_v5 RENAME TO sessoes;
          CREATE INDEX IF NOT EXISTS idx_sessoes_status ON sessoes(bling_status);
        `);
      });
      tr();
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  } else {
    // CHECK já estava ok, mas faltam colunas
    if (!temOperadorE) {
      db.exec(`
        ALTER TABLE etiquetas ADD COLUMN operador        TEXT;
        ALTER TABLE etiquetas ADD COLUMN maquina         TEXT;
        ALTER TABLE etiquetas ADD COLUMN largura         TEXT;
        ALTER TABLE etiquetas ADD COLUMN tipo_bobina     TEXT;
        ALTER TABLE etiquetas ADD COLUMN turno_codigo    TEXT;
        ALTER TABLE etiquetas ADD COLUMN bling_pedido_id INTEGER;
        ALTER TABLE etiquetas ADD COLUMN peso_bruto      REAL;
        ALTER TABLE etiquetas ADD COLUMN tara            REAL;
      `);
    }
    if (!temOperadorS) {
      db.exec(`
        ALTER TABLE sessoes ADD COLUMN operador      TEXT;
        ALTER TABLE sessoes ADD COLUMN maquina       TEXT;
        ALTER TABLE sessoes ADD COLUMN turno_codigo  TEXT;
      `);
    }
  }

  db.prepare(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('extrusao', 1)`).run();
  logI('db', 'Schema migrado para v5 com sucesso');
}
migrarSchemaParaV5();

// ──────────────────────────────────────────────────────────────────
// Migração v6 — Suporte ao processo OUTRAS PESAGENS (inventário/resíduos)
//   Estende o CHECK de tipo pra incluir 'outras' em etiquetas e sessoes.
//   Recria as tabelas (única forma de trocar um CHECK no SQLite), copiando
//   TODAS as colunas e dados. Idempotente: só roda se o CHECK ainda não
//   aceitar 'outras'. Adiciona também a seq 'outras' (prefixo O).
// ──────────────────────────────────────────────────────────────────
function migrarSchemaParaV6() {
  // Detecta se CHECK já aceita 'outras'
  let checkOk = true;
  try {
    db.prepare(`INSERT INTO sessoes (tipo, inicio) VALUES ('outras', '__migrate_v6_test__')`).run();
    db.prepare(`DELETE FROM sessoes WHERE inicio = '__migrate_v6_test__'`).run();
  } catch(e) {
    if (/constraint/i.test(e.message)) checkOk = false;
    else throw e;
  }

  if (checkOk) {
    // Já aceita 'outras' — só garante a seq
    db.prepare(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('outras', 1)`).run();
    return;
  }

  logI('db', 'Migrando schema para v6 (suporte a OUTRAS PESAGENS)...');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    const tr = makeTransaction(() => {
      // ── etiquetas: recriar com CHECK estendido, copiando TUDO ──
      db.exec(`
        CREATE TABLE etiquetas_v6 (
          id              TEXT PRIMARY KEY,
          seq             INTEGER NOT NULL,
          seq_sessao      INTEGER,
          tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao','outras')),
          sub_tipo        TEXT,
          material_key    TEXT NOT NULL,
          material_nome   TEXT,
          material_label  TEXT,
          cor             TEXT,
          fornecedor      TEXT NOT NULL,
          lote            TEXT NOT NULL,
          peso            REAL NOT NULL CHECK(peso >= 0),
          qtd_sacos       INTEGER,
          codigo          TEXT NOT NULL,
          sku             TEXT NOT NULL,
          status          TEXT NOT NULL CHECK(status IN ('aguardando_bipe','bipada','cancelada','consumida')),
          ref_id          TEXT,
          hora_impressao  TEXT NOT NULL,
          hora_bipagem    TEXT,
          sessao_id       INTEGER,
          impressora      TEXT,
          operador        TEXT,
          maquina         TEXT,
          largura         TEXT,
          tipo_bobina     TEXT,
          turno_codigo    TEXT,
          bling_pedido_id INTEGER,
          peso_bruto      REAL,
          tara            REAL,
          FOREIGN KEY (sessao_id) REFERENCES sessoes(id)
        );
        INSERT INTO etiquetas_v6 (
          id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome,
          material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo, sku,
          status, ref_id, hora_impressao, hora_bipagem, sessao_id, impressora,
          operador, maquina, largura, tipo_bobina, turno_codigo, bling_pedido_id,
          peso_bruto, tara
        )
        SELECT
          id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome,
          material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo, sku,
          status, ref_id, hora_impressao, hora_bipagem, sessao_id, impressora,
          operador, maquina, largura, tipo_bobina, turno_codigo, bling_pedido_id,
          peso_bruto, tara
        FROM etiquetas;
        DROP TABLE etiquetas;
        ALTER TABLE etiquetas_v6 RENAME TO etiquetas;
        CREATE INDEX IF NOT EXISTS idx_etiq_tipo_status ON etiquetas(tipo, status);
        CREATE INDEX IF NOT EXISTS idx_etiq_sessao      ON etiquetas(sessao_id);
        CREATE INDEX IF NOT EXISTS idx_etiq_hora        ON etiquetas(hora_impressao DESC);
      `);

      // ── sessoes: recriar com CHECK estendido, copiando TUDO ──
      db.exec(`
        CREATE TABLE sessoes_v6 (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao','outras')),
          inicio          TEXT NOT NULL,
          fim             TEXT,
          fornecedor      TEXT,
          total_kg        REAL,
          total_etiquetas INTEGER,
          bling_status    TEXT CHECK(bling_status IN ('pendente_config','pendente','enviado','erro','cancelada','parcial') OR bling_status IS NULL),
          bling_id        TEXT,
          bling_erro      TEXT,
          operador        TEXT,
          maquina         TEXT,
          turno_codigo    TEXT
        );
        INSERT INTO sessoes_v6 (
          id, tipo, inicio, fim, fornecedor, total_kg, total_etiquetas,
          bling_status, bling_id, bling_erro, operador, maquina, turno_codigo
        )
        SELECT
          id, tipo, inicio, fim, fornecedor, total_kg, total_etiquetas,
          bling_status, bling_id, bling_erro, operador, maquina, turno_codigo
        FROM sessoes;
        DROP TABLE sessoes;
        ALTER TABLE sessoes_v6 RENAME TO sessoes;
        CREATE INDEX IF NOT EXISTS idx_sessoes_status ON sessoes(bling_status);
      `);
    });
    tr();
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  db.prepare(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('outras', 1)`).run();
  logI('db', 'Schema migrado para v6 com sucesso');
}
migrarSchemaParaV6();

// ──────────────────────────────────────────────────────────────────
// Migração v7: adiciona o tipo 'produto-acabado' ao CHECK de etiquetas
// e sessoes (entrada de sacolas/fardos no Bling ao fim do turno). Recria
// as tabelas copiando TODAS as colunas, igual à v6. Idempotente via
// test-insert (se já aceita 'produto-acabado', só garante a seq).
// ──────────────────────────────────────────────────────────────────
function migrarSchemaParaV7() {
  let checkOk = true;
  try {
    db.prepare(`INSERT INTO sessoes (tipo, inicio) VALUES ('produto-acabado', '__migrate_v7_test__')`).run();
    db.prepare(`DELETE FROM sessoes WHERE inicio = '__migrate_v7_test__'`).run();
  } catch(e) {
    if (/constraint/i.test(e.message)) checkOk = false;
    else throw e;
  }

  if (checkOk) {
    db.prepare(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('produto-acabado', 1)`).run();
    return;
  }

  logI('db', 'Migrando schema para v7 (suporte a PRODUTO ACABADO)...');
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    const tr = makeTransaction(() => {
      db.exec(`
        CREATE TABLE etiquetas_v7 (
          id              TEXT PRIMARY KEY,
          seq             INTEGER NOT NULL,
          seq_sessao      INTEGER,
          tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao','outras','produto-acabado')),
          sub_tipo        TEXT,
          material_key    TEXT NOT NULL,
          material_nome   TEXT,
          material_label  TEXT,
          cor             TEXT,
          fornecedor      TEXT NOT NULL,
          lote            TEXT NOT NULL,
          peso            REAL NOT NULL CHECK(peso >= 0),
          qtd_sacos       INTEGER,
          codigo          TEXT NOT NULL,
          sku             TEXT NOT NULL,
          status          TEXT NOT NULL CHECK(status IN ('aguardando_bipe','bipada','cancelada','consumida')),
          ref_id          TEXT,
          hora_impressao  TEXT NOT NULL,
          hora_bipagem    TEXT,
          sessao_id       INTEGER,
          impressora      TEXT,
          operador        TEXT,
          maquina         TEXT,
          largura         TEXT,
          tipo_bobina     TEXT,
          turno_codigo    TEXT,
          bling_pedido_id INTEGER,
          peso_bruto      REAL,
          tara            REAL,
          FOREIGN KEY (sessao_id) REFERENCES sessoes(id)
        );
        INSERT INTO etiquetas_v7 (
          id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome,
          material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo, sku,
          status, ref_id, hora_impressao, hora_bipagem, sessao_id, impressora,
          operador, maquina, largura, tipo_bobina, turno_codigo, bling_pedido_id,
          peso_bruto, tara
        )
        SELECT
          id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome,
          material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo, sku,
          status, ref_id, hora_impressao, hora_bipagem, sessao_id, impressora,
          operador, maquina, largura, tipo_bobina, turno_codigo, bling_pedido_id,
          peso_bruto, tara
        FROM etiquetas;
        DROP TABLE etiquetas;
        ALTER TABLE etiquetas_v7 RENAME TO etiquetas;
        CREATE INDEX IF NOT EXISTS idx_etiq_tipo_status ON etiquetas(tipo, status);
        CREATE INDEX IF NOT EXISTS idx_etiq_sessao      ON etiquetas(sessao_id);
        CREATE INDEX IF NOT EXISTS idx_etiq_hora        ON etiquetas(hora_impressao DESC);
      `);

      db.exec(`
        CREATE TABLE sessoes_v7 (
          id              INTEGER PRIMARY KEY AUTOINCREMENT,
          tipo            TEXT NOT NULL CHECK(tipo IN ('recebimento','retorno','retirada','extrusao','outras','produto-acabado')),
          inicio          TEXT NOT NULL,
          fim             TEXT,
          fornecedor      TEXT,
          total_kg        REAL,
          total_etiquetas INTEGER,
          bling_status    TEXT CHECK(bling_status IN ('pendente_config','pendente','enviado','erro','cancelada','parcial') OR bling_status IS NULL),
          bling_id        TEXT,
          bling_erro      TEXT,
          operador        TEXT,
          maquina         TEXT,
          turno_codigo    TEXT
        );
        INSERT INTO sessoes_v7 (
          id, tipo, inicio, fim, fornecedor, total_kg, total_etiquetas,
          bling_status, bling_id, bling_erro, operador, maquina, turno_codigo
        )
        SELECT
          id, tipo, inicio, fim, fornecedor, total_kg, total_etiquetas,
          bling_status, bling_id, bling_erro, operador, maquina, turno_codigo
        FROM sessoes;
        DROP TABLE sessoes;
        ALTER TABLE sessoes_v7 RENAME TO sessoes;
        CREATE INDEX IF NOT EXISTS idx_sessoes_status ON sessoes(bling_status);
      `);
    });
    tr();
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  db.prepare(`INSERT OR IGNORE INTO seqs(tipo, valor) VALUES ('produto-acabado', 1)`).run();
  logI('db', 'Schema migrado para v7 com sucesso');
}
migrarSchemaParaV7();

// Migração leve: coluna data_lancamento na sessão — data escolhida pelo operador
// (calendário) para o lançamento no Bling. Quando ausente, usa-se a regra padrão.
function migrarAddDataLancamento() {
  const cols = db.prepare("PRAGMA table_info(sessoes)").all();
  if (cols.some(c => c.name === 'data_lancamento')) return;
  logI('db', 'Migrando: adicionando sessoes.data_lancamento...');
  db.exec('ALTER TABLE sessoes ADD COLUMN data_lancamento TEXT');
  logI('db', 'Coluna data_lancamento adicionada.');
}
migrarAddDataLancamento();

// ─── Migração: importar etiquetas-db.json se SQLite estiver vazio ───
function migrarLegacy() {
  const count = db.prepare('SELECT COUNT(*) AS n FROM etiquetas').get().n;
  if (count > 0) return;
  if (!fs.existsSync(LEGACY_JSON)) {
    // Nenhum legacy — cria seed mínimo pra testes
    return seedInicial();
  }
  try {
    const j = JSON.parse(fs.readFileSync(LEGACY_JSON, 'utf8'));
    if (!j.etiquetas || Object.keys(j.etiquetas).length === 0) return seedInicial();
    const insert = db.prepare(`INSERT OR IGNORE INTO etiquetas
      (id, seq, tipo, material_key, material_nome, cor, fornecedor, lote, peso, codigo, sku, status, hora_impressao, impressora)
      VALUES (@id, @seq, @tipo, @materialKey, @materialNomeEt, @cor, @fornecedor, @lote, @peso, @codigo, @sku, @status, @hora_impressao, @impressora)`);
    const tr = makeTransaction(items => {
      for (const it of items) {
        try { insert.run({ ...it, impressora: it.impressora || null }); } catch(e) { /* skip */ }
      }
    });
    tr(Object.values(j.etiquetas));
    if (j.proximoSeq) {
      const up = db.prepare('UPDATE seqs SET valor = ? WHERE tipo = ?');
      if (j.proximoSeq.recebimento) up.run(j.proximoSeq.recebimento, 'recebimento');
      if (j.proximoSeq.retorno)     up.run(j.proximoSeq.retorno,     'retorno');
    }
    logI('db', `Migração legacy: ${Object.keys(j.etiquetas).length} etiquetas importadas de etiquetas-db.json`);
    // Renomeia o legacy pra evitar re-importar
    try { fs.renameSync(LEGACY_JSON, LEGACY_JSON + '.migrado'); } catch(e) {}
  } catch(e) {
    logW('db', 'Falha ao migrar legacy', { erro: e.message });
  }
}

function seedInicial() {
  // Cria 3 etiquetas de exemplo se banco vazio (pra facilitar teste do Retorno)
  const seed = [
    { id:'R0000001', seq:1, tipo:'recebimento', material_key:'GBD',  cor:'Colorido', fornecedor:'Cedro', peso:945.5, lote:'180526', codigo:'COL1',   sku:'GBD.COL.CEDRO | 945 | L180526', status:'bipada' },
    { id:'R0000002', seq:2, tipo:'recebimento', material_key:'GBD',  cor:'Colorido', fornecedor:'Cedro', peso:891.2, lote:'180526', codigo:'COL1',   sku:'GBD.COL.CEDRO | 891 | L180526', status:'bipada' },
    { id:'R0000003', seq:3, tipo:'recebimento', material_key:'POLI', cor:'Cristal',  fornecedor:'Ycaro', peso:935.0, lote:'190526', codigo:'NCRIS1', sku:'POLI.CRIS.YCARO | 935 | L190526', status:'bipada' },
  ];
  const insert = db.prepare(`INSERT INTO etiquetas
    (id, seq, tipo, material_key, cor, fornecedor, lote, peso, codigo, sku, status, hora_impressao)
    VALUES (@id, @seq, @tipo, @material_key, @cor, @fornecedor, @lote, @peso, @codigo, @sku, @status, @hora_impressao)`);
  const agora = new Date().toISOString();
  const tr = makeTransaction(items => { for (const it of items) insert.run({...it, hora_impressao: agora}); });
  tr(seed);
  db.prepare('UPDATE seqs SET valor = 4 WHERE tipo = ?').run('recebimento');
  logI('db', `Seed inicial criado (3 etiquetas exemplo)`);
}
migrarLegacy();

// ─── Helpers de acesso ao banco ───
const dbStmts = {
  proximoSeq:       db.prepare('SELECT valor FROM seqs WHERE tipo = ?'),
  incSeq:           db.prepare('UPDATE seqs SET valor = MAX(valor, ? + 1) WHERE tipo = ?'),
  getEtiqueta:      db.prepare('SELECT * FROM etiquetas WHERE id = ?'),
  insertEtiqueta:   db.prepare(`INSERT INTO etiquetas
    (id, seq, seq_sessao, tipo, sub_tipo, material_key, material_nome, material_label, cor, fornecedor, lote, peso, qtd_sacos, codigo, sku, status, ref_id, hora_impressao, sessao_id, impressora,
     operador, maquina, largura, tipo_bobina, turno_codigo, peso_bruto, tara)
    VALUES (@id, @seq, @seq_sessao, @tipo, @sub_tipo, @material_key, @material_nome, @material_label, @cor, @fornecedor, @lote, @peso, @qtd_sacos, @codigo, @sku, @status, @ref_id, @hora_impressao, @sessao_id, @impressora,
     @operador, @maquina, @largura, @tipo_bobina, @turno_codigo, @peso_bruto, @tara)`),
  marcarBipada:     db.prepare('UPDATE etiquetas SET status = ?, hora_bipagem = ? WHERE id = ?'),
  marcarCancelada:  db.prepare('UPDATE etiquetas SET status = ? WHERE id = ?'),
  corrigirEtiqueta: db.prepare(`UPDATE etiquetas SET material_key=@material_key, material_nome=@material_nome, material_label=@material_label, cor=@cor, fornecedor=@fornecedor, lote=@lote, codigo=@codigo, sku=@sku WHERE id=@id`),
  listEtiquetas:    db.prepare('SELECT * FROM etiquetas WHERE 1=1'),
  abrirSessao:      db.prepare('INSERT INTO sessoes (tipo, inicio, fornecedor, operador, maquina, turno_codigo, data_lancamento) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  fecharSessao:     db.prepare(`UPDATE sessoes SET fim = ?, total_kg = ?, total_etiquetas = ?, bling_status = ? WHERE id = ?`),
  getSessao:        db.prepare('SELECT * FROM sessoes WHERE id = ?'),
  updSessaoBling:   db.prepare('UPDATE sessoes SET bling_status = ?, bling_id = ?, bling_erro = ? WHERE id = ?'),
  totaisSessao:     db.prepare(`SELECT COUNT(*) AS qtd, COALESCE(SUM(peso), 0) AS total_kg FROM etiquetas WHERE sessao_id = ? AND status = 'bipada'`),
  // No recebimento/retorno, um big bag retirado antes de finalizar fica
  // 'consumida' mas CONTINUA fazendo parte da entrada — os totais da sessão
  // precisam refletir o mesmo conjunto que vai ao Bling.
  totaisSessaoEntrada: db.prepare(`SELECT COUNT(*) AS qtd, COALESCE(SUM(peso), 0) AS total_kg FROM etiquetas WHERE sessao_id = ? AND status IN ('bipada','consumida')`),
  configGet:        db.prepare('SELECT valor FROM config WHERE chave = ?'),
  configSet:        db.prepare('INSERT INTO config(chave, valor) VALUES(?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'),
};

function getProximoSeq(tipo) { return dbStmts.proximoSeq.get(tipo)?.valor || 1; }
function incrementaSeq(tipo, seqUsado) { dbStmts.incSeq.run(seqUsado, tipo); }
function configGet(k, def) { return dbStmts.configGet.get(k)?.valor ?? def; }
function configSet(k, v)   { dbStmts.configSet.run(k, String(v)); }

// B4: recalcula total_kg/total_etiquetas de uma sessão a partir das
// etiquetas bipadas atuais. Chamado após cancelamentos para manter o
// histórico coerente. Só atualiza se a sessão já tiver totais (foi fechada).
// Totais da sessão pela MESMA regra do envio ao Bling.
function totaisDaSessao(sessao, sessaoId) {
  return sessaoContaConsumida(sessao && sessao.tipo)
    ? dbStmts.totaisSessaoEntrada.get(sessaoId) : dbStmts.totaisSessao.get(sessaoId);
}

// Sessões de ENTRADA no estoque: a etiqueta 'consumida' continua sendo parte
// dela (saiu DEPOIS de entrar). Recebimento/retorno: big bag retirado antes de
// finalizar. Extrusão (03/10/2026, Gustavo): com o coletor, a bobina é montada
// na sacoleira no mesmo turno em que foi pesada — a sessão C2 da C1 de 02/10
// fechou com 2 de 4 bobinas (916,5 de 2.062,5 kg) no resumo E no pedido de
// compra do Bling. Retirada/outras NÃO: lá vale a etiqueta virtual.
function sessaoContaConsumida(tipo) {
  return tipo === 'recebimento' || tipo === 'retorno' || tipo === 'extrusao';
}

function recalcularTotaisSessao(sessaoId) {
  try {
    const s = dbStmts.getSessao.get(sessaoId);
    if (!s) return;
    const tot = totaisDaSessao(s, sessaoId);
    db.prepare('UPDATE sessoes SET total_kg = ?, total_etiquetas = ? WHERE id = ?')
      .run(tot.total_kg, tot.qtd, sessaoId);
  } catch(e) { logW('db', `recalcularTotaisSessao #${sessaoId} falhou: ${e.message}`); }
}

module.exports = { configGet, configSet, db, dbStmts, getProximoSeq, incrementaSeq, makeTransaction,
  recalcularTotaisSessao, sessaoContaConsumida, totaisDaSessao, };
