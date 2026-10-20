// ════════════════════════════════════════════════════════════════════
//  GUIA DE SEPARAÇÃO (PDF) — leitura e diagnóstico
// ════════════════════════════════════════════════════════════════════

const path   = require('path');

const { PA_CORES, PA_FORMATOS, PA_KG_FARDO, PUBLIC_DIR } = require('./config');

// ══════════════════════════════════════════════════════════════════
//  LEITURA DA GUIA DE SEPARAÇÃO (PDF)
// ------------------------------------------------------------------
//  O PDF da guia tem CAMADA DE TEXTO — não é imagem. Então não há OCR
//  aqui: a tela extrai o texto com o pdf.js (servido pela própria
//  estação, sem CDN) e manda as LINHAS para cá. Este código só
//  interpreta as linhas. A divisão é de propósito: extrair texto é
//  mecânico e cabe ao navegador; entender o documento é regra de
//  negócio e tem que ser testável.
//
//  O LAYOUT (um bloco por cliente):
//      NOME DO CLIENTE
//      Cidade - UF
//      FORMATO   PRODUTO   ORIGINAL   EDITADO      <- a âncora
//      COLORIDA                                    <- cor corrente
//      TAMANHO: 30x40 ......  800   750            <- item
//      ...
//
//  A quantidade que vale é a ÚLTIMA da linha: a coluna EDITADO. A
//  ORIGINAL é histórico e usar ela mandaria separar o que o cliente
//  não vai levar.
// ══════════════════════════════════════════════════════════════════
// Extrai as LINHAS de texto de um PDF, aqui no servidor.
//
// POR QUE NO SERVIDOR E NÃO NO NAVEGADOR
// A primeira versão fazia isso no celular, com `import()` de módulo ES.
// Funcionou no laboratório e falhou no galpão: depende do navegador
// suportar módulo ES, worker de módulo e do arquivo ser servido com o
// tipo certo — três coisas que variam entre o aparelho de cada um e o
// navegador da tela touch. Aqui é sempre o mesmo Node, sempre a mesma
// versão. O celular só manda o arquivo, que é o que ele já fazia com a
// foto e sempre funcionou.
let _pdfjs = null;
async function carregarPdfJs() {
  if (_pdfjs) return _pdfjs;
  const url = require('node:url');
  const base = path.join(PUBLIC_DIR, 'vendor');
  const lib = await import(url.pathToFileURL(path.join(base, 'pdf.min.mjs')).href);
  lib.GlobalWorkerOptions.workerSrc = url.pathToFileURL(path.join(base, 'pdf.worker.min.mjs')).href;
  _pdfjs = lib;
  return lib;
}

async function conteudoDoPdf(buffer) {
  const pdfjs = await carregarPdfJs();
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false, isEvalSupported: false, useSystemFonts: false,
    verbosity: 0,                       // sem ruído de fonte no log
  }).promise;

  const linhas = [], itens = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const pag = await doc.getPage(n);
    const cont = await pag.getTextContent();
    for (const it of cont.items) {
      if (!it.str || !it.str.trim()) continue;
      itens.push({ pagina: n, x: Math.round(it.transform[4]),
                   y: Math.round(it.transform[5]), t: it.str.trim() });
    }
    // O PDF não tem "linhas": tem pedaços de texto com coordenadas. O
    // que junta um pedaço ao outro é estarem na mesma ALTURA. Sem isso,
    // "TAMANHO: 30x40" e "750" viriam separados e a quantidade sumiria.
    const porAltura = new Map();
    for (const it of cont.items) {
      if (!it.str || !it.str.trim()) continue;
      const y = Math.round(it.transform[5]);
      let chave = y;
      for (const k of porAltura.keys()) if (Math.abs(k - y) <= 2) { chave = k; break; }
      if (!porAltura.has(chave)) porAltura.set(chave, []);
      porAltura.get(chave).push({ x: it.transform[4], txt: it.str });
    }
    for (const y of [...porAltura.keys()].sort((a, b) => b - a)) {
      linhas.push(porAltura.get(y).sort((a, b) => a.x - b.x)
                    .map(p => p.txt).join(' ').replace(/\s+/g, ' ').trim());
    }
  }
  try { await doc.destroy(); } catch (e) {}
  return { linhas, itens };
}

const GUIA_CORES = {
  COLORIDA: 'REC', COLORIDO: 'REC', RECICLADA: 'REC',
  BRANCA: 'BC', BRANCO: 'BC', LEITOSA: 'BC',
  PRETA: 'PT', PRETO: 'PT',
  AMARELA: 'AM', AMARELO: 'AM',
};
const semAcento = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
// As 27 UFs. Sem esta lista, "A C M DA SILVA COMERCIO - ME" vira cidade
// "A C M DA SILVA COMERCIO" no estado "ME" — e o cliente some da guia,
// porque a linha do nome dele foi consumida como se fosse a cidade.
// Nome de empresa terminando em - ME, - EPP, - LTDA é regra, não exceção.
const UFS = new Set(['AC','AL','AP','AM','BA','CE','DF','ES','GO','MA','MT','MS','MG',
                     'PA','PB','PR','PE','PI','RJ','RN','RS','RO','RR','SC','SP','SE','TO']);

// O cabeçalho de cada coluna da guia traz o número do pedido. É esse
// texto que faz a coluna existir — sem ele o leitor de matriz desiste e
// a tela cai no diagnóstico. Como o rótulo sai do painel de carteira e
// já foi visto como "Ped.1063", aceito também as grafias vizinhas, para
// que uma vírgula de diferença no dashboard não derrube a leitura.
const RE_PEDIDO_COL = /^(?:ped\.?|pedido)\s*\.?\s*n?º?\s*\d+/i;
const RE_QTD_FRD    = /^\d[\d.,]*\s*frd$/i;
const RE_TAMANHO    = /TAMANHO\s*:?\s*(\d{2,3})\s*[Xx×]\s*(\d{2,3})/;
const RE_PRODUTO    = /\(25\s*KG\)|^SACOLA\s/i;
// Só a unidade, sem nome de produto junto: "(25KG)", "25 kg", "(25 KG)".
// É o pedaço que sobra quando o rótulo quebra de linha.
const RE_SO_UNIDADE = /^[^A-Za-zÀ-ÿ]*\(?\s*25\s*KG\s*\)?[^A-Za-zÀ-ÿ]*$/i;

// A cor da sacola a partir do cabeçalho de produto da guia. Fica fora
// do leitor porque o diagnóstico precisa da mesma régua: só assim ele
// consegue dizer "a cor VERDE não é do galpão" em vez de um genérico
// "não entendi". Devolver null é resposta legítima — e é justamente o
// null que impede um fardo de cor desconhecida entrar como se fosse da
// cor da linha de cima.
function corDaGuia(txt) {
  const u = semAcento(txt);
  for (const [k, v] of Object.entries(PA_CORES))
    if (v.label && semAcento(v.label) === u) return k;           // casamento exato
  if (/AMAREL/.test(u)) return 'AM';
  if (/BRANC|LEITOS/.test(u)) return 'BC';
  if (/PRET/.test(u)) return 'PT';
  if (/COLORID/.test(u)) return 'REC';
  return null;
}

// Número no padrão brasileiro: 1.234,5 → 1234.5
function guiaNumero(txt) {
  const t = String(txt || '').replace(/\s/g, '');
  if (!/\d/.test(t)) return null;
  const limpo = t.replace(/\.(?=\d{3}\b)/g, '').replace(',', '.');
  const n = Number(limpo.replace(/[^0-9.]/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ══════════════════════════════════════════════════════════════════
//  A GUIA EM MATRIZ — o formato que a fábrica usa de verdade
// ------------------------------------------------------------------
//  A guia não é uma lista por cliente: é uma TABELA. Os produtos são as
//  linhas e as cargas são as COLUNAS:
//
//     PRODUTO / FAMÍLIA   TOTAL kg  CARGA 1   CARGA 2   CARGA 3
//                          fardos   Ped.1063  Ped.1113  Ped.1135
//                                   F E A LIMA  CASA DO...
//     ↳ SACOLA RECICLADA COLORIDA (25KG)
//       TAMANHO:40X50              80 frd     —         24 frd
//
//  Por isso a COLUNA de cada número é dada pela POSIÇÃO HORIZONTAL, não
//  pela ordem em que o texto aparece. Ler isso como linhas de texto
//  perde exatamente a informação que importa — de quem é cada
//  quantidade. Foi o erro da primeira versão.
//
//  A quantidade vem em FARDOS ("80 frd"), que é o que o galpão conta.
// ══════════════════════════════════════════════════════════════════
function interpretarGuiaMatriz(itens) {
  if (!Array.isArray(itens) || !itens.length) return null;

  // As colunas nascem dos "Ped.NNNN" do cabeçalho. Sem eles, não é
  // este formato — e o leitor de linhas assume.
  const peds = itens.filter(i => RE_PEDIDO_COL.test(i.t));
  if (peds.length < 1) return null;

  const colunas = peds
    .map(p => ({ x: p.x, y: p.y, pagina: p.pagina,
                 pedido: (p.t.match(/\d+/) || [''])[0],
                 cliente: null, cidade: null, uf: null, carga: null, itens: [] }))
    .sort((a, b) => a.x - b.x);
  // Distância típica entre colunas: serve de tolerância para dizer a
  // qual coluna um número pertence.
  const passo = colunas.length > 1
    ? Math.min(...colunas.slice(1).map((c, i) => c.x - colunas[i].x)) : 120;
  // TOLERÂNCIA — o teto de 45 pt não é enfeite.
  //   Medido na guia real: os "N frd" ficam a 5–8 pt do centro da sua
  //   coluna, e as colunas distam 111 pt entre si. Ou seja: 45 pt já é
  //   cinco vezes a folga necessária e ainda assim menos da metade do
  //   caminho até a coluna vizinha.
  //   Sem o teto, uma guia de UMA carga só cairia no passo padrão (120)
  //   e a tolerância viraria 90 pt — larga o bastante para a coluna
  //   "TOTAL kg / fardos", que fica à esquerda das cargas, ser lida como
  //   se fosse da carga. O caminhão sairia com o dobro do pedido.
  const tolerancia = Math.min(passo * 0.6, 45);
  const daColuna = (x, pagina) => {
    let melhor = null, dist = Infinity;
    for (const c of colunas) {
      if (pagina != null && c.pagina !== pagina) continue;
      const d = Math.abs(x - c.x);
      if (d < dist) { dist = d; melhor = c; }
    }
    return dist <= tolerancia ? melhor : null;
  };

  const yPed = peds[0].y;
  for (const it of itens) {
    // Cabeçalho da coluna: nome do cliente (termina em "|"), cidade/UF
    // e o rótulo "CARGA n · Entrega #m".
    if (Math.abs(it.y - yPed) > 30) continue;
    const c = daColuna(it.x, it.pagina);
    if (!c) continue;
    if (/\|\s*$/.test(it.t) && !c.cliente) {
      c.cliente = it.t.replace(/\s*\|\s*$/, '').trim();
    } else if (/^[A-Za-zÀ-ÿ .'-]+\/[A-Z]{2}$/.test(it.t) && !c.cidade) {
      const [cid, uf] = it.t.split('/');
      c.cidade = cid.trim(); c.uf = uf.trim().toUpperCase();
    } else if (/CARGA\s*\d+/i.test(it.t) && !c.carga) {
      c.carga = it.t.trim();
    }
  }

  const corDoTexto = corDaGuia;

  const avisos = [];
  const ordenados = itens.slice().sort((a, b) => (a.pagina - b.pagina) || (b.y - a.y) || (a.x - b.x));
  let corAtual = null, rotuloCor = null;

  for (const it of ordenados) {
    // QUEM MANDA É O TAMANHO, NÃO O "(25KG)".
    //   O rótulo do produto é uma célula de tabela e quebra onde couber.
    //   Numa folha larga sai "SACOLA RECICLADA COLORIDA (25KG)" numa
    //   altura e "TAMANHO:30X45" na seguinte; num PDF baixado pelo
    //   celular, a coluna é mais estreita e o mesmo rótulo vira
    //   "SACOLA RECICLADA COLORIDA" e "(25KG) TAMANHO:30X45".
    //   Perguntar primeiro "tem (25KG)?" fazia esse segundo pedaço ser
    //   lido como um produto novo, sem cor, que apagava a cor corrente —
    //   e a guia inteira caía fora com "isso não é do galpão". Perguntar
    //   primeiro "tem TAMANHO?" resolve as duas quebras com uma regra só.
    const mt = it.t.match(RE_TAMANHO);

    if (!mt && RE_PRODUTO.test(it.t)) {
      const c = corDoTexto(it.t);
      // "(25KG)" sozinho é o resto do nome que quebrou de linha, não um
      // produto novo: não diz cor nenhuma e não pode apagar a corrente.
      if (!c && RE_SO_UNIDADE.test(it.t)) continue;
      // Cor que o galpão não conhece NÃO pode herdar a anterior: os
      // fardos dela entrariam como se fossem da cor de cima.
      corAtual = c; rotuloCor = it.t.trim();
      if (!c) avisos.push({ linha: it.t.trim(), cliente: null,
                            motivo: `produto "${it.t.trim()}" não é de uma cor do galpão` });
      continue;
    }
    if (!mt) continue;

    const formato = PA_FORMATOS.find(f => f === `${Number(mt[1])}x${Number(mt[2])}`) || null;
    if (!formato) {
      avisos.push({ linha: it.t.trim(), cliente: null,
                    motivo: `formato ${mt[1]}x${mt[2]} não é do galpão` });
      continue;
    }
    if (!corAtual) {
      avisos.push({ linha: it.t.trim(), cliente: null,
                    motivo: `não sei a cor deste item${rotuloCor ? ` (veio depois de "${rotuloCor}")` : ''}` });
      continue;
    }

    // Os fardos desta linha, cada um na sua coluna.
    const naLinha = itens.filter(o => o.pagina === it.pagina && Math.abs(o.y - it.y) <= 3
                                   && RE_QTD_FRD.test(o.t));
    for (const q of naLinha) {
      const col = daColuna(q.x, q.pagina);
      if (!col) continue;
      const n = parseInt(String(q.t).replace(/[^\d]/g, ''), 10);
      if (!(n > 0)) continue;
      col.itens.push({ cor_key: corAtual, formato, fardos: n, kg: n * PA_KG_FARDO });
    }
  }

  const pedidos = colunas.filter(c => c.itens.length).map((c, i) => ({
    ordem: i + 1,
    cliente: c.cliente || (c.pedido ? `Pedido ${c.pedido}` : `Carga ${i + 1}`),
    cidade: c.cidade, uf: c.uf, carga: c.carga, pedido_numero: c.pedido || null,
    itens: c.itens,
  }));
  if (!pedidos.length) return null;

  const totalFardos = pedidos.reduce((a, p) => a + p.itens.reduce((x, i) => x + i.fardos, 0), 0);

  // ── CONFERÊNCIA CONTRA A PRÓPRIA GUIA ──────────────────────────
  // A guia imprime os totais dela: "TOTAL GERAL 11.700 468" e, no
  // rodapé, os fardos de cada carga. Comparar o que eu li com o que o
  // documento afirma é a única checagem que não depende de eu ter
  // entendido o layout — se um dia o formato mudar e minha leitura
  // ficar torta, isto acusa na hora, em vez de mandar separar errado.
  const conferencia = { ok: true, avisos: [] };
  const geral = itens.find(i => /^TOTAL\s+GERAL/i.test(i.t));
  if (geral) {
    const naLinha = itens
      .filter(o => o.pagina === geral.pagina && Math.abs(o.y - geral.y) <= 3 && o.x > geral.x)
      .sort((a, b) => a.x - b.x)
      .map(o => guiaNumero(o.t)).filter(n => n != null);
    if (naLinha.length >= 2) {
      conferencia.guia_kg = naLinha[0];
      conferencia.guia_fardos = naLinha[1];
      if (Math.round(conferencia.guia_kg) !== Math.round(totalFardos * PA_KG_FARDO)) {
        conferencia.ok = false;
        conferencia.avisos.push(`A guia diz ${conferencia.guia_kg} kg no total; eu li `
          + `${totalFardos * PA_KG_FARDO} kg.`);
      }
      if (conferencia.guia_fardos !== totalFardos) {
        conferencia.ok = false;
        conferencia.avisos.push(`A guia diz ${conferencia.guia_fardos} fardos no total; eu li ${totalFardos}.`);
      }
    }
  }
  // Rodapé por carga: linha só de "N frd", sem TAMANHO nenhum.
  const linhasFrd = new Map();
  for (const o of itens) {
    if (!RE_QTD_FRD.test(o.t)) continue;
    const chave = `${o.pagina}|${o.y}`;
    if (!linhasFrd.has(chave)) linhasFrd.set(chave, []);
    linhasFrd.get(chave).push(o);
  }
  for (const [chave, grupo] of linhasFrd) {
    const [pagina, y] = chave.split('|').map(Number);
    const temTamanho = itens.some(o => o.pagina === pagina && Math.abs(o.y - y) <= 3 && /TAMANHO/i.test(o.t));
    if (temTamanho || grupo.length < 2) continue;          // é linha de item, não rodapé
    for (const q of grupo) {
      const col = daColuna(q.x, pagina);
      if (!col) continue;
      const n = parseInt(String(q.t).replace(/[^\d]/g, ''), 10);
      const meu = col.itens.reduce((a, i) => a + i.fardos, 0);
      if (n !== meu) {
        conferencia.ok = false;
        conferencia.avisos.push(`${col.cliente || 'coluna ' + col.pedido}: a guia diz ${n} fardos, eu li ${meu}.`);
      }
    }
  }

  return { pedidos, avisos, formato_lido: 'matriz', conferencia,
           total_kg: totalFardos * PA_KG_FARDO, total_fardos: totalFardos,
           blocos: colunas.length };
}

// ══════════════════════════════════════════════════════════════════
//  POR QUE NÃO DEU — o diagnóstico da guia
// ------------------------------------------------------------------
//  Uma tela que só diz "não entendi o layout" transforma cada falha
//  numa viagem de ida e volta: o galpão manda um print, alguém olha o
//  PDF, adivinha. Este diagnóstico usa as MESMAS réguas do leitor
//  (RE_PEDIDO_COL, RE_QTD_FRD, RE_TAMANHO, RE_PRODUTO, corDaGuia) e diz
//  qual peça faltou — porque a peça que falta é sempre uma destas
//  quatro, e saber qual é já é metade do conserto.
// ══════════════════════════════════════════════════════════════════
function diagnosticoDaGuia(itens, linhas) {
  const its = Array.isArray(itens) ? itens : [];
  const lns = Array.isArray(linhas) ? linhas : [];
  const conta = re => its.filter(i => re.test(i.t)).length;
  const vazio = { pedacos: its.length, linhas: lns.length, paginas: 0, colunas_pedido: 0,
                  quantidades_frd: 0, linhas_tamanho: 0, cabecalhos_produto: 0,
                  tem_total_geral: false, formatos: [], formatos_fora: [], cores_fora: [],
                  amostra_colunas: [] };

  if (!its.length && !lns.length) {
    return { ...vazio, faltou: 'texto',
      motivo: 'O arquivo não trouxe texto nenhum — deve ser um PDF digitalizado '
            + '(uma foto da folha). Preciso do arquivo original do painel de carteira.' };
  }
  // Sem coordenadas não existe matriz: sobra o leitor de LINHAS, e a
  // única peça que ele procura é a âncora do cabeçalho. Diagnosticar
  // aqui pela régua da matriz apontaria a peça errada.
  if (!its.length) {
    const U = lns.map(semAcento);
    const ancora = U.some(l => l.includes('FORMATO') && l.includes('PRODUTO'));
    return { ...vazio, sem_coordenadas: true,
      linhas_tamanho: lns.filter(l => RE_TAMANHO.test(String(l))).length,
      faltou: ancora ? 'itens' : 'ancora',
      motivo: ancora
        ? 'Achei o cabeçalho FORMATO/PRODUTO, mas nenhuma linha de item embaixo dele.'
        : 'Não achei o cabeçalho FORMATO/PRODUTO, que é onde começa a lista de cada cliente.' };
  }

  const formatos = new Set(), formatosFora = new Set();
  for (const i of its) {
    const m = i.t.match(RE_TAMANHO);
    if (!m) continue;
    const f = `${Number(m[1])}x${Number(m[2])}`;
    formatos.add(f);
    if (!PA_FORMATOS.includes(f)) formatosFora.add(f);
  }
  // Mesma régua do leitor: quem traz TAMANHO é item, "(25KG)" sozinho é
  // continuação do nome. Sem isso o diagnóstico acusaria de "produto sem
  // cor" justamente os pedaços que o leitor aprendeu a ignorar.
  const ehCabecalho = t => !RE_TAMANHO.test(t) && RE_PRODUTO.test(t) && !RE_SO_UNIDADE.test(t);
  const coresFora = new Set();
  for (const i of its) if (ehCabecalho(i.t) && !corDaGuia(i.t)) coresFora.add(i.t.trim());

  const d = {
    pedacos: its.length,
    linhas: lns.length,
    paginas: its.length ? Math.max(...its.map(i => i.pagina)) : 0,
    colunas_pedido: conta(RE_PEDIDO_COL),
    quantidades_frd: conta(RE_QTD_FRD),
    linhas_tamanho: conta(RE_TAMANHO),
    cabecalhos_produto: its.filter(i => ehCabecalho(i.t)).length,
    tem_total_geral: conta(/^TOTAL\s+GERAL/i) > 0,
    formatos: [...formatos],
    formatos_fora: [...formatosFora],
    cores_fora: [...coresFora],
    amostra_colunas: its.filter(i => RE_PEDIDO_COL.test(i.t)).map(i => i.t.trim()).slice(0, 12),
  };

  // A ordem importa: cada pergunta só faz sentido se a anterior passou.
  if (!d.pedacos) {
    d.faltou = 'texto';
    d.motivo = 'O arquivo não trouxe texto nenhum — deve ser um PDF digitalizado '
             + '(uma foto da folha). Preciso do arquivo original do painel de carteira.';
  } else if (!d.colunas_pedido) {
    d.faltou = 'colunas';
    d.motivo = 'Não achei o número do pedido no alto de nenhuma coluna (algo como '
             + '"Ped.1063"). É esse texto que me diz onde começa cada carga.';
  } else if (!d.quantidades_frd) {
    d.faltou = 'quantidades';
    d.motivo = `Achei ${d.colunas_pedido} coluna(s) de pedido, mas nenhuma quantidade `
             + 'escrita em fardos (algo como "120 frd").';
  } else if (!d.cabecalhos_produto) {
    d.faltou = 'produto';
    d.motivo = `Achei ${d.colunas_pedido} coluna(s) e ${d.quantidades_frd} quantidade(s), mas `
             + 'nenhum cabeçalho de produto com "(25KG)" para eu saber a cor da sacola.';
  } else if (!d.linhas_tamanho) {
    d.faltou = 'tamanho';
    d.motivo = `Achei ${d.colunas_pedido} coluna(s) e ${d.cabecalhos_produto} produto(s), mas `
             + 'nenhuma linha de "TAMANHO: 40X50" para eu saber o formato.';
  } else if (d.formatos_fora.length || d.cores_fora.length) {
    d.faltou = 'catalogo';
    d.motivo = 'Li a guia inteira, mas o que está nela não é do galpão: '
             + [d.formatos_fora.length ? `formato(s) ${d.formatos_fora.join(', ')}` : null,
                d.cores_fora.length ? `produto(s) ${d.cores_fora.join(' / ')}` : null]
               .filter(Boolean).join(' e ') + '.';
  } else {
    d.faltou = 'montagem';
    d.motivo = 'Achei as colunas, os produtos, os tamanhos e as quantidades, mas não consegui '
             + 'ligar as quantidades às colunas — as colunas devem estar em posições '
             + 'diferentes das do cabeçalho.';
  }
  return d;
}

function interpretarGuia(linhasBrutas) {
  const linhas = (linhasBrutas || []).map(l => String(l == null ? '' : l).replace(/\s+/g, ' ').trim());
  const U = linhas.map(semAcento);

  const ehAncora = i => U[i].includes('FORMATO') && U[i].includes('PRODUTO');
  const ufDaLinha = i => {
    const m = U[i].match(/[\s-]([A-Z]{2})\s*$/);
    return m && UFS.has(m[1]) ? m[1] : null;
  };
  const ehCidade = i => {
    const s = linhas[i];
    if (!s || s.length > 55) return false;
    if (/TAMANHO/.test(U[i])) return false;
    return !!ufDaLinha(i);           // só é cidade se terminar numa UF de verdade
  };
  const ehLixoNome = i => {
    const u = U[i];
    if (!u) return true;
    if (GUIA_CORES[u.replace(/\s/g, '')]) return true;
    if (/TAMANHO|EDITADO|ORIGINAL|FORMATO|PRODUTO|SELE[CÇ]|TOTAL/.test(u)) return true;
    // 'CLIENTE' sozinho é cabeçalho de coluna; 'CLIENTE X LTDA' é nome.
    if (/^CLIENTES?\s*:?\s*$/.test(u)) return true;
    if ((u.match(/[A-Z]/g) || []).length < 4) return true;
    return false;
  };

  const ancoras = [];
  for (let i = 0; i < linhas.length; i++) if (ehAncora(i)) ancoras.push(i);

  const pedidos = [], avisos = [];
  for (let k = 0; k < ancoras.length; k++) {
    const a = ancoras[k];
    const limiteAcima = k > 0 ? ancoras[k - 1] : -1;

    // Cidade: até 6 linhas acima da âncora.
    let cidade = null, uf = null, iCidade = a;
    for (let j = a - 1; j > Math.max(limiteAcima, a - 7); j--) {
      if (linhas[j] && ehCidade(j)) {
        const s = linhas[j];
        const p = s.includes(' - ') ? [s.slice(0, s.lastIndexOf(' - ')), s.slice(s.lastIndexOf(' - ') + 3)]
                                    : (s.match(/^(.*?)\s+([A-Za-z]{2})\s*$/) || []).slice(1);
        if (p && p.length === 2) {
          cidade = p[0].replace(/^[^A-Za-zÀ-ÿ]+/, '').trim();
          uf = (p[1].replace(/[^A-Za-z]/g, '') || '').slice(0, 2).toUpperCase();
        }
        iCidade = j; break;
      }
    }

    // Nome: primeira linha "limpa" acima da cidade.
    let cliente = null;
    for (let j = (cidade ? iCidade : a) - 1; j > Math.max(limiteAcima, a - 10); j--) {
      if (linhas[j] && !ehLixoNome(j) && !ehCidade(j)) {
        cliente = linhas[j].replace(/^[\d.\s/-]+/, '').trim();
        if ((cliente.replace(/[^A-Za-z]/g, '') || '').length >= 4) break;
      }
    }

    // Itens: da âncora até a próxima.
    const fim = k + 1 < ancoras.length ? ancoras[k + 1] : linhas.length;
    const itens = [];
    let corAtual = null;
    for (let j = a + 1; j < fim; j++) {
      const u = U[j];
      if (!u) continue;
      const soCor = GUIA_CORES[u.replace(/[^A-Z]/g, '')];
      if (soCor) { corAtual = soCor; continue; }

      const mt = u.match(/TAMANHO[:\s]*(\d{2,3})\s*[X×]\s*(\d{2,3})/);
      if (!mt) {
        // Linha curta e só de letras, dentro do bloco de itens: é um
        // cabeçalho de cor que eu NÃO conheço (VERDE, AZUL...). Tem que
        // APAGAR a cor corrente. Se deixasse a anterior valendo, os
        // itens dessa cor entrariam como se fossem da cor de cima — o
        // caminhão sairia com o produto errado e ninguém veria.
        const palavras = u.trim().split(/\s+/).filter(Boolean);
        const soLetras = /^[A-Z\s]+$/.test(u.trim());
        if (soLetras && palavras.length <= 2 && u.trim().length >= 3
            && !/FORMATO|PRODUTO|EDITADO|ORIGINAL|TOTAL|CLIENTE/.test(u)) {
          corAtual = null;
          avisos.push({ linha: linhas[j], cliente: cliente || null,
                        motivo: `cor "${linhas[j].trim()}" não existe no galpão` });
        }
        continue;
      }
      const formato = PA_FORMATOS.find(f => f === `${Number(mt[1])}x${Number(mt[2])}`) || null;

      // Cor escrita na própria linha vence a cor do cabeçalho do bloco.
      let cor = corAtual;
      for (const [nome, key] of Object.entries(GUIA_CORES)) if (u.includes(nome)) { cor = key; break; }

      // A quantidade é a ÚLTIMA da linha — a coluna EDITADO.
      const resto = linhas[j].slice(mt.index + mt[0].length);
      const numeros = (resto.match(/[\d][\d.,]*/g) || []).map(guiaNumero).filter(n => n != null && n > 0);
      const kg = numeros.length ? numeros[numeros.length - 1] : null;

      if (!formato || !cor || !kg) {
        avisos.push({ linha: linhas[j], cliente: cliente || null,
          motivo: !formato ? `formato ${mt[1]}x${mt[2]} não é do galpão`
                 : !cor ? 'não identifiquei a cor desta linha' : 'não identifiquei a quantidade' });
        continue;
      }
      itens.push({ cor_key: cor, formato, kg, fardos: Math.ceil(kg / PA_KG_FARDO) });
    }

    if (itens.length) {
      pedidos.push({ ordem: pedidos.length + 1, cliente: cliente || `(cliente ${pedidos.length + 1})`,
                     cidade, uf, itens });
    } else if (cliente) {
      avisos.push({ linha: cliente, cliente, motivo: 'bloco sem nenhum item que eu tenha entendido' });
    }
  }

  const totalKg = pedidos.reduce((a, p) => a + p.itens.reduce((x, i) => x + i.kg, 0), 0);
  return { pedidos, avisos, linhas, total_kg: totalKg,
           total_fardos: pedidos.reduce((a, p) => a + p.itens.reduce((x, i) => x + i.fardos, 0), 0),
           blocos: ancoras.length };
}

module.exports = { conteudoDoPdf, diagnosticoDaGuia, interpretarGuia, interpretarGuiaMatriz, };
