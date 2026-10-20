// ════════════════════════════════════════════════════════════════════
//  ROTAS — dashboards (extrusão, resumo, movimentos, bobinas)
// ════════════════════════════════════════════════════════════════════

const fs     = require('fs');
const path   = require('path');

const { PUBLIC_DIR, RAIZ } = require('../lib/config');
const { dataLocalISO, ensureDir, logI, logW, rangeUTCdoDiaLocal } = require('../lib/log');
const { configGet, db } = require('../lib/db');
const { montagensDaBobina } = require('../lib/bobinas');
const { jsonErr, jsonOk, NAO_TRATADA } = require('../lib/http');

// Devolve NAO_TRATADA quando nenhuma rota daqui atende o pedido.
async function rotasDashboard(req, res, parsed, pathname) {
  let m;

  // ══════════════════════════════════════════════════════════════
  //  DASHBOARD DE EXTRUSÃO (acompanhamento em tempo real)
  // ══════════════════════════════════════════════════════════════
  //
  // GET /extrusao/dashboard[?dia=YYYY-MM-DD]
  //
  // Retorna agregações do dia (default: hoje). Pensado pra ser
  // consumido por uma UI de dashboard via polling a cada N segundos.
  //
  // Cancelados ficam de fora de TODOS os agregados (mas aparecem na
  // lista bruta `bobinas` com status='cancelada' pra auditoria).
  if (pathname === '/extrusao/dashboard' && req.method === 'GET') {
    const dia = parsed.query.dia || dataLocalISO();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dia)) return jsonErr(res, 400, 'dia deve ser YYYY-MM-DD');

    const { ini: _ini, fim: _fim } = rangeUTCdoDiaLocal(dia);

    const etiquetas = db.prepare(
      `SELECT id, seq_sessao, hora_impressao, hora_bipagem, turno_codigo,
                operador, maquina, cor, tipo_bobina, largura, sku,
                peso, peso_bruto, tara, status, sessao_id, bling_pedido_id
         FROM etiquetas
         WHERE tipo = 'extrusao' AND hora_impressao >= ? AND hora_impressao < ?
         ORDER BY hora_impressao DESC`
    ).all(_ini, _fim);

    const sessoes = db.prepare(
      `SELECT id, tipo, turno_codigo, operador, maquina, inicio, fim,
                total_kg, total_etiquetas, bling_status, bling_id, bling_erro
         FROM sessoes
         WHERE tipo = 'extrusao'
           AND ( (inicio >= ? AND inicio < ?) OR (fim >= ? AND fim < ?) )
         ORDER BY inicio DESC`
    ).all(_ini, _fim, _ini, _fim);

    const validas = etiquetas.filter(e => e.status !== 'cancelada');

    // Totais gerais
    const totais = {
      bobinas:            validas.length,
      kg_total:           Number(validas.reduce((a,b) => a + (b.peso || 0), 0).toFixed(2)),
      bipadas:            validas.filter(e => e.status === 'bipada').length,
      aguardando_bipe:    validas.filter(e => e.status === 'aguardando_bipe').length,
      canceladas:         etiquetas.length - validas.length,
      kg_bipados:         Number(validas.filter(e=>e.status==='bipada').reduce((a,b)=>a+(b.peso||0),0).toFixed(2)),
    };

    // Por turno (agrupa sessões do dia)
    const porTurno = {};
    for (const s of sessoes) {
      const tc = s.turno_codigo || '—';
      if (!porTurno[tc]) porTurno[tc] = { turno_codigo: tc, sessoes: [], totais: { bobinas: 0, kg: 0 } };
      const eDaSes = etiquetas.filter(e => e.sessao_id === s.id && e.status !== 'cancelada');
      const kg = Number(eDaSes.reduce((a,b) => a + (b.peso||0), 0).toFixed(2));
      porTurno[tc].sessoes.push({
        id: s.id, operador: s.operador, maquina: s.maquina,
        inicio: s.inicio, fim: s.fim,
        bobinas: eDaSes.length, kg,
        bling_status: s.bling_status, bling_id: s.bling_id, bling_erro: s.bling_erro,
        auto_finalizada: !!(s.bling_erro && s.bling_erro.startsWith('AUTO-')),
        aberta: s.fim == null,
      });
      porTurno[tc].totais.bobinas += eDaSes.length;
      porTurno[tc].totais.kg = Number((porTurno[tc].totais.kg + kg).toFixed(2));
    }

    // Por máquina
    const porMaquina = {};
    for (const e of validas) {
      const m = e.maquina || '—';
      if (!porMaquina[m]) porMaquina[m] = { maquina: m, bobinas: 0, kg: 0 };
      porMaquina[m].bobinas++;
      porMaquina[m].kg = Number((porMaquina[m].kg + (e.peso || 0)).toFixed(2));
    }

    // Por produto (cor|tipo|largura)
    const porProduto = {};
    for (const e of validas) {
      const k = `${e.cor||'?'}|${e.tipo_bobina||'?'}|${e.largura||'?'}`;
      if (!porProduto[k]) {
        porProduto[k] = { cor: e.cor, tipo_bobina: e.tipo_bobina, largura: e.largura, sku: e.sku, bobinas: 0, kg: 0 };
      }
      porProduto[k].bobinas++;
      porProduto[k].kg = Number((porProduto[k].kg + (e.peso || 0)).toFixed(2));
    }

    // Por hora do dia (0-23)
    const porHora = {};
    for (const e of validas) {
      const h = new Date(e.hora_impressao).getHours();
      const hStr = String(h).padStart(2, '0');
      if (!porHora[hStr]) porHora[hStr] = { hora: hStr, bobinas: 0, kg: 0 };
      porHora[hStr].bobinas++;
      porHora[hStr].kg = Number((porHora[hStr].kg + (e.peso || 0)).toFixed(2));
    }

    return jsonOk(res, {
      dia,
      gerado_em:   new Date().toISOString(),
      totais,
      por_turno:   Object.values(porTurno),
      por_maquina: Object.values(porMaquina).sort((a,b) => a.maquina.localeCompare(b.maquina)),
      por_produto: Object.values(porProduto).sort((a,b) => b.kg - a.kg),
      por_hora:    Object.values(porHora).sort((a,b) => a.hora.localeCompare(b.hora)),
      bobinas:     etiquetas,   // bruta, ordenada por hora desc; UI filtra/pagina
    });
  }

  if (pathname === '/dashboard/exportar-html' && req.method === 'GET') {
    const dias = Math.min(730, Math.max(1, parseInt(parsed.query.dias) || 180));
    const desde = new Date(Date.now() - dias * 86400000).toISOString().slice(0, 10);
    try {
      const linhas = db.prepare(
        `SELECT e.id, e.tipo, e.sub_tipo, e.material_key, e.material_nome, e.cor, e.fornecedor, e.lote,
                  e.peso, e.qtd_sacos, e.codigo, e.sku, e.status, e.ref_id, e.hora_impressao, e.hora_bipagem,
                  e.sessao_id, e.operador, e.maquina, e.largura, e.tipo_bobina, e.turno_codigo, e.bling_pedido_id,
                  e.destino, e.baixa_em, e.baixa_turno, e.baixa_operador,
                  e.fardos, e.encerrada_em, e.encerrada_motivo, e.alterado_em,
                  e.formato_cortado, e.formato_origem, e.pacotes, e.emendas,
                  s.bling_status, s.bling_id, s.bling_erro
             FROM etiquetas e LEFT JOIN sessoes s ON s.id = e.sessao_id
            WHERE date(e.hora_impressao) >= ?
            ORDER BY e.hora_impressao DESC`
      ).all(desde);
      const sessoes = db.prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM etiquetas x WHERE x.sessao_id = s.id) AS itens
             FROM sessoes s WHERE date(s.inicio) >= ? ORDER BY s.inicio DESC`
      ).all(desde);
      const baixas = [];
      try {
        for (const c of db.prepare(`SELECT chave, valor FROM config WHERE chave LIKE 'baixas_bobinas_%' ORDER BY chave DESC LIMIT 400`).all()) {
          const dia = c.chave.replace('baixas_bobinas_', '');
          if (dia < desde) continue;
          let lista = []; try { lista = JSON.parse(c.valor); } catch(e) {}
          for (const b of lista) baixas.push({ ...b, dia });
        }
      } catch(e) {}
      let inventario = { itens: [] };
      try { inventario = JSON.parse(configGet('inventario_atual', '{"itens":[]}')); } catch(e) {}

      const tpl = fs.readFileSync(path.join(PUBLIC_DIR, 'dashboard.html'), 'utf8');
      const dados = { linhas, sessoes, baixas, inventario, geradoEm: new Date().toISOString(), dias, desde };
      const injecao = `
<script id="eko-dados-embutidos">
/* ══════════════════════════════════════════════════════════════════════
   DASHBOARD AUTÔNOMO — Ekoplastic
   Todos os dados estão dentro deste arquivo. Não precisa de servidor,
   internet ou instalação: basta abrir num navegador.
   ══════════════════════════════════════════════════════════════════════ */
window.EKO_OFFLINE = ${JSON.stringify(dados).replace(/</g, '\\u003c')};
(function(){
  const D = window.EKO_OFFLINE;
  const dentro = (iso, de, ate) => { const d = (iso||'').slice(0,10); if (de && d < de) return false; if (ate && d > ate) return false; return true; };
  function filtrar(q){
    const de = q.get('de'), ate = q.get('ate');
    const tipos = (q.get('tipos')||'').split(',').map(x=>x.trim()).filter(Boolean);
    return D.linhas.filter(l => {
      if (!dentro(l.hora_impressao, de, ate)) return false;
      if (q.get('tipo') && l.tipo !== q.get('tipo')) return false;
      if (tipos.length && !tipos.includes(l.tipo)) return false;
      if (q.get('turno') && (l.turno_codigo||'') !== q.get('turno')) return false;
      if (q.get('maquina') && (l.maquina||'') !== q.get('maquina')) return false;
      if (q.get('fornecedor') && (l.fornecedor||'') !== q.get('fornecedor')) return false;
      if (q.get('material') && (l.material_key||'') !== q.get('material')) return false;
      if (q.get('status') && l.status !== q.get('status')) return false;
      if (q.get('operador') && (l.operador||'') !== q.get('operador')) return false;
      if (q.get('cor') && (l.cor||'') !== q.get('cor')) return false;
      const b = (q.get('busca')||'').toLowerCase();
      if (b && !((l.id||'').toLowerCase().includes(b) || (l.lote||'').toLowerCase().includes(b) || (l.sku||'').toLowerCase().includes(b))) return false;
      return true;
    });
  }
  const agrupar = (arr, chave) => {
    const m = new Map();
    for (const l of arr) {
      const k = chave(l);
      const o = m.get(k) || { chave: k, qtd: 0, kg: 0 };
      o.qtd++; o.kg += Number(l.peso)||0; m.set(k, o);
    }
    return [...m.values()].sort((a,b)=>b.kg-a.kg);
  };
  const respostas = {
    '/dashboard/opcoes': () => {
      const uni = f => [...new Set(D.linhas.map(f).filter(v=>v!=null&&v!==''))].sort();
      const datas = D.linhas.map(l=>(l.hora_impressao||'').slice(0,10)).filter(Boolean).sort();
      return { ok:true, periodo:{ inicio:datas[0]||null, fim:datas[datas.length-1]||null },
        turnos:uni(l=>l.turno_codigo), maquinas:uni(l=>l.maquina), operadores:uni(l=>l.operador),
        fornecedores:uni(l=>l.fornecedor), materiais:uni(l=>l.material_key), cores:uni(l=>l.cor) };
    },
    '/dashboard/resumo': q => {
      const f = filtrar(q);
      const conta = st => f.filter(l=>l.status===st).length;
      return { ok:true,
        totais:{ qtd:f.length, kg:f.reduce((a,l)=>a+(Number(l.peso)||0),0),
                 canceladas:conta('cancelada'), pendentes:conta('aguardando_bipe'), consumidas:conta('consumida') },
        porDia: agrupar(f, l=>(l.hora_impressao||'').slice(0,10)).sort((a,b)=>a.chave.localeCompare(b.chave)).map(x=>({dia:x.chave,qtd:x.qtd,kg:x.kg})),
        porTipo: agrupar(f, l=>l.tipo),
        porTurno: agrupar(f, l=>l.turno_codigo||'—'),
        porMaquina: agrupar(f, l=>l.maquina||'—'),
        porForn: agrupar(f, l=>l.fornecedor||'—').slice(0,20),
        porMaterial: agrupar(f, l=>(l.material_key||'—')+(l.cor?('|'+l.cor):'')).map(x=>{
          const [c,cor]=x.chave.split('|'); return { chave:c, cor:cor||'', qtd:x.qtd, kg:x.kg }; }).slice(0,25),
        porOperador: agrupar(f, l=>l.operador||'—').slice(0,20),
        porStatus: agrupar(f, l=>l.status).sort((a,b)=>b.qtd-a.qtd),
      };
    },
    '/dashboard/movimentos': q => {
      const f = filtrar(q);
      const lim = parseInt(q.get('limite'))||200, off = parseInt(q.get('offset'))||0;
      return { ok:true, total:f.length, linhas:f.slice(off, off+lim), limite:lim, offset:off };
    },
    '/dashboard/sessoes': q => {
      const de=q.get('de'), ate=q.get('ate');
      let ss = D.sessoes.filter(s => dentro(s.inicio, de, ate));
      if (q.get('tipo')) ss = ss.filter(s=>s.tipo===q.get('tipo'));
      if (q.get('turno')) ss = ss.filter(s=>(s.turno_codigo||'')===q.get('turno'));
      if (q.get('status')) ss = ss.filter(s=>s.bling_status===q.get('status'));
      return { ok:true, sessoes: ss };
    },
    '/dashboard/extras': () => ({ ok:true, baixas: D.baixas, inventario: D.inventario }),
  };
  // Substitui o acesso ao servidor pelos dados embutidos.
  window.fetch = function(url){
    const u = String(url).split('?');
    const q = new URLSearchParams(u[1]||'');
    const fn = respostas[u[0]];
    const corpo = fn ? fn(q) : { ok:false, erro:'indisponível no arquivo offline' };
    return Promise.resolve({ ok:true, status:200, json: () => Promise.resolve(corpo) });
  };
  // Marca visualmente que é um retrato, não a tela ao vivo.
  document.addEventListener('DOMContentLoaded', function(){
    const h = document.querySelector('header');
    if (!h) return;
    const tag = document.createElement('span');
    tag.style.cssText = 'font-size:11px;font-weight:800;letter-spacing:0.5px;background:rgba(0,224,208,0.14);'
      + 'color:#00e0d0;border:1px solid #00e0d0;border-radius:20px;padding:5px 11px;';
    const dt = new Date(D.geradoEm);
    tag.textContent = 'ARQUIVO · gerado em ' + dt.toLocaleString('pt-BR');
    h.appendChild(tag);
    const v = document.querySelector('header .voltar'); if (v) v.remove();
  });
})();
</script>`;
      // injeta antes do script principal do dashboard
      const marca = '<script>\nconst URL_BASE=';
      const html = tpl.includes(marca) ? tpl.replace(marca, injecao + '\n' + marca) : tpl.replace('</head>', injecao + '\n</head>');

      // salva na pasta do sistema (ao lado dos logs) e devolve para download
      const dir = path.join(RAIZ, 'dashboard');
      ensureDir(dir);
      const nome = `dashboard-${dataLocalISO()}.html`;
      try { fs.writeFileSync(path.join(dir, nome), html, 'utf8'); } catch(e) { logW('dash', 'Não consegui salvar em disco: ' + e.message); }
      logI('dash', `Dashboard autônomo gerado: ${nome} (${linhas.length} registros, ${dias} dias)`);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': `attachment; filename="${nome}"`,
        'X-Eko-Arquivo': nome, 'X-Eko-Registros': String(linhas.length),
      });
      return res.end(html);
    } catch(e) {
      return jsonErr(res, 500, 'Erro ao gerar o arquivo: ' + e.message);
    }
  }

  if (pathname === '/dashboard/opcoes' && req.method === 'GET') {
    const uni = (sql) => { try { return db.prepare(sql).all().map(r => r.v).filter(v => v != null && v !== ''); } catch(e) { return []; } };
    const per = (() => {
      try { return db.prepare(`SELECT MIN(date(hora_impressao)) AS ini, MAX(date(hora_impressao)) AS fim FROM etiquetas`).get(); }
      catch(e) { return {}; }
    })();
    return jsonOk(res, {
      periodo:     { inicio: per && per.ini, fim: per && per.fim },
      turnos:      uni(`SELECT DISTINCT turno_codigo AS v FROM etiquetas ORDER BY v`),
      maquinas:    uni(`SELECT DISTINCT maquina AS v FROM etiquetas ORDER BY v`),
      operadores:  uni(`SELECT DISTINCT operador AS v FROM etiquetas ORDER BY v`),
      fornecedores:uni(`SELECT DISTINCT fornecedor AS v FROM etiquetas ORDER BY v`),
      materiais:   uni(`SELECT DISTINCT material_key AS v FROM etiquetas ORDER BY v`),
      cores:       uni(`SELECT DISTINCT cor AS v FROM etiquetas ORDER BY v`),
    });
  }

  // Números do período (cartões + quebras por dia/turno/máquina/etc).
  if (pathname === '/dashboard/resumo' && req.method === 'GET') {
    const q = parsed.query;
    const de  = String(q.de  || '').slice(0, 10);
    const ate = String(q.ate || '').slice(0, 10);
    const cond = [], par = [];
    if (de)  { cond.push(`date(e.hora_impressao) >= ?`); par.push(de); }
    if (ate) { cond.push(`date(e.hora_impressao) <= ?`); par.push(ate); }
    for (const [campo, chave] of [['tipo','tipo'],['turno_codigo','turno'],['maquina','maquina'],
                                  ['fornecedor','fornecedor'],['material_key','material'],['status','status'],['operador','operador']]) {
      const v = q[chave];
      if (v) { cond.push(`e.${campo} = ?`); par.push(String(v)); }
    }
    // "tipos" aceita vários (ex.: a aba Matéria-Prima = recebimento+retirada+retorno)
    if (q.tipos) {
      const lista = String(q.tipos).split(',').map(x => x.trim()).filter(Boolean);
      if (lista.length) { cond.push(`e.tipo IN (${lista.map(() => '?').join(',')})`); par.push(...lista); }
    }
    const onde = cond.length ? ('WHERE ' + cond.join(' AND ')) : '';
    const roda = (sql, extra = []) => { try { return db.prepare(sql).all(...par, ...extra); } catch(e) { logW('dash', sql + ' :: ' + e.message); return []; } };

    const totais = roda(`SELECT COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg,
                             SUM(CASE WHEN e.status='cancelada' THEN 1 ELSE 0 END) AS canceladas,
                             SUM(CASE WHEN e.status='aguardando_bipe' THEN 1 ELSE 0 END) AS pendentes,
                             SUM(CASE WHEN e.status='consumida' THEN 1 ELSE 0 END) AS consumidas
                           FROM etiquetas e ${onde}`)[0] || {};
    return jsonOk(res, {
      totais,
      porDia:    roda(`SELECT date(e.hora_impressao) AS dia, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY dia ORDER BY dia`),
      porTipo:   roda(`SELECT e.tipo AS chave, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY e.tipo ORDER BY kg DESC`),
      porTurno:  roda(`SELECT COALESCE(e.turno_codigo,'—') AS chave, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY chave ORDER BY kg DESC`),
      porMaquina:roda(`SELECT COALESCE(e.maquina,'—') AS chave, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY chave ORDER BY kg DESC`),
      porForn:   roda(`SELECT COALESCE(e.fornecedor,'—') AS chave, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY chave ORDER BY kg DESC LIMIT 20`),
      porMaterial:roda(`SELECT COALESCE(e.material_key,'—') AS chave, COALESCE(e.cor,'') AS cor, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY chave, cor ORDER BY kg DESC LIMIT 25`),
      porOperador:roda(`SELECT COALESCE(e.operador,'—') AS chave, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY chave ORDER BY kg DESC LIMIT 20`),
      porStatus: roda(`SELECT e.status AS chave, COUNT(*) AS qtd, COALESCE(SUM(e.peso),0) AS kg
                         FROM etiquetas e ${onde} GROUP BY e.status ORDER BY qtd DESC`),
    });
  }

  // Lista detalhada de movimentos (cada etiqueta), com paginação.
  if (pathname === '/dashboard/movimentos' && req.method === 'GET') {
    const q = parsed.query;
    const cond = [], par = [];
    // alterados_desde (28/09/2026, VPS): etiquetas cuja bobina mudou na
    // sacoleira desde o instante dado, SEJA QUAL FOR a data de impressão.
    // Com ele, de/ate são ignorados. Ver etiquetas.alterado_em.
    const alteradosDesde = String(q.alterados_desde || '').trim();
    const de  = alteradosDesde ? '' : String(q.de  || '').slice(0, 10);
    const ate = alteradosDesde ? '' : String(q.ate || '').slice(0, 10);
    if (alteradosDesde) { cond.push(`e.alterado_em >= ?`); par.push(alteradosDesde); }
    if (de)  { cond.push(`date(e.hora_impressao) >= ?`); par.push(de); }
    if (ate) { cond.push(`date(e.hora_impressao) <= ?`); par.push(ate); }
    for (const [campo, chave] of [['tipo','tipo'],['turno_codigo','turno'],['maquina','maquina'],
                                  ['fornecedor','fornecedor'],['material_key','material'],['status','status'],['operador','operador'],['cor','cor']]) {
      const v = q[chave];
      if (v) { cond.push(`e.${campo} = ?`); par.push(String(v)); }
    }
    if (q.tipos) {
      const lista = String(q.tipos).split(',').map(x => x.trim()).filter(Boolean);
      if (lista.length) { cond.push(`e.tipo IN (${lista.map(() => '?').join(',')})`); par.push(...lista); }
    }
    if (q.busca) { cond.push(`(e.id LIKE ? OR e.lote LIKE ? OR e.sku LIKE ?)`); const b = '%' + String(q.busca) + '%'; par.push(b, b, b); }
    const onde = cond.length ? ('WHERE ' + cond.join(' AND ')) : '';
    const limite = Math.min(parseInt(q.limite) || 200, 1000);
    const desloc = parseInt(q.offset) || 0;
    try {
      const total = db.prepare(`SELECT COUNT(*) AS n FROM etiquetas e ${onde}`).get(...par).n;
      const linhas = db.prepare(
        `SELECT e.id, e.tipo, e.sub_tipo, e.material_key, e.material_nome, e.cor, e.fornecedor, e.lote,
                  e.peso, e.qtd_sacos, e.codigo, e.sku, e.status, e.ref_id, e.hora_impressao, e.hora_bipagem,
                  e.sessao_id, e.operador, e.maquina, e.largura, e.tipo_bobina, e.turno_codigo, e.bling_pedido_id,
                  e.destino, e.baixa_em, e.baixa_turno, e.baixa_operador,
                  e.fardos, e.encerrada_em, e.encerrada_motivo, e.alterado_em,
                  e.formato_cortado, e.formato_origem, e.pacotes, e.emendas,
                  rf.peso AS refugo_kg, rf.pesado_em AS refugo_em,
                  s.bling_status, s.bling_id, s.bling_erro
             FROM etiquetas e LEFT JOIN sessoes s ON s.id = e.sessao_id
             -- refugo EM ESTOQUE agora (02/10/2026): vai à VPS pelo exportador
             -- que já existe; registrar/cancelar carimba etiquetas.alterado_em.
             LEFT JOIN bobina_refugos rf ON rf.id = (SELECT MAX(x.id) FROM bobina_refugos x WHERE x.etiqueta_id = e.id
                                                       AND x.reaproveitado_em IS NULL AND x.cancelado_em IS NULL)
             ${onde} ORDER BY e.hora_impressao DESC LIMIT ? OFFSET ?`
      ).all(...par, limite, desloc);
      return jsonOk(res, { total, linhas, limite, offset: desloc,
                           ...(alteradosDesde ? { filtro: 'alterados_desde' } : {}) });
    } catch(e) { return jsonErr(res, 500, 'Erro na consulta: ' + e.message); }
  }

  // Inventários de bobinas para o exportador (28/09/2026, VPS): os abertos
  // e os que começaram ou terminaram desde ?desde=. Cada um com os itens.
  if (pathname === '/dashboard/inventario-bobinas' && req.method === 'GET') {
    const desde = String(parsed.query.desde || '1970-01-01').trim();
    const invs = db.prepare(
      `SELECT * FROM inventario_bobinas WHERE fim IS NULL OR inicio >= ? OR fim >= ? ORDER BY id`).all(desde, desde);
    const itens = db.prepare(
      `SELECT etiqueta_id, lido_em, situacao, operador FROM inventario_bobinas_itens
          WHERE inventario_id = ? ORDER BY lido_em`);
    return jsonOk(res, { filtro: 'inventario', inventarios: invs.map(i => ({ ...i, itens: itens.all(i.id) })) });
  }

  // Turnos do corte para o exportador (30/09/2026, VPS): os abertos e os
  // alterados desde ?desde= (abrir e encerrar carimbam alterado_em).
  if (pathname === '/dashboard/turnos-corte' && req.method === 'GET') {
    const desde = String(parsed.query.desde || '1970-01-01').trim();
    const turnos = db.prepare(
      `SELECT * FROM turnos_corte WHERE fim IS NULL OR alterado_em >= ? ORDER BY inicio, id`).all(desde);
    return jsonOk(res, { filtro: 'turnos_corte', turnos });
  }

  // Fardos por turno de cada bobina (30/09/2026): as partes gravadas desde
  // ?desde= (fim de turno com a bobina montada = 'turno'; saída = 'final').
  // A soma das partes de uma bobina é o etiquetas.fardos dela.
  if (pathname === '/dashboard/bobina-parciais' && req.method === 'GET') {
    const desde = String(parsed.query.desde || '1970-01-01').trim();
    // + as partes de bobina cujo REFUGO mudou desde ?desde= (15/10/2026: refugo
    // de 84,5 kg pesado na E0001961, movido para a E0001951 e cancelado — a VPS
    // seguia com o refugo velho nas partes, que não eram reenviadas).
    const parciais = db.prepare(
      `SELECT * FROM bobina_parciais WHERE registrado_em >= ? OR editado_em >= ?
            OR etiqueta_id IN (SELECT etiqueta_id FROM bobina_refugos WHERE alterado_em >= ?)
          ORDER BY registrado_em, id`).all(desde, desde, desde);
    // MONTAGEM e REFUGO de cada parte (07/10/2026, Gustavo — caso E0001797:
    // saiu da P1 como refugo e voltou na P2; a etiqueta só guarda a ÚLTIMA
    // montagem, e a VPS mostrava a parte da P1 como se fosse da P2 à 1h).
    // Vai junto das partes porque o exportador do Mini PC (C:\eko-push) não
    // vem com a atualização e já manda este arquivo.
    const cache = {};
    for (const p of parciais) {
      const ms = cache[p.etiqueta_id] || (cache[p.etiqueta_id] = montagensDaBobina(p.etiqueta_id));
      const m = ms.find(x => x.destino === p.maquina && x.baixa_em && x.baixa_em <= p.registrado_em
                             && (!x.encerrada_em || p.registrado_em <= x.encerrada_em)) || null;
      if (!m) continue;
      p.montagem_baixa_em = m.baixa_em; p.montagem_operador = m.baixa_operador || null;
      p.montagem_saida = m.encerrada_motivo || null;
      p.refugo_kg = m.refugo ? m.refugo.peso : null;
      p.refugo_em = m.refugo ? m.refugo.pesado_em : null;
      p.refugo_operador = m.refugo ? (m.refugo.operador || null) : null;
    }
    return jsonOk(res, { filtro: 'bobina_parciais', parciais });
  }

  // Refugos de bobina (02/10/2026) para a VPS: incremental por alterado_em.
  if (pathname === '/dashboard/bobina-refugos' && req.method === 'GET') {
    const desde = String(parsed.query.desde || '1970-01-01').trim();
    const refugos = db.prepare(
      `SELECT * FROM bobina_refugos WHERE alterado_em >= ? ORDER BY alterado_em, id`).all(desde);
    return jsonOk(res, { filtro: 'bobina_refugos', refugos });
  }

  // Sessões do período (com status de envio ao Bling e erros).
  if (pathname === '/dashboard/sessoes' && req.method === 'GET') {
    const q = parsed.query;
    const cond = [], par = [];
    const de  = String(q.de  || '').slice(0, 10);
    const ate = String(q.ate || '').slice(0, 10);
    if (de)  { cond.push(`date(s.inicio) >= ?`); par.push(de); }
    if (ate) { cond.push(`date(s.inicio) <= ?`); par.push(ate); }
    if (q.tipo)   { cond.push(`s.tipo = ?`);          par.push(String(q.tipo)); }
    if (q.turno)  { cond.push(`s.turno_codigo = ?`);  par.push(String(q.turno)); }
    if (q.status) { cond.push(`s.bling_status = ?`);  par.push(String(q.status)); }
    const onde = cond.length ? ('WHERE ' + cond.join(' AND ')) : '';
    try {
      const linhas = db.prepare(
        `SELECT s.*, (SELECT COUNT(*) FROM etiquetas x WHERE x.sessao_id = s.id) AS itens
             FROM sessoes s ${onde} ORDER BY s.inicio DESC LIMIT 500`
      ).all(...par);
      return jsonOk(res, { sessoes: linhas });
    } catch(e) { return jsonErr(res, 500, 'Erro na consulta: ' + e.message); }
  }

  // Baixas de bobina e inventários salvos (ficam em config, não em etiquetas).
  if (pathname === '/dashboard/extras' && req.method === 'GET') {
    const baixas = [];
    try {
      const chaves = db.prepare(`SELECT chave, valor FROM config WHERE chave LIKE 'baixas_bobinas_%' ORDER BY chave DESC LIMIT 62`).all();
      for (const c of chaves) {
        const dia = c.chave.replace('baixas_bobinas_', '');
        let lista = []; try { lista = JSON.parse(c.valor); } catch(e) {}
        for (const b of lista) baixas.push({ ...b, dia });
      }
    } catch(e) {}
    let inventario = { itens: [] };
    try { inventario = JSON.parse(configGet('inventario_atual', '{"itens":[]}')); } catch(e) {}
    return jsonOk(res, { baixas, inventario });
  }

  return NAO_TRATADA;
}

module.exports = rotasDashboard;
