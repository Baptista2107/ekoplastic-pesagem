// ════════════════════════════════════════════════════════════════════
//  SEPARAÇÃO — pedidos do Bling e o que falta no galpão
// ════════════════════════════════════════════════════════════════════

const { PA_CORES, PA_FORMATOS, PA_KG_FARDO } = require('./config');
const { configGet, configSet, db } = require('./db');
const { getToken, proxyChamada } = require('./bling');

// ══════════════════════════════════════════════════════════════════
//  PEDIDOS DIRETO DO BLING
// ------------------------------------------------------------------
//  A guia de separação é um RETRATO de um dado que já existe: ela sai
//  do painel de carteira, que por sua vez existe porque os pedidos
//  estão cadastrados no Bling. Fotografar a guia é fotografar uma
//  imagem de um número que o sistema pode buscar exato — e obrigava
//  alguém a redigitar a carga inteira.
//
//  Aqui a estação lê os pedidos na fonte. Nada de OCR, nada de
//  digitação, e a quantidade é a do Bling, não a que o olho leu.
// ══════════════════════════════════════════════════════════════════

// Traduz um item de pedido do Bling para (cor, formato) do galpão.
// O caminho bom é a SKU — 'BC.5060.5K' —, que é a mesma que a estação
// já usa para lançar produção. A descrição é rede de segurança para
// pedido antigo ou item cadastrado sem código.
function mapearItemBling(item) {
  const cod = String((item && (item.codigo || (item.produto && item.produto.codigo))) || '').toUpperCase().trim();
  const desc = String((item && (item.descricao || (item.produto && item.produto.nome))) || '').toUpperCase();
  const qtd = Number(item && item.quantidade) || 0;

  const digitosDoFormato = f => f.replace('x', '');
  let corKey = null, formato = null, via = null;

  const m = cod.match(/^(AM|BC|PT|REC)\.(\d+)\.5K$/);
  if (m) {
    corKey = m[1];
    formato = PA_FORMATOS.find(f => digitosDoFormato(f) === m[2]) || null;
    via = 'sku';
  }

  if (!corKey || !formato) {
    // Descrição: 'SACOLA SEMI VIRGEM BRANCA 30X45 (LEITOSA)'.
    // A ordem importa: 'SEMI VIRGEM BRANCA' antes de só 'BRANCA'.
    if (!corKey) {
      if (/AMAREL/.test(desc)) corKey = 'AM';
      else if (/BRANC|LEITOS/.test(desc)) corKey = 'BC';
      else if (/PRET/.test(desc)) corKey = 'PT';
      else if (/COLORID|RECICLAD/.test(desc)) corKey = 'REC';
    }
    if (!formato) {
      const mf = desc.match(/(\d{2,3})\s*X\s*(\d{2,3})/);
      if (mf) formato = PA_FORMATOS.find(f => f === `${Number(mf[1])}x${Number(mf[2])}`) || null;
    }
    if (corKey && formato) via = via || 'descricao';
  }

  const reconhecido = !!(corKey && formato);
  return {
    reconhecido, cor_key: corKey, formato, via,
    kg: qtd,
    fardos: reconhecido ? Math.ceil(qtd / PA_KG_FARDO) : 0,
    codigo: cod || null, descricao: (item && item.descricao) || null, quantidade: qtd,
    motivo: reconhecido ? null
      : (!corKey && !formato ? 'não reconheci a cor nem o formato'
         : !corKey ? 'não reconheci a cor' : 'não reconheci o formato'),
  };
}

// Lista de pedidos de venda em aberto. Leve de propósito: só o
// cabeçalho. Os itens só são buscados dos pedidos que entrarem na
// carga — buscar item de tudo levaria minutos e ninguém precisa.
async function blingPedidosAbertos(dias) {
  const token = await getToken();
  const desde = new Date(Date.now() - (dias || 45) * 86400000).toISOString().slice(0, 10);
  const pedidos = [];
  for (let pagina = 1; pagina <= 10; pagina++) {
    const r = await proxyChamada(token, 'GET', '/Api/v3/pedidos/vendas',
      `?pagina=${pagina}&limite=100&dataInicial=${desde}`, '');
    let d = {}; try { d = JSON.parse(r.body); } catch (e) {}
    const lista = Array.isArray(d.data) ? d.data : [];
    if (!lista.length) break;
    for (const p of lista) {
      // Já faturado saiu da fábrica; não entra em separação.
      const temNF = !!(p.notaFiscal && p.notaFiscal.id);
      if (temNF) continue;
      const nome = String((p.contato && p.contato.nome) || '');
      // Pedido interno de produção não é carga de cliente.
      if (/EKOPLASTIC|SACOLEIRAS/i.test(nome)) continue;
      pedidos.push({
        bling_id: p.id, numero: p.numero, data: p.data,
        cliente: nome, total: p.total,
        situacao: (p.situacao && (p.situacao.valor != null ? p.situacao.valor : p.situacao.id)) || null,
      });
    }
    if (lista.length < 100) break;
  }
  pedidos.sort((a, b) => String(b.data || '').localeCompare(String(a.data || '')));
  return pedidos;
}

// Itens de UM pedido, já traduzidos para o galpão.
async function blingItensDoPedido(blingId) {
  const token = await getToken();
  const r = await proxyChamada(token, 'GET', '/Api/v3/pedidos/vendas/' + encodeURIComponent(blingId), '', '');
  let d = {}; try { d = JSON.parse(r.body); } catch (e) {}
  const p = d.data || {};
  const itens = (Array.isArray(p.itens) ? p.itens : []).map(mapearItemBling);
  return {
    bling_id: p.id || blingId, numero: p.numero || null,
    cliente: String((p.contato && p.contato.nome) || ''),
    cidade: String((p.contato && p.contato.endereco && p.contato.endereco.municipio) || '') || null,
    uf: String((p.contato && p.contato.endereco && p.contato.endereco.uf) || '') || null,
    itens,
  };
}

// ══════════════════════════════════════════════════════════════════
//  O QUE FALTA NUMA SEPARAÇÃO
// ------------------------------------------------------------------
//  Quase nunca a guia inteira está pronta no galpão: parte está na
//  máquina e fica pronta no dia do carregamento. Isso NÃO é erro — é o
//  normal. O que seria erro é o sistema calar sobre isso e o caminhão
//  sair faltando carga.
//
//  A falta é calculada AO VIVO, a partir do que os pedidos pedem menos
//  o que as coletas (planejadas + já coletadas) entregam. Assim, no
//  instante em que a produção for endereçada e o plano for refeito, a
//  falta some sozinha — não fica um número velho gravado mentindo.
// ══════════════════════════════════════════════════════════════════
function faltasDaSeparacao(sepId) {
  const pedidos = db.prepare(
    'SELECT id, ordem, cliente FROM separacao_pedidos WHERE separacao_id = ? ORDER BY ordem').all(sepId);
  const pedido = {};
  const querem = new Map();                 // "ordem|cor|formato" -> fardos
  for (const p of pedidos) {
    pedido[p.ordem] = p;
    for (const it of db.prepare(
      'SELECT cor_key, formato, fardos FROM separacao_itens WHERE pedido_id = ?').all(p.id)) {
      const k = `${p.ordem}|${it.cor_key}|${it.formato}`;
      querem.set(k, (querem.get(k) || 0) + it.fardos);
    }
  }
  // Só as coletas que ainda valem: uma marcada "não encontrada" não
  // entrega nada, e o replanejamento já a substituiu.
  for (const c of db.prepare(
    `SELECT * FROM separacao_coletas WHERE separacao_id = ? AND status IN ('planejada','coletada')`).all(sepId)) {
    let rep = {}; try { rep = JSON.parse(c.reparticao); } catch (e) {}
    for (const [ordem, q] of Object.entries(rep)) {
      const k = `${ordem}|${c.cor_key}|${c.formato}`;
      if (querem.has(k)) querem.set(k, querem.get(k) - Number(q));
    }
  }

  const porItem = [], porSku = new Map();
  for (const [k, resto] of querem) {
    if (resto <= 0) continue;
    const [ordem, cor, formato] = k.split('|');
    const p = pedido[ordem] || {};
    porItem.push({ ordem: Number(ordem), cliente: p.cliente || null,
                   cor_key: cor, formato, faltam: resto, kg: resto * PA_KG_FARDO });
    const ks = `${cor}|${formato}`;
    porSku.set(ks, (porSku.get(ks) || 0) + resto);
  }
  porItem.sort((a, b) => a.ordem - b.ordem);
  const resumo = Array.from(porSku.entries()).map(([ks, q]) => {
    const [cor_key, formato] = ks.split('|');
    return { cor_key, formato, faltam: q, kg: q * PA_KG_FARDO };
  }).sort((a, b) => a.cor_key.localeCompare(b.cor_key) || a.formato.localeCompare(b.formato));
  return { por_item: porItem, por_produto: resumo,
           fardos: porItem.reduce((a, x) => a + x.faltam, 0) };
}

// ── Apoio: registro das gaiolas e estoque endereçado ──
function gaiolasRegistro() {
  try { return JSON.parse(configGet('gaiolas_pa', '{}')); } catch (e) { return {}; }
}
function gaiolasSalvar(reg) { configSet('gaiolas_pa', JSON.stringify(reg)); }

// Uma ocupação aberta é uma gaiola disponível no galpão. A cor gravada
// na ocupação é o NOME ('Branca'); o alocador trabalha com a CHAVE
// ('BC'), então o registro da gaiola tem prioridade e o nome é o
// caminho de volta para gaiola antiga que não esteja no registro.
function corKeyDaOcupacao(o, reg) {
  const r = reg[o.gaiola_id];
  if (r && r.corKey) return r.corKey;
  for (const [k, v] of Object.entries(PA_CORES))
    if (v.nome && o.cor && v.nome.toLowerCase() === String(o.cor).toLowerCase()) return k;
  return null;
}
function estoqueEnderecado() {
  const reg = gaiolasRegistro();
  const linhas = db.prepare(`SELECT o.*, p.nivel, p.rua FROM ocupacoes o
                             JOIN posicoes p ON p.codigo = o.posicao
                             WHERE o.saida IS NULL`).all();
  const out = [];
  for (const o of linhas) {
    const corKey = corKeyDaOcupacao(o, reg);
    const r = reg[o.gaiola_id] || {};
    const fardos = Number(o.fardos != null ? o.fardos : r.fardos) || 0;
    if (!corKey || !o.formato || fardos <= 0) continue;
    out.push({ id: o.gaiola_id, posicao: o.posicao, cor_key: corKey, formato: o.formato,
               fardos, entrada: o.entrada, tipo_gaiola: o.tipo_gaiola || r.tipo_gaiola || null });
  }
  return out;
}

// Vãos livres, na ordem de preferência para receber uma SOBRA: nível do
// chão primeiro (mais acessível — sobra costuma sair de novo em breve) e
// vão de menor número, que é a ponta da rua mais perto da doca.
function posicoesLivresPreferidas(tipoGaiola) {
  const linhas = db.prepare(`SELECT p.* FROM posicoes p
      LEFT JOIN ocupacoes o ON o.posicao = p.codigo AND o.saida IS NULL
      WHERE p.bloqueada = 0 AND o.id IS NULL`).all();
  const quer = String(tipoGaiola || '').toUpperCase();
  return linhas.sort((a, b) => {
    // gaiola GRANDE só cabe no nível 01; para as demais, o chão é o preferido
    const pa = (quer === 'GRANDE') ? (a.nivel === 1 ? 0 : 1) : (a.nivel === 1 ? 0 : 1);
    const pb = (quer === 'GRANDE') ? (b.nivel === 1 ? 0 : 1) : (b.nivel === 1 ? 0 : 1);
    return (pa - pb) || (a.rua - b.rua) || (a.posicao - b.posicao);
  }).map(p => p.codigo);
}

module.exports = { blingItensDoPedido, blingPedidosAbertos, estoqueEnderecado, faltasDaSeparacao,
  gaiolasRegistro, gaiolasSalvar, posicoesLivresPreferidas, };
