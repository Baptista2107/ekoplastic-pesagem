// ════════════════════════════════════════════════════════════════════
//  TROCA DAS ETIQUETAS DE MP PELO LAYOUT NOVO (QR + barras) — 25/11/2026
//  Gustavo: "consegue puxar as etiquetas que existem atualmente pra fazer
//  a troca pra nova" + "imprime separado por cliente" (na MP o "cliente" é
//  o FORNECEDOR da etiqueta).
//
//  Lógica pura (sem banco, sem impressora), testada em testes/troca-etiquetas.js.
//  Quem imprime é tools/reimprimir-mp-lote.js, pela rota de reimpressão.
// ════════════════════════════════════════════════════════════════════

const ATIVA = new Set(['bipada']);                 // no galpão: nem consumida nem cancelada
const TIPOS = new Set(['recebimento', 'retorno']);

const _norm = v => String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\s+/g, ' ').trim().toUpperCase();

// Quais etiquetas entram na troca: R/T ainda no galpão, com o número certo.
function etiquetasDaTroca(etiquetas) {
  return (etiquetas || []).filter(e => e && TIPOS.has(e.tipo) && ATIVA.has(e.status) && /^[RT]\d{7}$/.test(e.id || ''));
}

// Agrupa por fornecedor (sem diferença de acento/maiúscula/espaço) e ordena:
// grupos por nome; dentro do grupo material, cor, lote e número.
function agruparPorFornecedor(etiquetas) {
  const grupos = new Map();
  for (const e of etiquetasDaTroca(etiquetas)) {
    const chave = _norm(e.fornecedor) || '(SEM FORNECEDOR)';
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(e);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...grupos.entries()]
    .sort((a, b) => cmp(a[0], b[0]))
    .map(([fornecedor, itens]) => ({
      fornecedor,
      itens: itens.sort((a, b) =>
        cmp(_norm(a.material_nome), _norm(b.material_nome)) || cmp(_norm(a.cor), _norm(b.cor)) ||
        cmp(_norm(a.lote), _norm(b.lote)) || cmp(a.id, b.id)),
      kg: itens.reduce((s, e) => s + (Number(e.peso) || 0), 0),
    }));
}

// Etiqueta de separação (100x150, EPL) que sai antes de cada fornecedor.
function eplSeparador(grupo, n, total) {
  const limpa = s => _norm(s).replace(/["\\]/g, ' ').replace(/[^\x20-\x7E]/g, ' ');
  const nome = limpa(grupo.fornecedor);
  const linhasNome = [];
  for (let i = 0; i < nome.length && linhasNome.length < 3; i += 26) linhasNome.push(nome.slice(i, i + 26));
  const qtd = `${grupo.itens.length} ETIQUETA${grupo.itens.length === 1 ? '' : 'S'}`;
  const kg  = `${Math.round(grupo.kg).toLocaleString('pt-BR')} KG`;
  const ids = `${grupo.itens[0].id} ATE ${grupo.itens[grupo.itens.length - 1].id}`;
  return `N
q800
Q1200,24

A40,60,0,4,2,2,N,"TROCA DE ETIQUETAS"
A40,130,0,4,1,2,N,"ETIQUETA NOVA (QR) - COLAR POR CIMA"
LO30,200,740,6

A40,240,0,4,1,2,N,"FORNECEDOR"
${linhasNome.map((l, i) => `A40,${300 + i * 80},0,4,2,3,N,"${l}"`).join('\n')}

LO30,560,740,6
A40,600,0,4,2,3,N,"${qtd}"
A40,700,0,4,2,3,N,"${kg}"
A40,820,0,4,1,2,N,"${ids.replace(/"/g, ' ')}"

LO30,900,740,6
A40,940,0,4,2,3,N,"GRUPO ${n} DE ${total}"
A40,1060,0,4,1,2,N,"SOBROU ETIQUETA? BAG NAO ACHADO: AVISAR"

P1
`;
}

module.exports = { etiquetasDaTroca, agruparPorFornecedor, eplSeparador };
