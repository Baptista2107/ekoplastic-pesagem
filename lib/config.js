// ════════════════════════════════════════════════════════════════════
//  CONFIGURAÇÃO — portas, pastas, impressoras e catálogos fixos
//
//  Valores que não dependem do banco. Caminhos partem da RAIZ do sistema.
// ════════════════════════════════════════════════════════════════════

const path   = require('path');


// Pasta do sistema (a raiz do repositorio, onde ficam banco, logs e public/).
const RAIZ = path.join(__dirname, '..');

// ════════════════════════════════════════════════════════════════════
//  CONFIGURAÇÃO
// ════════════════════════════════════════════════════════════════════

const PORT          = parseInt(process.env.EKO_PORT)     || 3000;
const PORT_CALLBACK = parseInt(process.env.EKO_PORT_CB)  || 8888;
const PORT_HTTPS    = parseInt(process.env.EKO_PORT_HTTPS) || 3443;
const VERSION       = 'v157';

// Catálogo de BOBINAS CAPA (aba "Capas" da extrusão). Não passam pelo
// gravimétrico; entram na MESMA sessão de extrusão do turno (sub_tipo='capa')
// e vão ao Bling com ID próprio. Tubete = tara fixa (peso do eixo) por capa.
const CAPAS_CATALOGO = {
  'CAPA.70X90':      { id: '16589753347', nome: 'Bobina Capa 70 x 90',  dim: '70 x 90',  tubete: 3 },
  'CAPA.60X90':      { id: '16589752073', nome: 'Bobina Capa 60 x 90',  dim: '60 x 90',  tubete: 3 },
  'BOB.CAPA.92x0,5': { id: '16619426133', nome: 'Bobina Capa 92 x 0,5', dim: '92 x 0,5', tubete: 2 },
};

// Catálogo de OUTRAS PESAGENS (processo de inventário / resíduos).
// Sessão própria (tipo='outras'), sem operador/máquina. Aparas NÃO têm produto
// no Bling (blingId null) — entram só no resumo; borra e varredura têm ID e
// são enviadas ao Bling (pedido de compra / entrada de estoque). categoria =
// agrupamento do resumo. A chave é o código do item (vira sku/codigo da etiqueta).
const OUTRAS_CATALOGO = {
  'APARA.AMARELA': { nome: 'Apara Amarela', cor: 'Amarela', categoria: 'APARA',   blingId: null },
  'APARA.VERDE':   { nome: 'Apara Verde',   cor: 'Verde',   categoria: 'APARA',   blingId: null },
  'APARA.PRETA':   { nome: 'Apara Preta',   cor: 'Preta',   categoria: 'APARA',   blingId: null },
  'APARA.BRANCA':  { nome: 'Apara Branca',  cor: 'Branca',  categoria: 'APARA',   blingId: null },
  'RES.BORRA':     { nome: 'Borra',         cor: null,      categoria: 'RESIDUO', blingId: '16572867363' },
  'RES.VARREDURA': { nome: 'Varredura',     cor: null,      categoria: 'RESIDUO', blingId: '16572867344' },
  // PÓ usa o MESMO produto da varredura no Bling (mesmo SKU e ID). O que os
  // distingue lá é a observação do pedido, montada no envio.
  'RES.PO':        { nome: 'Pó',            cor: null,      categoria: 'RESIDUO', blingId: '16572867344', skuBling: 'RES.VARREDURA' },
};

const SERIAL_PORT = process.env.EKO_SERIAL_PORT || 'COM1';
const SERIAL_BAUD = parseInt(process.env.EKO_SERIAL_BAUD) || 9600;

const PRINTER_NAMES = [
  '4BARCODE 4B-2074B',
  'ZDesigner GC420t (EPL)',     // Zebra GC420t com driver EPL (espaço entre 't' e '(')
  'ZDesigner GC420t(EPL)',      // variação sem espaço (caso o driver instale assim)
  'ELGIN L42-DT',
];

// EKO_TOKEN_FILE existe para o piso de testes usar um arquivo temporário.
// Sem isso, um teste que exercite o OAuth sobrescreveria o bling_tokens.json
// de verdade da máquina — e derrubaria a integração com o Bling.
const TOKEN_FILE  = process.env.EKO_TOKEN_FILE || path.join(RAIZ, 'bling_tokens.json');
const PS_SCRIPT   = path.join(RAIZ, 'enviar_raw.ps1');
const DB_FILE     = process.env.EKO_DB_FILE || path.join(RAIZ, 'etiquetas.db');
const PUBLIC_DIR  = path.join(RAIZ, 'public');
const LOG_DIR     = process.env.EKO_LOG_DIR || path.join(RAIZ, 'logs');
// Fotos das guias de separação. Fora do Git de propósito (são documentos
// de cliente) — ver a entrada /guias/ no .gitignore.
const GUIAS_DIR   = process.env.EKO_GUIAS_DIR || path.join(RAIZ, 'guias');
const BACKUP_DIR  = path.join(RAIZ, 'backups');
const LEGACY_JSON = path.join(RAIZ, 'etiquetas-db.json');

// ──────────────────────────────────────────────────────────────────
// PRODUTO ACABADO — mapas fixos (turnos, cores/produtos-pai, formatos).
// Cada FARDO = 25 kg. O operador escolhe turno (cliente) → formato → cor →
// nº de fardos. A entrada vai pro Bling como pedido de COMPRA (entrada de
// estoque), tendo o turno como fornecedor/contato.
//
// ATENÇÃO À VARIAÇÃO: cada COR é um produto com variações por formato. No
// Bling, todas as variações de uma cor compartilham o ID do produto-PAI; o
// que distingue a variação é a SKU (código). Por isso a SKU é a chave do
// item, e no envio REAL a SKU é resolvida para o id real da variação
// (ver resolverIdVariacaoPA / enviarSessaoBling).
// ──────────────────────────────────────────────────────────────────
const PA_KG_FARDO = 25;
const PA_TURNOS = {
  A:     { nome: 'TURNO A - SACOLEIRAS EKOPLASTIC',     bling: 17802279349 },
  C:     { nome: 'TURNO C - SACOLEIRAS EKOPLASTIC',     bling: 17803577652 },
  EXTRA: { nome: 'TURNO EXTRA - SACOLEIRAS EKOPLASTIC', bling: 18180509587 },
};
const PA_CORES = {
  AM:  { nome: 'Amarela',  label: 'SACOLA SEMI-VIRGEM AMARELA (25KG)', bling_pai: 16571281331 },
  BC:  { nome: 'Branca',   label: 'SACOLA SEMI-VIRGEM BRANCA (25KG)',  bling_pai: 16571279198 },
  PT:  { nome: 'Preta',    label: 'SACOLA RECICLADA PRETA (25KG)',     bling_pai: 16571276024 },
  REC: { nome: 'Colorida', label: 'SACOLA RECICLADA COLORIDA (25KG)',  bling_pai: 16571269944 },
};
const PA_FORMATOS = ['30x40','30x45','33x46','35x45','40x50','42x53','50x60','60x80','80x100'];
const PA_MAQUINAS = ['P1','P2'];
// Trava máquina × formato do Produto Acabado: cada máquina só produz os
// formatos da sua lista (40x50 é o único comum às duas). Evita lançamento
// de formato em máquina que não o produz.
// Materiais contados MANUALMENTE no inventário (sacos, não big bags com
// etiqueta): a contagem é nº de sacos × peso do saco.
const MP_CONTAGEM_MANUAL = { PIG: 25, DESSEC: 25, CARBO: 25, AUXFLUX: 25 };

const PA_FORMATOS_POR_MAQUINA = {
  P1: ['40x50', '50x60', '60x80', '80x100'],
  P2: ['30x40', '30x45', '33x46', '35x45', '40x50', '42x53'],
};

module.exports = { BACKUP_DIR, CAPAS_CATALOGO, DB_FILE, GUIAS_DIR, LEGACY_JSON, LOG_DIR,
  MP_CONTAGEM_MANUAL, OUTRAS_CATALOGO, PA_CORES, PA_FORMATOS, PA_FORMATOS_POR_MAQUINA, PA_KG_FARDO,
  PA_MAQUINAS, PA_TURNOS, PORT, PORT_CALLBACK, PORT_HTTPS, PRINTER_NAMES, PS_SCRIPT, PUBLIC_DIR,
  RAIZ, SERIAL_BAUD, SERIAL_PORT, TOKEN_FILE, VERSION, };
