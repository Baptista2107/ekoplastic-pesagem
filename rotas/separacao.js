// ════════════════════════════════════════════════════════════════════
//  ROTAS — separação de carga e sobras
// ════════════════════════════════════════════════════════════════════

const fs     = require('fs');
const path   = require('path');

const { GUIAS_DIR, PA_CORES, PA_FORMATOS, PA_KG_FARDO } = require('../lib/config');
const { logE, logI, logW } = require('../lib/log');
const { db, getProximoSeq, incrementaSeq, makeTransaction } = require('../lib/db');
const { alocarSeparacao, rotaDeColeta } = require('../lib/enderecamento');
const { conteudoDoPdf, diagnosticoDaGuia, interpretarGuia, interpretarGuiaMatriz } = require('../lib/guia');
const { gerarEPLGaiolaPA, imprimir } = require('../lib/impressao');
const {
  blingItensDoPedido, blingPedidosAbertos, estoqueEnderecado, faltasDaSeparacao,
  gaiolasRegistro, gaiolasSalvar, posicoesLivresPreferidas,
} = require('../lib/separacao');
const { jsonErr, jsonOk, lerBodyBinario, lerBodyJson, NAO_TRATADA } = require('../lib/http');

// ══════════════════════════════════════════════════════════════
//  SEPARAÇÃO E CARREGAMENTO
//  O ciclo: foto da guia → conferência → ordem de carregamento →
//  plano de coleta → bipe ao coletar (que é a BAIXA) → sobras.
// ══════════════════════════════════════════════════════════════

// Recebe a guia das duas formas: o PDF cru (o caminho real — a tela
// só envia o arquivo, como já fazia com a foto) ou as linhas em
// JSON, que é como os testes exercitam o interpretador.
// Devolve null quando já respondeu por erro.
async function receberGuia(reqG, resG) {
  const ct = String(reqG.headers['content-type'] || '').toLowerCase();
  if (ct.includes('json')) {
    let b; try { b = await lerBodyJson(reqG); } catch (e) { jsonErr(resG, 400, e.message); return null; }
    return { linhas: Array.isArray(b.linhas) ? b.linhas : [], pdf: null, body: b };
  }
  let pdf;
  try { pdf = await lerBodyBinario(reqG); } catch (e) { jsonErr(resG, 413, e.message); return null; }
  if (!pdf || pdf.length < 100) { jsonErr(resG, 400, 'Arquivo vazio'); return null; }
  if (pdf.slice(0, 5).toString('latin1') !== '%PDF-') {
    jsonErr(resG, 415, 'Isso não é um PDF. Envie o arquivo da guia, não uma foto.');
    return null;
  }
  let conteudo;
  try { conteudo = await conteudoDoPdf(pdf); }
  catch (e) {
    logE('separacao', 'Falha ao ler o PDF da guia', { erro: e.message });
    jsonErr(resG, 422, 'Não consegui abrir este PDF: ' + e.message);
    return null;
  }
  return { linhas: conteudo.linhas, itens: conteudo.itens, pdf, body: {} };
}

// Devolve NAO_TRATADA quando nenhuma rota daqui atende o pedido.
async function rotasSeparacao(req, res, parsed, pathname) {
  let m;

  // POST /separacao/de-guia — a carga sai do PDF da guia.
  // A tela extrai o texto do PDF (pdf.js, servido pela estação) e
  // manda as linhas; aqui elas viram pedidos. Sem OCR, sem digitação.
  // { linhas: [...], arquivo?: 'nome.pdf', operador? }
  if (pathname === '/separacao/de-guia' && req.method === 'POST') {
    // Aceita o PDF CRU (o caminho de verdade: o celular só manda o
    // arquivo) ou as linhas em JSON (usado pelos testes).
    const lido0 = await receberGuia(req, res);
    if (!lido0) return;                       // receberGuia já respondeu
    const { linhas, pdf } = lido0;
    let body = lido0.body || {};
    if (!linhas.length) return jsonErr(res, 400,
      'Não achei texto nenhum no PDF. Se ele foi digitalizado (é uma imagem), '
      + 'não dá para ler — peça o arquivo original do painel de carteira.');

    // Tenta primeiro a MATRIZ (o formato real da fábrica, que depende
    // das coordenadas). Só cai no leitor de linhas se não for esse.
    const lido = (lido0.itens && interpretarGuiaMatriz(lido0.itens)) || interpretarGuia(linhas);
    if (!lido.pedidos.length) {
      const diag = diagnosticoDaGuia(lido0.itens, linhas);
      logW('separacao', 'Guia não reconhecida: ' + diag.motivo, diag);
      return jsonErr(res, 422, 'Li o PDF mas não reconheci nenhum cliente com itens. ' + diag.motivo,
        { avisos: lido.avisos, blocos: lido.blocos, linhas_lidas: linhas.length,
          diag, linhas: linhas.slice(0, 200) });
    }

    const agora = new Date().toISOString();
    let sepId;
    const tr = makeTransaction(() => {
      const info = db.prepare(`INSERT INTO separacoes (criada_em, arquivo, status, operador, obs)
                                 VALUES (?, NULL, 'conferida', ?, ?)`)
        .run(agora, body.operador || null,
             `Guia lida do PDF (${lido.formato_lido || 'lista'}): `
             + `${lido.pedidos.length} carga(s), ${Math.round(lido.total_kg)} kg`);
      sepId = Number(info.lastInsertRowid);
      for (const p of lido.pedidos) {
        const r = db.prepare(`INSERT INTO separacao_pedidos
                                  (separacao_id, ordem, cliente, cidade, uf, carga, pedido_numero)
                                VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(sepId, p.ordem, p.cliente, p.cidade, p.uf, p.carga || null, p.pedido_numero || null);
        for (const it of p.itens)
          db.prepare(`INSERT INTO separacao_itens (pedido_id, cor_key, formato, fardos)
                        VALUES (?, ?, ?, ?)`).run(Number(r.lastInsertRowid), it.cor_key, it.formato, it.fardos);
      }
    });
    tr();
    // Guarda o PDF junto da carga, como comprovante do que foi lido.
    if (pdf && pdf.length) {
      try {
        fs.mkdirSync(GUIAS_DIR, { recursive: true });
        const nome = `guia-${String(sepId).padStart(5, '0')}.pdf`;
        fs.writeFileSync(path.join(GUIAS_DIR, nome), pdf);
        db.prepare('UPDATE separacoes SET arquivo = ? WHERE id = ?').run(nome, sepId);
      } catch (e) { logW('separacao', 'Não consegui guardar o PDF: ' + e.message); }
    }
    logI('separacao', `Separação ${sepId} lida do PDF da guia: ${lido.pedidos.length} cliente(s), `
      + `${lido.total_fardos} fardo(s), ${Math.round(lido.total_kg)} kg`
      + (lido.avisos.length ? `, ${lido.avisos.length} linha(s) não entendida(s)` : ''));
    return jsonOk(res, { id: sepId, status: 'conferida', ...lido });
  }

  // POST /separacao/guia/previa — mesma leitura, sem gravar nada.
  // Serve para a tela mostrar o que entendeu ANTES de criar a carga.
  if (pathname === '/separacao/guia/previa' && req.method === 'POST') {
    const lido0 = await receberGuia(req, res);
    if (!lido0) return;
    if (!lido0.linhas.length) return jsonErr(res, 400,
      'Não achei texto nenhum no PDF. Se ele foi digitalizado (é uma imagem), '
      + 'não dá para ler — peça o arquivo original do painel de carteira.',
      { sem_texto: true });
    // `linhas` volta junto para o diagnóstico: quando o layout não for
    // o esperado, é olhando as linhas cruas que se descobre por quê.
    const previa = (lido0.itens && interpretarGuiaMatriz(lido0.itens))
                || interpretarGuia(lido0.linhas);
    // Quando não sobrou nenhum cliente, o diagnóstico vai junto: a tela
    // não deve mostrar só as linhas cruas e deixar o galpão adivinhando.
    const diag = previa.pedidos.length ? null : diagnosticoDaGuia(lido0.itens, lido0.linhas);
    if (diag) logW('separacao', 'Prévia da guia não reconhecida: ' + diag.motivo, diag);
    return jsonOk(res, { ...previa, diag, linhas: lido0.linhas.slice(0, 400) });
  }

  // GET /separacao/bling/pedidos?dias=45 — os pedidos em aberto,
  // direto da fonte. É isto que dispensa fotografar a guia.
  if (pathname === '/separacao/bling/pedidos' && req.method === 'GET') {
    const dias = Math.min(180, Math.max(1, parseInt(parsed.query.dias) || 45));
    try {
      const pedidos = await blingPedidosAbertos(dias);
      return jsonOk(res, { pedidos, dias });
    } catch (e) {
      return jsonErr(res, 502, 'Não consegui ler os pedidos no Bling: ' + e.message);
    }
  }

  // GET /separacao/bling/pedido/:id — os itens de um pedido, já
  // traduzidos para cor/formato/fardos do galpão.
  if ((m = pathname.match(/^\/separacao\/bling\/pedido\/(\d+)$/)) && req.method === 'GET') {
    try { return jsonOk(res, { pedido: await blingItensDoPedido(m[1]) }); }
    catch (e) { return jsonErr(res, 502, 'Não consegui ler o pedido no Bling: ' + e.message); }
  }

  // POST /separacao/de-bling — cria a carga a partir dos pedidos
  // escolhidos. Zero digitação: as quantidades vêm do Bling.
  // { pedidos: [{ bling_id, ordem? }], operador? }
  if (pathname === '/separacao/de-bling' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch (e) { return jsonErr(res, 400, e.message); }
    const escolhidos = Array.isArray(body.pedidos) ? body.pedidos : [];
    if (!escolhidos.length) return jsonErr(res, 400, 'Escolha ao menos um pedido');
    if (escolhidos.length > 40) return jsonErr(res, 400, 'Muitos pedidos de uma vez (máximo 40)');

    const buscados = [], naoReconhecidos = [];
    for (const e of escolhidos) {
      let p;
      try { p = await blingItensDoPedido(e.bling_id); }
      catch (err) { return jsonErr(res, 502, `Falha ao ler o pedido ${e.bling_id} no Bling: ${err.message}`); }
      for (const it of p.itens) if (!it.reconhecido)
        naoReconhecidos.push({ bling_id: p.bling_id, cliente: p.cliente,
                               codigo: it.codigo, descricao: it.descricao, motivo: it.motivo });
      buscados.push({ ...p, ordem: parseInt(e.ordem, 10) || null });
    }
    // Ordem de carregamento: a informada; sem ela, a ordem da escolha.
    buscados.forEach((p, i) => { if (!p.ordem) p.ordem = i + 1; });

    const agora = new Date().toISOString();
    let sepId;
    const tr = makeTransaction(() => {
      const info = db.prepare(`INSERT INTO separacoes (criada_em, arquivo, status, operador, obs)
                                 VALUES (?, NULL, 'conferida', ?, ?)`)
        .run(agora, body.operador || null,
             'Pedidos lidos direto do Bling: ' + buscados.map(p => p.numero || p.bling_id).join(', '));
      sepId = Number(info.lastInsertRowid);
      for (const p of buscados) {
        const r = db.prepare(`INSERT INTO separacao_pedidos
                                  (separacao_id, ordem, cliente, cidade, uf, carga, pedido_numero)
                                VALUES (?, ?, ?, ?, ?, ?, ?)`)
          .run(sepId, p.ordem, p.cliente || null, p.cidade || null, p.uf || null,
               p.carga || null, p.pedido_numero || p.bling_numero || null);
        for (const it of p.itens) {
          if (!it.reconhecido || it.fardos <= 0) continue;
          db.prepare(`INSERT INTO separacao_itens (pedido_id, cor_key, formato, fardos)
                        VALUES (?, ?, ?, ?)`).run(Number(r.lastInsertRowid), it.cor_key, it.formato, it.fardos);
        }
      }
    });
    tr();
    logI('separacao', `Separação ${sepId} criada do Bling: ${buscados.length} pedido(s)`
      + (naoReconhecidos.length ? `, ${naoReconhecidos.length} item(ns) não reconhecido(s)` : ''));
    return jsonOk(res, {
      id: sepId, status: 'conferida', pedidos: buscados.length,
      // Item que a estação não soube traduzir NÃO some calado: volta
      // aqui para a tela mostrar e alguém decidir.
      nao_reconhecidos: naoReconhecidos,
    });
  }

  // POST /separacao/:id/guia — anexa (ou troca) a foto da guia numa
  // separação que já existe. Opcional: serve de comprovante quando a
  // carga nasceu do Bling.
  if ((m = pathname.match(/^\/separacao\/(\d+)\/guia$/)) && req.method === 'POST') {
    const sepId = Number(m[1]);
    const s = db.prepare('SELECT * FROM separacoes WHERE id = ?').get(sepId);
    if (!s) return jsonErr(res, 404, `Separação ${sepId} não existe`);
    let img;
    try { img = await lerBodyBinario(req); } catch (e) { return jsonErr(res, 413, e.message); }
    if (!img || img.length < 100) return jsonErr(res, 400, 'Arquivo vazio');
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    const ext = ct.includes('png') ? 'png' : ct.includes('pdf') ? 'pdf' : 'jpg';
    const nome = `guia-${String(sepId).padStart(5, '0')}.${ext}`;
    try {
      fs.mkdirSync(GUIAS_DIR, { recursive: true });
      fs.writeFileSync(path.join(GUIAS_DIR, nome), img);
      db.prepare('UPDATE separacoes SET arquivo = ? WHERE id = ?').run(nome, sepId);
    } catch (e) { return jsonErr(res, 500, 'Não consegui gravar: ' + e.message); }
    return jsonOk(res, { id: sepId, arquivo: nome, bytes: img.length });
  }

  // POST /separacao/nova — abre a carga. A FOTO DA GUIA é o gatilho:
  // o corpo é a imagem crua (image/jpeg ou image/png). Sem foto o
  // processo não começa — é ela que prova de onde vieram os números.
  if (pathname === '/separacao/nova' && req.method === 'POST') {
    let img;
    try { img = await lerBodyBinario(req); } catch (e) { return jsonErr(res, 413, e.message); }
    if (!img || img.length < 100) {
      return jsonErr(res, 400, 'Envie a foto da guia de separação para iniciar o processo.');
    }
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    const ext = ct.includes('png') ? 'png' : ct.includes('pdf') ? 'pdf' : 'jpg';
    const agora = new Date().toISOString();
    const info = db.prepare(`INSERT INTO separacoes (criada_em, arquivo, status, operador)
                               VALUES (?, NULL, 'rascunho', ?)`)
                   .run(agora, parsed.query.operador || null);
    const id = Number(info.lastInsertRowid);
    const nome = `guia-${String(id).padStart(5, '0')}.${ext}`;
    try {
      fs.mkdirSync(GUIAS_DIR, { recursive: true });
      fs.writeFileSync(path.join(GUIAS_DIR, nome), img);
      db.prepare('UPDATE separacoes SET arquivo = ? WHERE id = ?').run(nome, id);
    } catch (e) {
      logE('separacao', 'Não consegui gravar a foto da guia', { erro: e.message });
      return jsonErr(res, 500, 'Não consegui gravar a foto da guia: ' + e.message);
    }
    logI('separacao', `Separação ${id} aberta com a guia ${nome} (${Math.round(img.length/1024)} KB)`);
    return jsonOk(res, { id, arquivo: nome, bytes: img.length, status: 'rascunho' });
  }

  // GET /separacao/:id/guia — devolve a foto, para ficar na tela
  // durante toda a conferência.
  if ((m = pathname.match(/^\/separacao\/(\d+)\/guia$/)) && req.method === 'GET') {
    const s = db.prepare('SELECT * FROM separacoes WHERE id = ?').get(Number(m[1]));
    if (!s || !s.arquivo) return jsonErr(res, 404, 'Guia não encontrada');
    const arq = path.join(GUIAS_DIR, path.basename(s.arquivo));
    if (!fs.existsSync(arq)) return jsonErr(res, 404, 'Arquivo da guia não está mais no disco');
    const ext = path.extname(arq).toLowerCase();
    const tipo = ext === '.png' ? 'image/png' : ext === '.pdf' ? 'application/pdf' : 'image/jpeg';
    res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'no-store' });
    return res.end(fs.readFileSync(arq));
  }

  // POST /separacao/:id/conferir — grava os pedidos conferidos, na
  // ordem de carregamento. Substitui o que houver: conferir de novo é
  // corrigir, não duplicar.
  // { pedidos: [{ ordem, cliente, cidade, uf, itens:[{cor_key, formato, fardos|kg}] }] }
  if ((m = pathname.match(/^\/separacao\/(\d+)\/conferir$/)) && req.method === 'POST') {
    const sepId = Number(m[1]);
    let body; try { body = await lerBodyJson(req); } catch (e) { return jsonErr(res, 400, e.message); }
    const s = db.prepare('SELECT * FROM separacoes WHERE id = ?').get(sepId);
    if (!s) return jsonErr(res, 404, `Separação ${sepId} não existe`);
    // Corrigir a guia é livre ENQUANTO NINGUÉM COLETOU. Depois que a
    // primeira gaiola saiu do endereço, não é mais: mexer nos números
    // aí faria o plano brigar com o que já está na doca.
    const jaSaiu = db.prepare(
      `SELECT COUNT(*) AS n FROM separacao_coletas WHERE separacao_id = ? AND status = 'coletada'`).get(sepId);
    if (jaSaiu && jaSaiu.n > 0) {
      return jsonErr(res, 409,
        `Esta separação já tem ${jaSaiu.n} gaiola(s) coletada(s); não dá mais para reconferir a guia.`,
        { coletadas: jaSaiu.n });
    }
    if (s.status === 'concluida' || s.status === 'cancelada') {
      return jsonErr(res, 409, `Separação ${s.status}.`);
    }
    const pedidos = Array.isArray(body.pedidos) ? body.pedidos : [];
    if (!pedidos.length) return jsonErr(res, 400, 'Nenhum pedido informado');

    const avisos = [];
    const ordens = new Set();
    for (const p of pedidos) {
      const o = parseInt(p.ordem, 10);
      if (!Number.isFinite(o) || o < 1) return jsonErr(res, 400, 'Ordem de carregamento inválida');
      if (ordens.has(o)) return jsonErr(res, 400, `Ordem de carregamento ${o} repetida`);
      ordens.add(o);
      for (const it of (p.itens || [])) {
        if (!PA_CORES[it.cor_key]) return jsonErr(res, 400, `Cor desconhecida: ${it.cor_key}`);
        if (!PA_FORMATOS.includes(it.formato)) return jsonErr(res, 400, `Formato desconhecido: ${it.formato}`);
        // A guia vem em kg; o galpão trabalha em fardos de 25 kg. Se o
        // kg não for múltiplo, o sistema NÃO arredonda calado: arredonda
        // para cima e avisa, porque faltar produto no caminhão é pior
        // que sobrar um fardo.
        if (it.fardos == null && it.kg != null) {
          const f = Number(it.kg) / PA_KG_FARDO;
          it.fardos = Math.ceil(f);
          if (Math.abs(f - Math.round(f)) > 1e-9) {
            avisos.push(`${p.cliente || 'pedido ' + o}: ${it.kg} kg de ${it.cor_key} ${it.formato} `
                      + `não fecha em fardos de ${PA_KG_FARDO} kg — arredondei para ${it.fardos}.`);
          }
        }
        if (!(Number(it.fardos) > 0)) return jsonErr(res, 400, 'Quantidade inválida em um dos itens');
      }
    }

    const tr = makeTransaction(() => {
      const antigos = db.prepare('SELECT id FROM separacao_pedidos WHERE separacao_id = ?').all(sepId);
      for (const a of antigos) db.prepare('DELETE FROM separacao_itens WHERE pedido_id = ?').run(a.id);
      db.prepare('DELETE FROM separacao_pedidos WHERE separacao_id = ?').run(sepId);
      for (const p of pedidos) {
        const r = db.prepare(`INSERT INTO separacao_pedidos
                                  (separacao_id, ordem, cliente, cidade, uf, carga, pedido_numero)
                                VALUES (?, ?, ?, ?, ?, ?, ?)`)
                    .run(sepId, parseInt(p.ordem, 10), p.cliente || null, p.cidade || null,
                         p.uf || null, p.carga || null, p.pedido_numero || null);
        for (const it of (p.itens || []))
          db.prepare(`INSERT INTO separacao_itens (pedido_id, cor_key, formato, fardos)
                        VALUES (?, ?, ?, ?)`)
            .run(Number(r.lastInsertRowid), it.cor_key, it.formato, parseInt(it.fardos, 10));
      }
      db.prepare(`UPDATE separacoes SET status = 'conferida' WHERE id = ?`).run(sepId);
    });
    tr();
    logI('separacao', `Separação ${sepId} conferida: ${pedidos.length} pedido(s)`);
    return jsonOk(res, { id: sepId, status: 'conferida', pedidos: pedidos.length, avisos });
  }

  // ══════════════════════════════════════════════════════════════
  //  POST /separacao/:id/ordem — muda SÓ a ordem de carregamento.
  //  { ordens: [id_do_pedido, ...] }  — do primeiro a carregar ao último
  // --------------------------------------------------------------
  //  A ordem de carregamento é a única coisa nesta tela que o gestor
  //  decide de verdade: o resto veio do documento. Ela merece rota
  //  própria — mandá-la junto da conferência obrigaria a reenviar
  //  todos os itens só para trocar duas cargas de lugar, e um erro de
  //  digitação no caminho apagaria a guia inteira.
  // ══════════════════════════════════════════════════════════════
  if ((m = pathname.match(/^\/separacao\/(\d+)\/ordem$/)) && req.method === 'POST') {
    const sepId = Number(m[1]);
    const s = db.prepare('SELECT * FROM separacoes WHERE id = ?').get(sepId);
    if (!s) return jsonErr(res, 404, `Separação ${sepId} não existe`);
    if (s.status === 'cancelada' || s.status === 'concluida')
      return jsonErr(res, 409, `Separação ${s.status}.`);
    // Depois que uma gaiola já saiu do endereço, mudar a ordem
    // embaralharia as pilhas que já estão montadas na doca.
    const jaColetou = db.prepare(`SELECT COUNT(*) AS n FROM separacao_coletas
                                    WHERE separacao_id = ? AND status = 'coletada'`).get(sepId).n;
    if (jaColetou) return jsonErr(res, 409,
      'A separação já começou — a ordem de carregamento não muda mais.');

    let body; try { body = await lerBodyJson(req); } catch (e) { return jsonErr(res, 400, e.message); }
    const querida = (Array.isArray(body.ordens) ? body.ordens : []).map(Number);
    const atuais = db.prepare('SELECT id FROM separacao_pedidos WHERE separacao_id = ? ORDER BY ordem')
                     .all(sepId).map(r => r.id);
    if (querida.length !== atuais.length || new Set(querida).size !== querida.length
        || querida.some(id => !atuais.includes(id)))
      return jsonErr(res, 400,
        'A nova ordem precisa trazer cada pedido da carga exatamente uma vez.');

    const tr = makeTransaction(() => {
      // Duas passadas. O índice único (separacao_id, ordem) impede
      // numerar por cima: trocar o 1º com o 2º esbarraria no 2º que
      // ainda existe. Os negativos são o estacionamento temporário.
      for (let i = 0; i < querida.length; i++)
        db.prepare('UPDATE separacao_pedidos SET ordem = ? WHERE id = ?').run(-(i + 1), querida[i]);
      for (let i = 0; i < querida.length; i++)
        db.prepare('UPDATE separacao_pedidos SET ordem = ? WHERE id = ?').run(i + 1, querida[i]);
    });
    tr();
    const pedidos = db.prepare(`SELECT id, ordem, cliente, cidade, uf, carga, pedido_numero
                                  FROM separacao_pedidos WHERE separacao_id = ? ORDER BY ordem`).all(sepId);
    logI('separacao', `Separação ${sepId}: ordem de carregamento definida — `
      + pedidos.map(p => `${p.ordem}º ${p.cliente || p.id}`).join(', '));
    return jsonOk(res, { id: sepId, pedidos });
  }

  // POST /separacao/:id/planejar — roda o alocador e grava o plano.
  // Pode ser chamado de novo: replaneja o que ainda não foi coletado,
  // descontando o que já saiu. É o que permite seguir em frente quando
  // uma gaiola não está onde o mapa diz.
  if ((m = pathname.match(/^\/separacao\/(\d+)\/planejar$/)) && req.method === 'POST') {
    const sepId = Number(m[1]);
    const s = db.prepare('SELECT * FROM separacoes WHERE id = ?').get(sepId);
    if (!s) return jsonErr(res, 404, `Separação ${sepId} não existe`);
    if (s.status === 'rascunho') return jsonErr(res, 409, 'Confira a guia antes de planejar.');
    if (s.status === 'cancelada' || s.status === 'concluida')
      return jsonErr(res, 409, `Separação ${s.status}.`);

    const pedidos = db.prepare('SELECT * FROM separacao_pedidos WHERE separacao_id = ? ORDER BY ordem').all(sepId);
    for (const p of pedidos)
      p.itens = db.prepare('SELECT cor_key, formato, fardos FROM separacao_itens WHERE pedido_id = ?').all(p.id);

    // Desconta o que JÁ foi coletado — replanejar não pode mandar
    // separar de novo o que já está na doca.
    const jaColetadas = db.prepare(
      `SELECT * FROM separacao_coletas WHERE separacao_id = ? AND status = 'coletada'`).all(sepId);
    const jaPorPedidoSku = new Map();
    const fora = new Set();
    for (const c of jaColetadas) {
      fora.add(c.gaiola_id);
      let rep = {}; try { rep = JSON.parse(c.reparticao); } catch (e) {}
      for (const [ordem, q] of Object.entries(rep)) {
        const k = `${ordem}|${c.cor_key}|${c.formato}`;
        jaPorPedidoSku.set(k, (jaPorPedidoSku.get(k) || 0) + Number(q));
      }
    }
    for (const c of db.prepare(
      `SELECT gaiola_id FROM separacao_coletas WHERE separacao_id = ? AND status = 'nao_encontrada'`).all(sepId))
      fora.add(c.gaiola_id);

    const pedidosRestantes = pedidos.map(p => ({
      ordem: p.ordem,
      itens: p.itens.map(it => ({
        cor_key: it.cor_key, formato: it.formato,
        fardos: Math.max(0, it.fardos - (jaPorPedidoSku.get(`${p.ordem}|${it.cor_key}|${it.formato}`) || 0)),
      })).filter(it => it.fardos > 0),
    }));

    const estoque = estoqueEnderecado().filter(g => !fora.has(g.id));
    const plano = alocarSeparacao(pedidosRestantes, estoque);

    const tr = makeTransaction(() => {
      db.prepare(`DELETE FROM separacao_coletas WHERE separacao_id = ? AND status = 'planejada'`).run(sepId);
      for (const c of plano.coletas)
        db.prepare(`INSERT INTO separacao_coletas
              (separacao_id, gaiola_id, posicao, cor_key, formato, tipo_gaiola,
               fardos_na_gaiola, reparticao, sobra, status)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planejada')`)
          .run(sepId, c.gaiola_id, c.posicao, c.cor_key, c.formato, c.tipo_gaiola,
               c.fardos_na_gaiola, JSON.stringify(c.reparticao), c.sobra);
      if (s.status === 'conferida')
        db.prepare(`UPDATE separacoes SET status = 'em_separacao' WHERE id = ?`).run(sepId);
    });
    tr();

    // Devolve as coletas COMO ESTÃO NO BANCO, com o id de cada uma —
    // é esse id que a tela usa para confirmar o bipe. Devolver o
    // objeto do alocador (sem id) deixaria a tela sem como confirmar.
    const gravadas = db.prepare(
      `SELECT * FROM separacao_coletas WHERE separacao_id = ? AND status = 'planejada' ORDER BY id`)
      .all(sepId)
      .map(c => ({ ...c, reparticao: (() => { try { return JSON.parse(c.reparticao); } catch (e) { return {}; } })() }));

    // A falta é recalculada do banco, não vem do alocador: assim ela
    // sai por PEDIDO (quem vai ficar faltando), e não só por produto.
    // Precisa vir ANTES do log, que já a menciona.
    const falta = faltasDaSeparacao(sepId);

    const rota = rotaDeColeta(gravadas, pedidosRestantes);
    logI('separacao', `Separação ${sepId} planejada: ${gravadas.length} coleta(s), `
                    + `${gravadas.filter(c => c.sobra > 0).length} com sobra`
                    + (falta.fardos ? `, faltam ${falta.fardos} fardo(s) (produção)` : ''));
    return jsonOk(res, {
      id: sepId, coletas: gravadas, faltas: falta.por_produto, falta,
      rota: rota.map(r => ({ pedido: r.ordem, coleta_id: r.coleta.id, gaiola: r.coleta.gaiola_id,
                             posicao: r.coleta.posicao, buscar: r.buscar })),
      resumo: {
        gaiolas: gravadas.length,
        com_sobra: gravadas.filter(c => c.sobra > 0).length,
        compartilhadas: gravadas.filter(c => Object.keys(c.reparticao).length > 1).length,
        fardos: gravadas.reduce((a, c) => a + Object.values(c.reparticao).reduce((x, y) => x + y, 0), 0),
        faltando: falta.fardos,
      },
    });
  }

  // GET /separacao/:id — estado completo.
  if ((m = pathname.match(/^\/separacao\/(\d+)$/)) && req.method === 'GET') {
    const sepId = Number(m[1]);
    const s = db.prepare('SELECT * FROM separacoes WHERE id = ?').get(sepId);
    if (!s) return jsonErr(res, 404, `Separação ${sepId} não existe`);
    const pedidos = db.prepare('SELECT * FROM separacao_pedidos WHERE separacao_id = ? ORDER BY ordem').all(sepId);
    for (const p of pedidos)
      p.itens = db.prepare('SELECT cor_key, formato, fardos FROM separacao_itens WHERE pedido_id = ?').all(p.id);
    const coletas = db.prepare('SELECT * FROM separacao_coletas WHERE separacao_id = ? ORDER BY id').all(sepId)
      .map(c => ({ ...c, reparticao: (() => { try { return JSON.parse(c.reparticao); } catch (e) { return {}; } })() }));
    const sobras = db.prepare('SELECT * FROM sobras WHERE separacao_id = ? ORDER BY id').all(sepId);
    return jsonOk(res, { separacao: s, pedidos, coletas, sobras, falta: faltasDaSeparacao(sepId) });
  }

  // GET /separacao — as cargas, mais recentes primeiro.
  if (pathname === '/separacao' && req.method === 'GET') {
    const limite = Math.min(200, Math.max(1, parseInt(parsed.query.limit) || 30));
    const linhas = db.prepare(`SELECT s.*,
          (SELECT COUNT(*) FROM separacao_pedidos p WHERE p.separacao_id = s.id) AS pedidos,
          (SELECT COUNT(*) FROM separacao_coletas c WHERE c.separacao_id = s.id AND c.status = 'planejada') AS pendentes
          FROM separacoes s ORDER BY s.id DESC LIMIT ?`).all(limite);
    for (const l of linhas) {
      try { l.faltando = (l.pedidos ? faltasDaSeparacao(l.id).fardos : 0); } catch (e) { l.faltando = 0; }
    }
    return jsonOk(res, { separacoes: linhas });
  }

  // ══════════════════════════════════════════════════════════════
  //  DELETE /separacao/:id — apaga uma importação
  // --------------------------------------------------------------
  //  Testar gera lixo: guia importada duas vezes, carga montada para
  //  ver como fica, arquivo trocado no meio. Sem um jeito de apagar,
  //  a lista de separações vira um monte de tentativas e ninguém mais
  //  sabe qual é a de verdade.
  //
  //  O que NÃO se apaga junto: uma SOBRA já endereçada. Ela deixou de
  //  ser papel — é uma gaiola física, com etiqueta colada, ocupando um
  //  vão do galpão. Apagá-la porque a separação que a gerou foi
  //  descartada faria o mapa mentir sobre o que está na prateleira.
  //  As sobras ainda pendentes (sem etiqueta nova endereçada) somem,
  //  porque nunca chegaram a existir fora da tela.
  //
  //  Endereço liberado por uma coleta já bipada também NÃO volta: a
  //  gaiola saiu do vão de verdade, isso é história do galpão e não
  //  desta importação.
  // ══════════════════════════════════════════════════════════════
  if ((m = pathname.match(/^\/separacao\/(\d+)$/)) && req.method === 'DELETE') {
    const sepId = Number(m[1]);
    const s = db.prepare('SELECT * FROM separacoes WHERE id = ?').get(sepId);
    if (!s) return jsonErr(res, 404, `Separação ${sepId} não existe`);

    const presas = db.prepare(`SELECT COUNT(*) AS n FROM sobras
                                 WHERE separacao_id = ? AND status = 'enderecada'`).get(sepId).n;
    const coletadas = db.prepare(`SELECT COUNT(*) AS n FROM separacao_coletas
                                    WHERE separacao_id = ? AND status = 'coletada'`).get(sepId).n;

    const tr = makeTransaction(() => {
      const pedidos = db.prepare('SELECT id FROM separacao_pedidos WHERE separacao_id = ?').all(sepId);
      for (const p of pedidos) db.prepare('DELETE FROM separacao_itens WHERE pedido_id = ?').run(p.id);
      db.prepare('DELETE FROM separacao_pedidos WHERE separacao_id = ?').run(sepId);
      db.prepare('DELETE FROM separacao_coletas WHERE separacao_id = ?').run(sepId);
      // A sobra já endereçada perde o vínculo, não a vida.
      db.prepare(`UPDATE sobras SET separacao_id = NULL
                    WHERE separacao_id = ? AND status = 'enderecada'`).run(sepId);
      db.prepare(`DELETE FROM sobras WHERE separacao_id = ? AND status <> 'enderecada'`).run(sepId);
      db.prepare('DELETE FROM separacoes WHERE id = ?').run(sepId);
    });
    tr();

    // O comprovante some junto — mas só depois de o banco confirmar.
    if (s.arquivo) {
      try { fs.unlinkSync(path.join(GUIAS_DIR, s.arquivo)); }
      catch (e) { if (e.code !== 'ENOENT') logW('separacao', 'Não consegui apagar o arquivo da guia: ' + e.message); }
    }
    logI('separacao', `Separação ${sepId} apagada`
      + (coletadas ? ` (tinha ${coletadas} coleta(s) já bipada(s))` : '')
      + (presas ? `; ${presas} sobra(s) já endereçada(s) ficaram no mapa` : ''));
    return jsonOk(res, { id: sepId, apagada: true, coletadas_bipadas: coletadas,
                         sobras_preservadas: presas });
  }

  // POST /separacao/coleta/:id/confirmar — O BIPE DA COLETA.
  // É aqui que o ciclo fecha: a gaiola sai do endereço, o endereço é
  // liberado na hora, e se não foi 100% usada nasce a pendência de
  // reetiquetagem. { lido?, operador? }
  if ((m = pathname.match(/^\/separacao\/coleta\/(\d+)\/confirmar$/)) && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch (e) { return jsonErr(res, 400, e.message); }
    const c = db.prepare('SELECT * FROM separacao_coletas WHERE id = ?').get(Number(m[1]));
    if (!c) return jsonErr(res, 404, 'Coleta não encontrada');
    if (c.status === 'coletada') return jsonOk(res, { ja_estava: true, coleta: c });
    if (c.status !== 'planejada') return jsonErr(res, 409, `Coleta está como "${c.status}".`);

    // O que foi lido pode ser a etiqueta da gaiola ou a do endereço —
    // no chão de fábrica tanto faz o que está mais à mão.
    const lido = String(body.lido || '').trim().toUpperCase();
    if (lido && lido !== c.gaiola_id && lido !== c.posicao) {
      return jsonErr(res, 409,
        `Leitura "${lido}" não bate com esta coleta (gaiola ${c.gaiola_id} em ${c.posicao}).`,
        { divergente: true, coleta: c });
    }

    const agora = new Date().toISOString();
    const reg = gaiolasRegistro();
    let sobraId = null, sugerida = null;

    const tr = makeTransaction(() => {
      // 1. A gaiola sai do endereço — 100% usada ou não, ela não está
      //    mais lá. O endereço fica livre imediatamente.
      const ocup = db.prepare('SELECT * FROM ocupacoes WHERE gaiola_id = ? AND saida IS NULL').get(c.gaiola_id);
      if (ocup)
        db.prepare('UPDATE ocupacoes SET saida = ?, operador_s = ?, motivo_saida = ? WHERE id = ?')
          .run(agora, body.operador || null, `separacao ${c.separacao_id}`, ocup.id);

      // 2. A gaiola de origem é ENCERRADA. Se a etiqueta antiga
      //    sobreviver colada em algum canto, a leitura dela será
      //    recusada em vez de aceitar uma quantidade que não existe.
      if (reg[c.gaiola_id]) { reg[c.gaiola_id].encerrada_em = agora; gaiolasSalvar(reg); }

      db.prepare(`UPDATE separacao_coletas SET status='coletada', coletada_em=?, operador=? WHERE id=?`)
        .run(agora, body.operador || null, c.id);

      // 3. Sobra vira pendência de reetiquetagem, com endereço sugerido.
      if (c.sobra > 0) {
        const livres = posicoesLivresPreferidas(c.tipo_gaiola);
        sugerida = livres[0] || null;
        const r = db.prepare(`INSERT INTO sobras
              (separacao_id, gaiola_origem, cor_key, formato, tipo_gaiola, fardos,
               posicao_origem, posicao_sugerida, status, criada_em)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'aguardando_impressao', ?)`)
          .run(c.separacao_id, c.gaiola_id, c.cor_key, c.formato, c.tipo_gaiola,
               c.sobra, c.posicao, sugerida, agora);
        sobraId = Number(r.lastInsertRowid);
      }
    });
    tr();

    logI('separacao', `Coleta ${c.id}: gaiola ${c.gaiola_id} retirada de ${c.posicao}`
                    + (c.sobra > 0 ? ` — sobram ${c.sobra} fardo(s), reetiquetar` : ' — usada 100%'));
    return jsonOk(res, {
      coleta_id: c.id, gaiola: c.gaiola_id, posicao_liberada: c.posicao,
      usada_100: c.sobra === 0, sobra: c.sobra,
      sobra_id: sobraId, posicao_sugerida: sugerida,
    });
  }

  // POST /separacao/coleta/:id/nao-encontrada — a válvula de escape.
  // O mapa envelhece; sem isto o primeiro erro trava a separação
  // inteira e o pessoal abandona o sistema.
  if ((m = pathname.match(/^\/separacao\/coleta\/(\d+)\/nao-encontrada$/)) && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch (e) { body = {}; }
    const c = db.prepare('SELECT * FROM separacao_coletas WHERE id = ?').get(Number(m[1]));
    if (!c) return jsonErr(res, 404, 'Coleta não encontrada');
    if (c.status !== 'planejada') return jsonErr(res, 409, `Coleta está como "${c.status}".`);
    const agora = new Date().toISOString();
    const tr = makeTransaction(() => {
      db.prepare(`UPDATE separacao_coletas SET status='nao_encontrada', coletada_em=?, operador=? WHERE id=?`)
        .run(agora, body.operador || null, c.id);
      // O mapa mentia: a ocupação é encerrada com o motivo explícito,
      // para o histórico registrar POR QUE o endereço ficou livre.
      const ocup = db.prepare('SELECT * FROM ocupacoes WHERE gaiola_id = ? AND saida IS NULL').get(c.gaiola_id);
      if (ocup)
        db.prepare('UPDATE ocupacoes SET saida = ?, operador_s = ?, motivo_saida = ? WHERE id = ?')
          .run(agora, body.operador || null, 'nao encontrada na separacao', ocup.id);
    });
    tr();
    logW('separacao', `Gaiola ${c.gaiola_id} NÃO estava em ${c.posicao} (separação ${c.separacao_id})`);
    return jsonOk(res, { coleta_id: c.id, replanejar: `/separacao/${c.separacao_id}/planejar` });
  }

  // GET /sobras — a fila de reetiquetagem. É a aba do processo.
  if (pathname === '/sobras' && req.method === 'GET') {
    const todas = String(parsed.query.todas || '') === '1';
    const linhas = todas
      ? db.prepare('SELECT * FROM sobras ORDER BY id DESC LIMIT 200').all()
      : db.prepare(`SELECT * FROM sobras WHERE status <> 'enderecada' ORDER BY id`).all();
    return jsonOk(res, { sobras: linhas, pendentes: linhas.filter(s => s.status !== 'enderecada').length });
  }

  // POST /sobras/:id/imprimir — gera a etiqueta da gaiola que sobrou:
  // NÚMERO NOVO, mesmo produto, quantidade nova.
  if ((m = pathname.match(/^\/sobras\/(\d+)\/imprimir$/)) && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch (e) { body = {}; }
    const sb = db.prepare('SELECT * FROM sobras WHERE id = ?').get(Number(m[1]));
    if (!sb) return jsonErr(res, 404, 'Sobra não encontrada');
    if (sb.status === 'enderecada') return jsonErr(res, 409, 'Esta sobra já foi endereçada.');

    let id = sb.gaiola_nova;
    if (!id) {
      // Número novo. A gaiola antiga já foi encerrada na coleta.
      try { db.prepare(`INSERT OR IGNORE INTO seqs (tipo, valor) VALUES ('gaiola-pa', 1)`).run(); } catch (e) {}
      const seq = getProximoSeq('gaiola-pa');
      id = 'G' + String(seq).padStart(7, '0');
      incrementaSeq('gaiola-pa', seq);
      const reg = gaiolasRegistro();
      reg[id] = { id, corKey: sb.cor_key, formato: sb.formato, fardos: sb.fardos,
                  kg: sb.fardos * PA_KG_FARDO, tipo_gaiola: sb.tipo_gaiola,
                  criadaEm: new Date().toISOString(), operador: body.operador || null,
                  origem_sobra: sb.gaiola_origem };
      gaiolasSalvar(reg);
      db.prepare('UPDATE sobras SET gaiola_nova = ? WHERE id = ?').run(id, sb.id);
    }

    const epl = gerarEPLGaiolaPA({ id, corKey: sb.cor_key, formato: sb.formato,
                                   fardos: sb.fardos, tipo_gaiola: sb.tipo_gaiola });
    const impr = await new Promise(resolve => {
      try { imprimir(epl, body.impressora, (ok, saida, erro, impressora) =>
              resolve({ ok: !!ok, impressora, erro: erro || null })); }
      catch (e) { resolve({ ok: false, erro: e.message }); }
    });
    db.prepare(`UPDATE sobras SET status = 'impressa' WHERE id = ? AND status = 'aguardando_impressao'`).run(sb.id);
    logI('separacao', `Sobra ${sb.id}: etiqueta ${id} (${sb.formato} ${sb.cor_key}, ${sb.fardos} fardos) — `
                    + `endereço sugerido ${sb.posicao_sugerida || '(nenhum livre)'}`);
    return jsonOk(res, { sobra_id: sb.id, gaiola_nova: id, fardos: sb.fardos,
                         kg: sb.fardos * PA_KG_FARDO, posicao_sugerida: sb.posicao_sugerida,
                         impressao: impr });
  }

  return NAO_TRATADA;
}

module.exports = rotasSeparacao;
