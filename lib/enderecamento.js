// ════════════════════════════════════════════════════════════════════
//  ENDEREÇAMENTO — layout do galpão e alocador de separação
// ════════════════════════════════════════════════════════════════════

const { logE, logI } = require('./log');
const { db, makeTransaction } = require('./db');

// ══════════════════════════════════════════════════════════════════
//  LAYOUT DO GALPÃO  (endereçamento — 04/09/2026)
// ------------------------------------------------------------------
//  Levantado do ENDEREÇAMENTO.xlsx em 27/08/2026. As duas ruas são
//  regulares: rua 01 tem 20 vãos, rua 02 tem 26, cada uma com 3
//  níveis de altura. 138 posições, 136 úteis.
//  10/11/2026 (Gustavo): "agora vai até a posição 38 dos dois lados" —
//  as duas ruas com 38 vãos: 228 posições, 226 úteis. Quem já tinha as
//  138 ganha as novas na subida seguinte (testes/galpao-38.js).
//
//  O nível 01 (chão) foi construído mais alto de propósito, para
//  receber as GAIOLAS GRANDES; os níveis 02 e 03 recebem as pequenas.
//  Isso é o que o sistema usa para AVISAR quando uma gaiola grande vai
//  para um nível de cima. Aviso, não bloqueio: uma gaiola pequena no
//  nível do chão é só desperdício de vão, não é erro; e uma grande em
//  cima o galpão já impede sozinho, porque não cabe.
// ══════════════════════════════════════════════════════════════════
const GALPAO_RUAS = { 1: 38, 2: 38 };
const GALPAO_NIVEIS = { 1: 'GRANDE', 2: 'PEQUENA', 3: 'PEQUENA' };
const GALPAO_BLOQUEADAS = {
  '01-01-005': 'HIDRANTE',
  '01-01-006': 'ESPACO DA INFORMACAO',
};
const codigoPosicao = (rua, nivel, pos) =>
  `${String(rua).padStart(2,'0')}-${String(nivel).padStart(2,'0')}-${String(pos).padStart(3,'0')}`;

// Semeia as posições do galpão (228 desde 10/11) a cada subida. Não sobrescreve nada: se a
// posição já existe (estação que já rodou), fica como está — inclusive
// um bloqueio que o usuário tenha criado depois.
function semearPosicoes() {
  try {
    const ins = db.prepare(`INSERT OR IGNORE INTO posicoes (codigo, rua, nivel, posicao, tipo_gaiola, bloqueada, motivo)
                            VALUES (?, ?, ?, ?, ?, ?, ?)`);
    let n = 0;
    const tr = makeTransaction(() => {
      for (const [ruaTxt, vaos] of Object.entries(GALPAO_RUAS)) {
        const rua = Number(ruaTxt);
        for (const [nivelTxt, tipo] of Object.entries(GALPAO_NIVEIS)) {
          const nivel = Number(nivelTxt);
          for (let p = 1; p <= vaos; p++) {
            const cod = codigoPosicao(rua, nivel, p);
            const motivo = GALPAO_BLOQUEADAS[cod] || null;
            const r = ins.run(cod, rua, nivel, p, tipo, motivo ? 1 : 0, motivo);
            if (r.changes) n++;
          }
        }
      }
    });
    tr();
    if (n) logI('db', `Endereçamento: ${n} posição(ões) do galpão cadastradas`);
  } catch (e) {
    logE('db', 'Falha ao semear as posições do galpão', { erro: e && e.message });
  }
}

// ══════════════════════════════════════════════════════════════════
//  ALOCADOR DE SEPARAÇÃO  (09/09/2026)
// ------------------------------------------------------------------
//  Dada a guia de separação conferida, com os pedidos na ORDEM DE
//  CARREGAMENTO, e as gaiolas endereçadas, decide de qual endereço
//  tirar cada fardo.
//
//  A IDEIA CENTRAL: a demanda é somada da CARGA INTEIRA antes de
//  alocar. É isso, e só isso, que faz uma mesma gaiola atender o
//  pedido de agora e o de depois. Se cada pedido for resolvido por
//  si, cada um abre gaiola nova e cada um deixa uma sobra — que é o
//  acúmulo de gaiolas com pouco produto que se quer eliminar.
//
//  PRIORIDADE
//    1. Sobra ZERO, se existir conjunto que some exatamente a demanda.
//    2. Senão, a MENOR sobra possível, concentrada em UMA gaiola só.
//    3. Menos gaiolas abertas.
//    4. FIFO: as mais antigas saem inteiras, a MAIS NOVA fica parcial.
// ══════════════════════════════════════════════════════════════════

// Escolhe o conjunto de gaiolas que cobre `demanda` fardos.
// Devolve { escolhidas, sobra, deficit } — escolhidas já na ordem de
// consumo, com a parcial (se houver) por último.
function escolherGaiolas(gaiolas, demanda) {
  if (demanda <= 0) return { escolhidas: [], sobra: 0, deficit: 0 };

  const chaveFifo = g => `${g.entrada || ''}|${g.posicao}`;
  const ordenadas = gaiolas.slice().sort((a, b) => chaveFifo(a) < chaveFifo(b) ? -1 : 1);
  const total = ordenadas.reduce((s, g) => s + g.fardos, 0);
  if (total < demanda) {
    // Não há produto endereçado suficiente. Leva o que há e reporta o
    // déficit — quem decide o que fazer é o gestor, não o sistema.
    return { escolhidas: ordenadas, sobra: 0, deficit: demanda - total };
  }

  // PROGRAMAÇÃO DINÂMICA EM CAMADAS — uma camada por gaiola.
  // A camada importa: montar a camada nova SEMPRE a partir da anterior
  // é o que garante que cada gaiola entre no máximo uma vez. Uma versão
  // com um único vetor de "pai" parece equivalente e NÃO é — ela pode
  // reconstruir um caminho que usa a mesma gaiola duas vezes, e aí o
  // sistema acha que tem mais fardos do que existe e manda separar
  // menos do que o pedido pede. Isso aconteceu no protótipo e só
  // apareceu em teste com centenas de cargas sorteadas.
  let melhor = new Map([[0, { cnt: 0, somaIdx: 0, idxs: [] }]]);
  for (let i = 0; i < ordenadas.length; i++) {
    const q = ordenadas[i].fardos;
    const nova = new Map(melhor);
    for (const [s, v] of melhor) {
      const ns = s + q;
      if (ns > total) continue;
      const atual = nova.get(ns);
      const cnt = v.cnt + 1, somaIdx = v.somaIdx + i;
      if (!atual || cnt < atual.cnt || (cnt === atual.cnt && somaIdx < atual.somaIdx)) {
        nova.set(ns, { cnt, somaIdx, idxs: v.idxs.concat(i) });
      }
    }
    melhor = nova;
  }

  let alvo = null;
  for (let s = demanda; s <= total; s++) { if (melhor.has(s)) { alvo = s; break; } }
  if (alvo === null) return { escolhidas: ordenadas, sobra: total - demanda, deficit: 0 };

  const idxs = melhor.get(alvo).idxs;
  let escolhidas = idxs.slice().sort((a, b) => a - b).map(i => ordenadas[i]);
  const sobra = alvo - demanda;

  if (sobra > 0) {
    // A parcial tem que ser a ÚLTIMA consumida, e é a MAIS NOVA do
    // conjunto: as antigas saem inteiras (FIFO) e a sobra é sempre a
    // mercadoria que entrou por último.
    const cabem = escolhidas.filter(g => g.fardos > sobra);
    const pool = cabem.length ? cabem : escolhidas;
    let parcial = pool[0];
    for (const g of pool) if (chaveFifo(g) > chaveFifo(parcial)) parcial = g;
    escolhidas = escolhidas.filter(g => g.id !== parcial.id).concat([parcial]);
  }
  return { escolhidas, sobra, deficit: 0 };
}

// Monta o plano de coleta da carga inteira.
//   pedidos: [{ ordem, itens: [{ cor_key, formato, fardos }] }]
//   gaiolas: [{ id, posicao, cor_key, formato, fardos, entrada, tipo_gaiola }]
function alocarSeparacao(pedidos, gaiolas) {
  const sku = x => `${x.cor_key}|${x.formato}`;

  const demanda = new Map();
  for (const p of pedidos)
    for (const it of (p.itens || []))
      demanda.set(sku(it), (demanda.get(sku(it)) || 0) + Number(it.fardos || 0));

  const estoque = new Map();
  for (const g of gaiolas) {
    if (!estoque.has(sku(g))) estoque.set(sku(g), []);
    estoque.get(sku(g)).push(g);
  }

  const coletas = [], faltas = [];
  const ordenados = pedidos.slice().sort((a, b) => a.ordem - b.ordem);

  for (const k of Array.from(demanda.keys()).sort()) {
    const d = demanda.get(k);
    const disponiveis = estoque.get(k) || [];
    const { escolhidas, deficit } = escolherGaiolas(disponiveis, d);
    const [corKey, formato] = k.split('|');
    if (deficit) faltas.push({ cor_key: corKey, formato, faltam: deficit });

    // Distribui as gaiolas escolhidas pelos pedidos NA ORDEM DE
    // CARREGAMENTO. Consumir em sequência é o que faz o corte cair
    // entre pedidos VIZINHOS — a gaiola compartilhada fica na doca de
    // um pedido para o seguinte, não para um lá do fim da fila.
    const restante = new Map(escolhidas.map(g => [g.id, g.fardos]));
    const reparticao = new Map();
    let i = 0;
    for (const p of ordenados) {
      let preciso = (p.itens || []).filter(it => sku(it) === k)
                                   .reduce((s, it) => s + Number(it.fardos || 0), 0);
      while (preciso > 0 && i < escolhidas.length) {
        const g = escolhidas[i];
        const pega = Math.min(preciso, restante.get(g.id));
        if (pega > 0) {
          if (!reparticao.has(g.id)) reparticao.set(g.id, {});
          reparticao.get(g.id)[p.ordem] = (reparticao.get(g.id)[p.ordem] || 0) + pega;
          restante.set(g.id, restante.get(g.id) - pega);
          preciso -= pega;
        }
        if (restante.get(g.id) === 0) i++;
      }
    }

    for (const g of escolhidas) {
      const rep = reparticao.get(g.id);
      if (!rep) continue;
      coletas.push({
        gaiola_id: g.id, posicao: g.posicao, cor_key: corKey, formato,
        tipo_gaiola: g.tipo_gaiola || null,
        fardos_na_gaiola: g.fardos, reparticao: rep, sobra: restante.get(g.id),
      });
    }
  }
  return { coletas, faltas };
}

// Ordem de visita: pedido a pedido (é como a separação é feita no chão),
// e dentro de cada pedido caminhando pelo galpão — rua, depois vão
// crescente, para não ir e voltar no corredor. Gaiola compartilhada é
// buscada UMA vez, no primeiro pedido que a usa.
function rotaDeColeta(coletas, pedidos) {
  const buscadas = new Set(), rota = [];
  for (const p of pedidos.slice().sort((a, b) => a.ordem - b.ordem)) {
    const doPedido = coletas.filter(c => c.reparticao[p.ordem] && !buscadas.has(c.gaiola_id));
    doPedido.sort((a, b) => {
      const A = a.posicao.split('-').map(Number), B = b.posicao.split('-').map(Number);
      return (A[0] - B[0]) || (A[2] - B[2]) || (A[1] - B[1]);
    });
    for (const c of doPedido) { buscadas.add(c.gaiola_id); rota.push({ ordem: p.ordem, coleta: c, buscar: true }); }
    for (const c of coletas)
      if (c.reparticao[p.ordem] && !doPedido.includes(c))
        rota.push({ ordem: p.ordem, coleta: c, buscar: false });   // já está na doca
  }
  return rota;
}
semearPosicoes();

// ══════════════════════════════════════════════════════════════════
//  MAPA DO GALPÃO  (retrato; 06/11/2026 ganhou o big bag de MP)
// ------------------------------------------------------------------
//  Uma função só para a tela do Mini PC (/enderecamento/mapa) e para o
//  retrato que vai ao painel da VPS (aba Mapa). Cada posição diz quem
//  mora lá: gaiola de PA (formato/cor/fardos/kg) ou bag de MP
//  (material/fornecedor/lote/kg). O campo `gaiola` continua com esse nome
//  para a tela antiga não quebrar; `item` diz o que é.
// ══════════════════════════════════════════════════════════════════
function mapaGalpao(agora = Date.now()) {
  const linhas = db.prepare(`
      SELECT p.codigo, p.rua, p.nivel, p.posicao, p.tipo_gaiola, p.bloqueada, p.motivo,
             o.gaiola_id, o.entrada, o.formato, o.cor, o.fardos, o.kg,
             o.tipo_gaiola AS gaiola_tipo, o.operador_e,
             o.tipo_item, o.material_key, o.material_nome, o.fornecedor, o.lote
        FROM posicoes p
        LEFT JOIN ocupacoes o ON o.posicao = p.codigo AND o.saida IS NULL
       ORDER BY p.rua, p.nivel, p.posicao`).all();
  const posicoes = linhas.map(l => {
    const item = l.gaiola_id ? (l.tipo_item || 'gaiola') : null;
    return {
      codigo: l.codigo, rua: l.rua, nivel: l.nivel, posicao: l.posicao,
      tipo_gaiola: l.tipo_gaiola, bloqueada: !!l.bloqueada, motivo: l.motivo,
      ocupada: !!l.gaiola_id,
      gaiola: l.gaiola_id ? {
        id: l.gaiola_id, item,
        formato: l.formato, cor: l.cor, fardos: l.fardos, kg: l.kg, tipo: l.gaiola_tipo,
        material_key: l.material_key || null, material_nome: l.material_nome || null,
        fornecedor: l.fornecedor || null, lote: l.lote || null,
        entrada: l.entrada, operador: l.operador_e,
        // Sem baixa automática, o mapa envelhece calado. O número de dias
        // é o que faz o esquecimento aparecer.
        dias: l.entrada ? Math.floor((agora - new Date(l.entrada).getTime()) / 86400000) : null,
      } : null,
    };
  });
  const ocupadas = posicoes.filter(p => p.ocupada);
  const bloqueadas = posicoes.filter(p => p.bloqueada).length;
  const gaiolas = ocupadas.filter(p => p.gaiola.item === 'gaiola');
  return {
    posicoes,
    resumo: {
      total: posicoes.length,
      uteis: posicoes.length - bloqueadas,
      ocupadas: ocupadas.length,
      livres: posicoes.length - bloqueadas - ocupadas.length,
      bloqueadas,
      gaiolas: gaiolas.length,
      bags: ocupadas.length - gaiolas.length,
      fardos: gaiolas.reduce((a, p) => a + (p.gaiola.fardos || 0), 0),
      kg: Number(ocupadas.reduce((a, p) => a + (p.gaiola.kg || 0), 0).toFixed(1)),
    },
    layout: { ruas: GALPAO_RUAS, niveis: GALPAO_NIVEIS },
  };
}

// O bag saiu numa retirada → a posição dele fica livre na hora (sem isso o
// mapa envelhece como envelheceu o das gaiolas). Devolve a ocupação fechada
// ou null se o bag não estava endereçado.
function liberarBagNaRetirada(rid, motivo, agoraISO = new Date().toISOString()) {
  const ocup = db.prepare('SELECT * FROM ocupacoes WHERE gaiola_id = ? AND saida IS NULL').get(rid);
  if (!ocup) return null;
  db.prepare('UPDATE ocupacoes SET saida = ?, motivo_saida = ? WHERE id = ?').run(agoraISO, motivo, ocup.id);
  return ocup;
}

module.exports = { alocarSeparacao, GALPAO_NIVEIS, GALPAO_RUAS, liberarBagNaRetirada, mapaGalpao, rotaDeColeta, };
