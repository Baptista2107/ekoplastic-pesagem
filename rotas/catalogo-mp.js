// ════════════════════════════════════════════════════════════════════
//  ROTAS — cadastros de MP: sincronização com o Bling e catálogo
// ════════════════════════════════════════════════════════════════════

const { CAPAS_CATALOGO, OUTRAS_CATALOGO, PA_CORES } = require('../lib/config');
const { logI } = require('../lib/log');
const { configGet, configSet, dbStmts } = require('../lib/db');
const {
  corLabelPadrao, lerCatalogoMP, MP_CORES_CONHECIDAS, MP_MATERIAIS_PADRAO,
} = require('../lib/materiais');
const { getToken, proxyChamada } = require('../lib/bling');
const { jsonErr, jsonOk, lerBodyJson, NAO_TRATADA } = require('../lib/http');
const { chaveProduto, listarSubstituicoes } = require('../lib/negocio');

// Devolve NAO_TRATADA quando nenhuma rota daqui atende o pedido.
async function rotasCatalogoMp(req, res, parsed, pathname) {
  let m;

  // ══════════════════════════════════════════════════════════════
  //  RETIRADA DE BOBINAS (celular) — baixa individual no Bling.
  //  Cada bobina vira UM pedido de venda próprio (contato interno
  //  EKOPLASTIC), descontando o estoque daquele cor/tipo/largura.
  // ══════════════════════════════════════════════════════════════

  // ══════════════════════════════════════════════════════════════
  //  COLABORADORES — senha (PIN) de acesso às telas de operação.
  //  Cada pessoa tem um PIN próprio; o nome fica gravado na sessão
  //  e sai no resumo impresso como responsável.
  // ══════════════════════════════════════════════════════════════

  // Lista os colaboradores (NUNCA devolve o hash do PIN).
  // ══════════════════════════════════════════════════════════════
  //  DASHBOARD — histórico consolidado de todos os módulos.
  //  Lê o banco local (nada de planilha): filtra por período, tipo,
  //  turno, máquina, fornecedor, material e status.
  // ══════════════════════════════════════════════════════════════

  // Períodos disponíveis + números gerais (para montar os filtros na tela).
  // Histórico de cores por máquina+formato no Produto Acabado.
  // Não existe regra fixa (toda cor roda em toda máquina/formato), então a
  // proteção não pode ser uma trava: é o histórico que diz o que é comum.
  // Combinação nunca vista antes = provável engano, e o operador confirma.
  // Gera um DASHBOARD AUTÔNOMO: um único arquivo .html com todos os dados
  // embutidos dentro dele. Funciona sem servidor — dá para copiar para o
  // Google Drive, mandar por e-mail ou abrir em qualquer computador.
  // Truque: injeta os dados + um "fetch" falso que responde no lugar do
  // servidor, então a mesma tela do dashboard funciona offline sem alteração.
  // ══════════════════════════════════════════════════════════════
  //  ETIQUETA DE GAIOLA (Produto Acabado) — só para CONTAGEM.
  //  Gera o QR que o inventário vai ler. Não cria lançamento nem
  //  envia nada ao Bling: a produção continua sendo lançada como é hoje.
  // ══════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════
  //  SINCRONIZAR MATÉRIA-PRIMA COM O BLING
  //  Procura no Bling os produtos de MP e mostra os que ainda não
  //  estão no sistema, já interpretando material/cor/fornecedor pelo
  //  nome. O operador confere, informa o código gravimétrico e
  //  confirma — sem precisar de nova versão do sistema.
  // ══════════════════════════════════════════════════════════════

  // Procura produtos novos no Bling.
  if (pathname === '/sync/mp/procurar' && req.method === 'GET') {
    try {
      const token = await getToken();
      const mapaProd = JSON.parse(configGet('mapa_produto_bling', '{}'));
      const mapaForn = JSON.parse(configGet('mapa_fornecedor_bling', '{}'));
      const cat = lerCatalogoMP();

      // Nomes conhecidos, para reconhecer o que vier do Bling.
      const materiais = Object.keys(cat.materiais || {});
      const coresConhecidas = [...new Set(Object.values(cat.materiais || {}).flatMap(m => m.cores || []))];
      // Fornecedor: os do catálogo E os que já têm contato no Bling. Um
      // fornecedor que só fornece o material novo ainda não está em lista
      // de material nenhuma — mas o contato dele já está mapeado.
      const fornConhecidos  = [...new Set([...Object.values(cat.fornecedores || {}).flat(),
                                           ...Object.keys(mapaForn || {})])];

      const norm = t => String(t || '').toUpperCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Z0-9]+/g, ' ').trim();

      // Interpreta o produto do Bling: qual material, cor e fornecedor.
      // ORDEM IMPORTA: o fornecedor é identificado primeiro e retirado do
      // texto, senão nomes como "Cristal Master" seriam lidos como a cor
      // "Cristal". Nomes mais longos têm prioridade pelo mesmo motivo.
      const porTamanho = (a, b) => norm(b).length - norm(a).length;
      const fornOrdenados  = [...fornConhecidos].sort(porTamanho);
      // Termos de cor: o que já está cadastrado MAIS o dicionário de cores
      // conhecidas. Sem o dicionário, uma cor inédita no Bling não casa com
      // nada e o produto entra sem cor — foi o caso do AMARELO do grão.
      // Cada termo aponta para a grafia que a fábrica usa.
      const termosCor = new Map();
      for (const c of coresConhecidas) termosCor.set(norm(c), c);
      for (const [termo, cor] of Object.entries(MP_CORES_CONHECIDAS)) {
        if (!termosCor.has(norm(termo))) termosCor.set(norm(termo), cor);
      }
      const coresOrdenadas = [...termosCor.keys()].sort((a, b) => b.length - a.length);
      // Como cada material é reconhecido no nome/código do Bling. Os fixos
      // valem para os materiais antigos; um material criado pela tela traz
      // os dele (chave, nome e apelidos cadastrados). Sem isso, um material
      // novo nunca seria reconhecido — foi o que aconteceu com o AUXILIAR
      // DE FLUXO: a busca não tinha como saber que aquilo era matéria-prima.
      const apelidosFixos = { GBD: ['GBD', 'GRAO BAIXA', 'BAIXA DENSIDADE'], POLI: ['POLI', 'POLINYLON', 'NYLON'],
                              CARBO: ['CARBO', 'CARBONATO'], PIG: ['PIG', 'PIGMENTO'], DESSEC: ['DESSEC', 'DESSECANTE'],
                              AUXFLUX: ['AUXFLUX', 'AUXILIAR DE FLUXO', 'AUXILIAR FLUXO'],
                              EVOH: ['EVOH', 'RESINA EVOH'] };
      const alvosDe = m => {
        const mat = (cat.materiais || {})[m] || {};
        return [...new Set([m, ...(apelidosFixos[m] || []), mat.popular,
                            ...(Array.isArray(mat.apelidos) ? mat.apelidos : [])]
                 .filter(Boolean).map(norm).filter(a => a.length >= 3))];
      };
      const interpretar = (nome, codigo) => {
        const C = norm(codigo);                       // SKU: "AUXFLUX.CRISTAL" → "AUXFLUX CRISTAL"
        let N = norm(nome) + ' ' + C;
        // O apelido MAIS LONGO que casar vence: "RESINA EVOH" é mais
        // específico que um apelido curto que por acaso apareça no nome.
        let material = null, tamanhoAchado = 0;
        for (const m of materiais) {
          for (const a of alvosDe(m)) {
            if (a.length > tamanhoAchado && N.includes(a)) { material = m; tamanhoAchado = a.length; }
          }
        }
        const semEspaco = t => norm(t).replace(/ /g, '');
        let forn = fornOrdenados.find(f => N.includes(norm(f)) || N.replace(/ /g, '').includes(semEspaco(f))) || null;
        // Nome sem fornecedor: pela convenção MATERIAL.COR.FORNECEDOR, a
        // ÚLTIMA parte da SKU é o fornecedor, às vezes abreviado
        // ("EVOH.CRISTAL.TALL" = Tallpack). Só vale se casar com UM só.
        if (!forn && C.includes(' ')) {
          const ult = C.split(' ').pop();
          const casam = ult.length >= 4 ? fornOrdenados.filter(f => semEspaco(f).startsWith(ult)) : [];
          if (casam.length === 1) forn = casam[0];
        }
        // A COR sai do NOME, não da SKU: na SKU o fornecedor vem abreviado
        // ("AUXFLUX.CRISTAL" = Cristal Master) e seria lido como a cor
        // Cristal — e o produto viraria "Auxiliar de Fluxo Cristal", uma
        // combinação que não existe. Achado ao reproduzir o caso de 28/09.
        let T = norm(nome);
        if (forn) {
          // Remove o fornecedor do nome nas duas formas: com espaços
          // ("CRISTAL MASTER") e sem ("CRISTALMASTER").
          T = T.split(norm(forn)).join(' ');
          T = T.split(' ').map(p => p.includes(semEspaco(forn)) ? ' ' : p).join(' ');
        }
        const termo = coresOrdenadas.find(t => T.includes(t)) || null;
        let cor = termo ? termosCor.get(termo) : null;
        // Nome sem cor: a SKU ainda pode dizer ("GBD.COL.X"), pela
        // abreviação do próprio material ou pelo nome inteiro da cor —
        // pulando a 1ª parte (o material) e a parte que é o fornecedor.
        if (!cor && C) {
          const fornSE = forn ? semEspaco(forn) : '';
          const labs = (material && cat.materiais[material] && cat.materiais[material].corLabel) || {};
          for (const sg of C.split(' ').slice(1)) {
            if (fornSE && sg.length >= 3 && fornSE.startsWith(sg)) continue;
            const porLabel = Object.keys(labs).find(c => norm(labs[c]) === sg);
            if (porLabel) { cor = porLabel; break; }
            if (termosCor.has(sg)) { cor = termosCor.get(sg); break; }
          }
        }
        return { material, cor, fornecedor: forn };
      };

      // ── O QUE NÃO É MATÉRIA-PRIMA ────────────────────────────────
      // Produto acabado, bobina, capa e resíduo moram no mesmo Bling. Eles
      // não podem aparecer como "matéria-prima desconhecida", senão a lista
      // do que precisa de atenção vira ruído e ninguém mais lê.
      const skuNaoMP = /^(AM|BC|PT|REC)(\.|$)|^BOB\.|^CAPA\.|^RES\.|^APARA\./i;
      const idsNaoMP = new Set();
      for (const c of Object.values(PA_CORES)) if (c.bling_pai) idsNaoMP.add(String(c.bling_pai));
      // O cache de variações guarda SKU → id de PA e TAMBÉM de MP (o envio
      // de MP resolve variação pela SKU e grava ali). Só as SKUs de PA saem.
      try { for (const [sku, v] of Object.entries(JSON.parse(configGet('mapa_variacao_pa_bling', '{}')))) if (skuNaoMP.test(sku)) idsNaoMP.add(String(v)); } catch(e) {}
      try { for (const b of Object.values(JSON.parse(configGet('mapa_bobina_bling', '{}')))) if (b && b.id) idsNaoMP.add(String(b.id)); } catch(e) {}
      for (const c of Object.values(CAPAS_CATALOGO)) if (c.id) idsNaoMP.add(String(c.id));
      for (const c of Object.values(OUTRAS_CATALOGO)) if (c.blingId) idsNaoMP.add(String(c.blingId));
      const naoEhMP = p => idsNaoMP.has(String(p.id)) || skuNaoMP.test(String(p.codigo || ''))
                        || (p.pai && (idsNaoMP.has(String(p.pai.id)) || skuNaoMP.test(String(p.pai.codigo || ''))));

      // ── 1) A LISTAGEM (a mesma chamada de sempre) ────────────────
      const listados = [];
      let pagina = 1, paginasLidas = 0;
      while (pagina <= 20) {
        const r = await proxyChamada(token, 'GET', '/Api/v3/produtos', `?pagina=${pagina}&limite=100&criterio=2`, '');
        let d = {}; try { d = JSON.parse(r.body); } catch(e) {}
        const lista = Array.isArray(d.data) ? d.data : [];
        paginasLidas++;
        if (!lista.length) break;
        listados.push(...lista);
        if (lista.length < 100) break;
        pagina++;
      }

      // ── 2) AS VARIAÇÕES ──────────────────────────────────────────
      // Produto com variação ('V'): o nome do pai diz o MATERIAL
      // ("AUXILIAR DE FLUXO") e só a variação diz o FORNECEDOR e a COR
      // ("Fornecedor:CRISTAL MASTER"). A busca lia só a listagem, então o
      // fornecedor nunca aparecia. Agora o detalhe de cada pai é aberto e
      // cada variação é lida com o nome do pai junto.
      // Ritmo de 350 ms entre consultas: o Bling aceita 3 por segundo, e
      // a estação faz outros envios ao mesmo tempo.
      const expandidas = [], paisAbertos = new Set();
      let consultasVariacao = 0, variacoesFalharam = 0;
      for (const p of listados) {
        if (p.formato !== 'V' || naoEhMP(p)) continue;
        if (consultasVariacao >= 40) break;
        consultasVariacao++;
        await new Promise(ok => setTimeout(ok, 350));
        try {
          const r = await proxyChamada(token, 'GET', '/Api/v3/produtos/' + encodeURIComponent(p.id), '', '');
          let d = {}; try { d = JSON.parse(r.body); } catch(e) {}
          const vars = (d.data && Array.isArray(d.data.variacoes)) ? d.data.variacoes : [];
          if (!vars.length) continue;                   // sem variação legível: o pai segue como antes
          paisAbertos.add(String(p.id));
          for (const v of vars) {
            expandidas.push({ id: v.id, nome: String(v.nome || ''), codigo: String(v.codigo || ''),
                              formato: 'V', atributos: (v.variacao && v.variacao.nome) || '',
                              pai: { id: p.id, nome: String(p.nome || ''), codigo: String(p.codigo || '') } });
          }
        } catch(e) { variacoesFalharam++; }
      }

      // ── 3) UM CANDIDATO POR PRODUTO ──────────────────────────────
      // A variação vem primeiro: se o Bling também a listar sozinha, fica
      // a versão que tem o nome do pai junto. O pai cujas variações foram
      // abertas sai — quem o representa são as variações.
      const candidatos = new Map();
      for (const v of expandidas) candidatos.set(String(v.id), v);
      for (const p of listados) {
        const id = String(p.id);
        if (candidatos.has(id) || paisAbertos.has(id)) continue;
        candidatos.set(id, p);
      }

      // Chave e nome sugeridos para um material que o sistema não conhece:
      // a SKU "AUXFLUX.CRISTAL" já diz "AUXFLUX"; sem SKU, a 1ª palavra.
      const tituloDe = t => String(t || '').toLowerCase().replace(/(^|\s)\S/g, x => x.toUpperCase()).trim();
      const sugestaoDe = p => {
        const cod = String(p.codigo || (p.pai && p.pai.codigo) || '');
        let k = cod ? cod.split('.')[0] : String((p.pai && p.pai.nome) || p.nome || '').split(/\s+/).pop();
        k = norm(k).replace(/ /g, '').slice(0, 10);
        return { chave: /^[A-Z][A-Z0-9]{1,9}$/.test(k) ? k : null,
                 nome: tituloDe((p.pai && p.pai.nome) || p.nome) };
      };

      const achados = [], naoReconhecidos = [];
      for (const p of candidatos.values()) {
        if (naoEhMP(p)) continue;
        const codigo = String(p.codigo || '');
        const nome   = String(p.nome || '');
        // O pai entra no texto: é ele que diz qual é o material.
        const texto = [p.pai && p.pai.nome, nome, p.atributos].filter(Boolean).join(' ');
        const info = interpretar(texto, codigo);
        if (!info.material) {
          // Antes: `continue` e o produto sumia calado. Agora ele aparece —
          // pode ser um material novo que só precisa ser criado.
          const sug = sugestaoDe(p);
          naoReconhecidos.push({ bling_id: String(p.id), codigo, nome,
                                 pai: p.pai ? { id: String(p.pai.id), nome: p.pai.nome, codigo: p.pai.codigo } : null,
                                 formato: p.formato || null,
                                 fornecedor: info.fornecedor, cor: info.cor,
                                 sugestao_material: sug.chave, sugestao_nome: sug.nome });
          continue;
        }
        const chave = chaveProduto(info.material, info.cor || '', info.fornecedor || '');
        // A cor pode ser conhecida no sistema e mesmo assim não existir
        // NESTE material — "Amarelo" existia no Pigmento e não no Grão.
        // Enquanto ela não entra no catálogo do material, a tela de
        // Recebimento não tem como oferecê-la ao operador.
        const coresDoMaterial = (cat.materiais[info.material] && cat.materiais[info.material].cores) || [];
        const corNova = !!(info.cor && !coresDoMaterial.includes(info.cor));
        const labelAtual = (cat.materiais[info.material] && cat.materiais[info.material].corLabel) || {};
        achados.push({
          bling_id: String(p.id), codigo, nome: p.pai ? `${p.pai.nome} · ${p.atributos || nome}` : nome,
          material: info.material, cor: info.cor, fornecedor: info.fornecedor,
          chave,
          ja_existe: !!mapaProd[chave],
          formato: p.formato || null,                        // 'S' simples / 'V' variação (grava a SKU dela)
          completo: !!(info.material && info.fornecedor),     // dá para cadastrar direto?
          cor_nova: corNova,                                  // precisa entrar no catálogo do material
          cor_label: info.cor ? (labelAtual[info.cor] || corLabelPadrao(info.cor)) : null,
        });
      }

      const novos = achados.filter(a => !a.ja_existe);

      // Cores que faltam no catálogo do material — inclusive as de produtos
      // JÁ mapeados. Isto é o que conserta o caso do AMARELO: o produto podia
      // já ter sido cadastrado numa sincronização anterior (e por isso sumir
      // da lista de "novos"), mas a cor nunca entrou no material, então a tela
      // de Recebimento continuava sem ela. Aqui ela aparece de qualquer jeito.
      const pend = new Map();
      for (const a of achados) {
        if (!a.cor_nova) continue;
        const k = a.material + '|' + a.cor;
        if (!pend.has(k)) pend.set(k, { material: a.material, cor: a.cor, label: a.cor_label, exemplos: [], produtos: 0 });
        const p = pend.get(k);
        p.produtos++;
        if (p.exemplos.length < 3) p.exemplos.push(a.nome);
      }
      const coresPendentes = [...pend.values()];
      if (coresPendentes.length) {
        logI('sync', `Sincronização: ${coresPendentes.length} cor(es) ainda fora do catálogo — `
          + coresPendentes.map(c => `${c.material}/${c.cor}`).join(', '));
      }

      if (naoReconhecidos.length) {
        logI('sync', `Sincronização: ${naoReconhecidos.length} produto(s) sem material conhecido — `
          + [...new Set(naoReconhecidos.map(n => n.sugestao_material || n.nome))].slice(0, 8).join(', '));
      }
      return jsonOk(res, {
        paginas_lidas: paginasLidas,
        produtos_lidos: listados.length,
        variacoes_abertas: expandidas.length,
        pais_consultados: consultasVariacao,
        variacoes_com_falha: variacoesFalharam,
        total_mp_encontrados: achados.length,
        ja_cadastrados: achados.length - novos.length,
        novos,
        nao_reconhecidos: naoReconhecidos,
        cores_pendentes: coresPendentes,
        fornecedores_sem_contato: [...new Set(novos.filter(n => n.fornecedor && !mapaForn[n.fornecedor]).map(n => n.fornecedor))],
      });
    } catch(e) {
      return jsonErr(res, 502, 'Erro ao consultar o Bling: ' + e.message);
    }
  }

  // Procura o contato (fornecedor) no Bling pelo nome.
  if (pathname === '/sync/mp/contato' && req.method === 'GET') {
    const nome = String(parsed.query.nome || '').trim();
    if (!nome) return jsonErr(res, 400, 'Informe o nome do fornecedor');
    try {
      const token = await getToken();
      const r = await proxyChamada(token, 'GET', '/Api/v3/contatos', `?pesquisa=${encodeURIComponent(nome)}&limite=20`, '');
      let d = {}; try { d = JSON.parse(r.body); } catch(e) {}
      const lista = (Array.isArray(d.data) ? d.data : []).map(c => ({
        id: String(c.id), nome: c.nome, documento: c.numeroDocumento || null, tipo: c.tipo || null,
      }));
      return jsonOk(res, { contatos: lista });
    } catch(e) { return jsonErr(res, 502, 'Erro ao consultar contatos: ' + e.message); }
  }

  // ── CRIAR UM MATERIAL NOVO PELA TELA ─────────────────────────────
  // Produto do Bling que a busca não reconhece (material que o sistema
  // ainda não tem) pode virar material aqui, sem atualização de código.
  // Foi o que faltou com o AUXILIAR DE FLUXO em 28/09/2026.
  //   { matKey, popular, unidade: 'sacos'|'bigbag', kgPorSaco?: 25, apelidos?: [] }
  // 'sacos' = entra e sai por número de sacos (como os aditivos). O peso do
  // saco é do material: 25 kg na maioria, 20 kg no Compatibilizante PA/PE;
  // 'bigbag' = pesado na balança, com etiqueta (como grão e Polinylon).
  // Não sobrescreve material que já existe — a chave é a identidade dele
  // nas etiquetas e nos mapas do Bling.
  if (pathname === '/sync/mp/material' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const matKey  = String(body.matKey || '').trim().toUpperCase();
    const popular = String(body.popular || '').trim().replace(/\s+/g, ' ');
    const unidade = String(body.unidade || '').trim().toLowerCase();
    if (!/^[A-Z][A-Z0-9]{1,9}$/.test(matKey))
      return jsonErr(res, 400, 'A sigla do material deve ter de 2 a 10 letras ou números, começando por letra, sem espaço (ex.: AUXFLUX).');
    if (popular.length < 2 || popular.length > 40)
      return jsonErr(res, 400, 'O nome do material deve ter de 2 a 40 caracteres.');
    if (!['sacos', 'bigbag'].includes(unidade))
      return jsonErr(res, 400, 'Informe como o material entra: "sacos" (contado em sacos) ou "bigbag" (pesado na balança).');
    // Peso do saco: sem informar, 25 kg (o padrão da fábrica). Aceita uma
    // casa decimal (ex.: 22,5) e fica entre 1 e 100 kg.
    let kgSaco = null;
    if (unidade === 'sacos') {
      const bruto = body.kgPorSaco === undefined || body.kgPorSaco === null || body.kgPorSaco === '' ? 25
                  : Number(String(body.kgPorSaco).replace(',', '.'));
      if (!Number.isFinite(bruto) || bruto < 1 || bruto > 100)
        return jsonErr(res, 400, 'O peso do saco deve ser de 1 a 100 kg.');
      kgSaco = Math.round(bruto * 10) / 10;
    }
    // Siglas que já são de outra coisa no sistema (produto acabado,
    // bobina, capa, resíduo) não podem virar matéria-prima.
    const reservadas = ['AM', 'BC', 'PT', 'REC', 'BOB', 'CAPA', 'RES', 'APARA', 'PA', 'MP'];
    if (reservadas.includes(matKey)) return jsonErr(res, 409, `A sigla ${matKey} já é usada pelo sistema para outra coisa. Escolha outra.`);
    const mats = JSON.parse(configGet('mp_materiais', '{}'));
    if (mats[matKey] || MP_MATERIAIS_PADRAO[matKey])
      return jsonErr(res, 409, `Já existe um material com a sigla ${matKey} (${(mats[matKey] || MP_MATERIAIS_PADRAO[matKey]).popular || matKey}). Nada foi alterado.`);
    const apelidos = [...new Set((Array.isArray(body.apelidos) ? body.apelidos : [])
      .map(a => String(a || '').trim().toUpperCase()).filter(a => a.length >= 3 && a.length <= 40))].slice(0, 6);
    mats[matKey] = {
      popular, nomeEtiqueta: popular.toUpperCase(), cores: [], corLabel: {},
      porSacos: unidade === 'sacos', kgPorSaco: kgSaco,
      apelidos, criadoEm: new Date().toISOString(), origem: 'cadastros-bling',
    };
    configSet('mp_materiais', JSON.stringify(mats));
    const fornCatM = JSON.parse(configGet('mp_fornecedores', '{}'));
    if (!Array.isArray(fornCatM[matKey])) { fornCatM[matKey] = []; configSet('mp_fornecedores', JSON.stringify(fornCatM)); }
    logI('sync', `Material novo criado pela tela: ${matKey} — ${popular} (${unidade === 'sacos' ? `sacos de ${kgSaco} kg` : 'big bag pesado'})`
      + (apelidos.length ? ` · reconhecido também por ${apelidos.join(', ')}` : ''));
    return jsonOk(res, { criado: true, matKey, material: mats[matKey] });
  }

  // Grava no sistema o que o operador confirmou.
  if (pathname === '/sync/mp/confirmar' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const itens = Array.isArray(body.itens) ? body.itens : [];
    if (!itens.length) return jsonErr(res, 400, 'Nenhum item para cadastrar');

    const mapaProd = JSON.parse(configGet('mapa_produto_bling', '{}'));
    const mapaForn = JSON.parse(configGet('mapa_fornecedor_bling', '{}'));
    const mapaSku  = JSON.parse(configGet('mapa_sku_variacao_mp', '{}'));
    const cat = lerCatalogoMP();
    const fornCat  = JSON.parse(configGet('mp_fornecedores', '{}'));
    const codigos  = JSON.parse(configGet('mp_codigos_gravimetricos', '[]'));

    const mats = JSON.parse(configGet('mp_materiais', '{}'));
    const coresCadastradas = [];
    // Para avisar se este cadastro LIGOU uma troca de produto (ex.: mapear
    // a Resina EVOH liga a leitura das etiquetas antigas de Polinylon).
    const trocasAntes = new Set(listarSubstituicoes().filter(t => t.ativa).map(t => t.de));

    const feitos = [], erros = [];
    for (const it of itens) {
      try {
        const material = String(it.material || '').toUpperCase();
        const cor  = it.cor || null;
        const forn = String(it.fornecedor || '').trim();
        if (!material || !forn) { erros.push({ item: it, erro: 'material e fornecedor são obrigatórios' }); continue; }
        if (!cat.materiais[material]) { erros.push({ item: it, erro: `material ${material} desconhecido` }); continue; }

        // Cor que ainda não existe NESTE material entra agora no catálogo —
        // é isso que faz ela aparecer na tela de Recebimento. Sem esta parte,
        // o fornecedor entrava e a cor não (bug encontrado em 01/09/2026).
        if (cor && mats[material]) {
          if (!Array.isArray(mats[material].cores)) mats[material].cores = [];
          if (!mats[material].corLabel || typeof mats[material].corLabel !== 'object') mats[material].corLabel = {};
          if (!mats[material].cores.includes(cor)) {
            mats[material].cores.push(cor);
            mats[material].corLabel[cor] = String(it.cor_label || mats[material].corLabel[cor] || corLabelPadrao(cor)).toUpperCase();
            coresCadastradas.push({ material, cor, label: mats[material].corLabel[cor] });
          }
        }

        const chave = chaveProduto(material, cor || '', forn);
        mapaProd[chave] = String(it.bling_id);
        if (it.contato_id) mapaForn[forn] = String(it.contato_id);
        // produto com variação precisa da SKU para resolver a variação certa
        if (it.formato === 'V' && it.codigo) mapaSku[chave] = String(it.codigo);

        if (!Array.isArray(fornCat[material])) fornCat[material] = [];
        if (!fornCat[material].includes(forn)) fornCat[material].push(forn);

        if (it.codigo_gravimetrico) {
          const jaTem = codigos.some(c => c.matKey === material && (c.cor || null) === (cor || null) && (c.forn || null) === forn);
          if (!jaTem) codigos.push({ matKey: material, cor: cor || null, forn, codigo: String(it.codigo_gravimetrico).toUpperCase() });
        }
        feitos.push({ chave, bling_id: it.bling_id, fornecedor: forn, codigo_gravimetrico: it.codigo_gravimetrico || null });
      } catch(e) { erros.push({ item: it, erro: e.message }); }
    }

    configSet('mapa_produto_bling', JSON.stringify(mapaProd));
    configSet('mapa_fornecedor_bling', JSON.stringify(mapaForn));
    configSet('mapa_sku_variacao_mp', JSON.stringify(mapaSku));
    configSet('mp_fornecedores', JSON.stringify(fornCat));
    configSet('mp_codigos_gravimetricos', JSON.stringify(codigos));
    if (coresCadastradas.length) {
      configSet('mp_materiais', JSON.stringify(mats));
      for (const c of coresCadastradas) logI('sync', `Cor cadastrada pelo Bling: ${c.material} · ${c.cor} (SKU ${c.label})`);
    }
    for (const f of feitos) logI('sync', `Cadastrado pelo Bling: ${f.chave} → produto ${f.bling_id}${f.codigo_gravimetrico ? ' · código ' + f.codigo_gravimetrico : ''}`);
    const trocasAtivadas = listarSubstituicoes().filter(t => t.ativa && !trocasAntes.has(t.de));
    for (const t of trocasAtivadas) logI('sync', `Troca de produto LIGADA: etiquetas de ${t.de} passam a ser lidas como ${t.para}`);
    return jsonOk(res, { cadastrados: feitos.length, feitos, erros, cores_cadastradas: coresCadastradas,
                         trocas_ativadas: trocasAtivadas.map(t => ({ de: t.de, para: t.para, de_nome: t.de_nome, para_nome: t.para_nome })) });
  }

  if (pathname === '/catalogo-mp' && req.method === 'GET') {
    const c = lerCatalogoMP();
    // substituicoes: trocas de produto cadastradas, cada uma com "ativa".
    // A tela de Recebimento usa as ativas para avisar antes de pesar.
    let subsCat = [];
    try { subsCat = listarSubstituicoes().map(t => ({ de: t.de, para: t.para, ativa: t.ativa, de_nome: t.de_nome, para_nome: t.para_nome })); } catch(e) {}
    return jsonOk(res, { fornecedores: c.fornecedores, codigos: c.codigos, materiais: c.materiais, substituicoes: subsCat });
  }

  // ─── CORES DE UM MATERIAL ───────────────────────────────────────
  // Até 01/09/2026 as cores eram fixas no código e não havia como
  // cadastrar uma nova — nem pela sincronização com o Bling, nem por
  // tela nenhuma. Estas duas rotas fecham esse buraco.
  //
  // POST /catalogo-mp/cor  { matKey, cor, label?, renomear_de? }
  //   Sem renomear_de: cadastra a cor no material.
  //   Com renomear_de: troca o nome e ARRASTA JUNTO tudo que aponta
  //   para o nome antigo — códigos gravimétricos e os mapas do Bling.
  //   Renomear sem arrastar deixaria a etiqueta com um nome e o
  //   lançamento no Bling com outro.
  if (pathname === '/catalogo-mp/cor' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const matKey = String(body.matKey || '').trim().toUpperCase();
    const cor    = String(body.cor || '').trim();
    const antiga = body.renomear_de ? String(body.renomear_de).trim() : null;
    if (!matKey) return jsonErr(res, 400, 'Informe o material');
    if (!cor)    return jsonErr(res, 400, 'Informe o nome da cor');
    if (cor.length > 24) return jsonErr(res, 400, 'Nome de cor muito longo (máximo 24 caracteres)');

    const mats = JSON.parse(configGet('mp_materiais', '{}'));
    if (!mats[matKey]) return jsonErr(res, 400, `Material desconhecido: ${matKey}`);
    if (!Array.isArray(mats[matKey].cores)) mats[matKey].cores = [];
    if (!mats[matKey].corLabel || typeof mats[matKey].corLabel !== 'object') mats[matKey].corLabel = {};

    const label = String(body.label || mats[matKey].corLabel[cor] || corLabelPadrao(cor))
      .replace(/[^A-Za-z0-9]/g, '').toUpperCase().substring(0, 6);
    if (!label) return jsonErr(res, 400, 'A abreviação da SKU não pode ficar vazia');

    const migrado = { codigos: 0, produtos_bling: 0, skus_variacao: 0 };

    if (antiga) {
      if (!mats[matKey].cores.includes(antiga)) return jsonErr(res, 404, `A cor "${antiga}" não existe em ${matKey}`);
      if (antiga !== cor && mats[matKey].cores.includes(cor)) {
        return jsonErr(res, 409, `${matKey} já tem uma cor chamada "${cor}"`);
      }
      mats[matKey].cores = mats[matKey].cores.map(c => (c === antiga ? cor : c));
      delete mats[matKey].corLabel[antiga];

      // Códigos gravimétricos que apontavam para o nome antigo.
      const codigos = JSON.parse(configGet('mp_codigos_gravimetricos', '[]'));
      for (const c of codigos) {
        if (c.matKey === matKey && (c.cor || null) === antiga) { c.cor = cor; migrado.codigos++; }
      }
      if (migrado.codigos) configSet('mp_codigos_gravimetricos', JSON.stringify(codigos));

      // Mapas do Bling: a chave é material:cor:fornecedor. Sem re-chavear,
      // o produto some do envio e a sessão vira pendente_config.
      for (const chaveCfg of ['mapa_produto_bling', 'mapa_sku_variacao_mp']) {
        const mapa = JSON.parse(configGet(chaveCfg, '{}'));
        let mudou = 0;
        for (const k of Object.keys(mapa)) {
          const [m, c, f] = k.split(':');
          if (m === matKey && c === antiga) {
            const nova = chaveProduto(matKey, cor, f);
            if (nova !== k) { mapa[nova] = mapa[k]; delete mapa[k]; mudou++; }
          }
        }
        if (mudou) configSet(chaveCfg, JSON.stringify(mapa));
        if (chaveCfg === 'mapa_produto_bling') migrado.produtos_bling = mudou;
        else migrado.skus_variacao = mudou;
      }
    } else {
      if (mats[matKey].cores.includes(cor)) {
        // Já existe: só atualiza a abreviação, se veio uma diferente.
        if (body.label && mats[matKey].corLabel[cor] !== label) {
          mats[matKey].corLabel[cor] = label;
          configSet('mp_materiais', JSON.stringify(mats));
          logI('db', `Catálogo: abreviação de ${matKey}/${cor} agora é ${label}`);
          return jsonOk(res, { atualizado: true, matKey, cor, label, materiais: mats });
        }
        return jsonErr(res, 409, `${matKey} já tem a cor "${cor}"`);
      }
      mats[matKey].cores.push(cor);
    }

    mats[matKey].corLabel[cor] = label;
    configSet('mp_materiais', JSON.stringify(mats));
    logI('db', antiga
      ? `Catálogo: cor ${matKey}/${antiga} renomeada para ${cor} (SKU ${label}) — ${migrado.codigos} código(s), ${migrado.produtos_bling} produto(s) Bling migrado(s)`
      : `Catálogo: cor ${matKey}/${cor} cadastrada (SKU ${label})`);
    return jsonOk(res, { cadastrado: !antiga, renomeado: !!antiga, matKey, cor, label, migrado, materiais: mats });
  }

  // POST /catalogo-mp/cor/remover  { matKey, cor, forcar? }
  // Não apaga cor que ainda está amarrada a código gravimétrico ou a
  // produto do Bling — nesse caso devolve o que está preso, e só sai com
  // forcar:true. Etiquetas já impressas guardam a cor no próprio registro
  // e não são afetadas: sumir do catálogo só tira a cor da lista de escolha.
  if (pathname === '/catalogo-mp/cor/remover' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const matKey = String(body.matKey || '').trim().toUpperCase();
    const cor    = String(body.cor || '').trim();
    if (!matKey || !cor) return jsonErr(res, 400, 'Informe o material e a cor');

    const mats = JSON.parse(configGet('mp_materiais', '{}'));
    if (!mats[matKey] || !Array.isArray(mats[matKey].cores) || !mats[matKey].cores.includes(cor)) {
      return jsonErr(res, 404, `A cor "${cor}" não existe em ${matKey}`);
    }

    const codigos = JSON.parse(configGet('mp_codigos_gravimetricos', '[]'));
    const presosCod = codigos.filter(c => c.matKey === matKey && (c.cor || null) === cor);
    const mapaProdC = JSON.parse(configGet('mapa_produto_bling', '{}'));
    const presosBling = Object.keys(mapaProdC).filter(k => {
      const [m, c] = k.split(':'); return m === matKey && c === cor;
    });
    if ((presosCod.length || presosBling.length) && !body.forcar) {
      return jsonErr(res, 409,
        `A cor "${cor}" ainda está em uso: ${presosCod.length} código(s) gravimétrico(s) e ${presosBling.length} produto(s) do Bling. `
        + 'Remova esses vínculos antes, ou confirme a remoção mesmo assim.',
        { codigos: presosCod, produtos_bling: presosBling, em_uso: true });
    }

    mats[matKey].cores = mats[matKey].cores.filter(c => c !== cor);
    if (mats[matKey].corLabel) delete mats[matKey].corLabel[cor];
    configSet('mp_materiais', JSON.stringify(mats));
    logI('db', `Catálogo: cor ${matKey}/${cor} removida da lista${body.forcar ? ' (forçado)' : ''}`);
    return jsonOk(res, { removido: true, matKey, cor, materiais: mats,
                         avisos: { codigos: presosCod.length, produtos_bling: presosBling.length } });
  }

  // Cadastro de código gravimétrico pela tela de Manutenção (material + cor +
  // fornecedor → código). Grava no mesmo lugar que a tela de Recebimento lê.
  if (pathname === '/catalogo-mp/codigo' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const matKey = String(body.matKey || '').trim().toUpperCase();
    const cor    = (body.cor    === null || body.cor    === undefined || body.cor    === '') ? null : String(body.cor).trim();
    const forn   = (body.forn   === null || body.forn   === undefined || body.forn   === '') ? null : String(body.forn).trim();
    const codigo = String(body.codigo || '').trim().toUpperCase();
    const cat = lerCatalogoMP();

    if (!cat.materiais[matKey]) return jsonErr(res, 400, `Material desconhecido: ${matKey || '(vazio)'}`);
    if (!/^[A-Z0-9]{1,10}$/.test(codigo)) return jsonErr(res, 400, 'O código deve ter de 1 a 10 letras ou números, sem espaços.');
    const coresMat = Array.isArray(cat.materiais[matKey].cores) ? cat.materiais[matKey].cores : [];
    if (coresMat.length > 0) {
      if (!cor) return jsonErr(res, 400, 'Selecione a cor.');
      if (!coresMat.includes(cor)) return jsonErr(res, 400, `Cor inválida para ${matKey}: ${cor}`);
    } else if (cor) {
      return jsonErr(res, 400, `${matKey} não usa cor.`);
    }
    const fornsMat = Array.isArray(cat.fornecedores[matKey]) ? cat.fornecedores[matKey] : [];
    if (forn && !fornsMat.includes(forn)) return jsonErr(res, 400, `Fornecedor não cadastrado em ${matKey}: ${forn}`);

    const codigos = cat.codigos;
    const mesmaComb = c => c.matKey === matKey && (c.cor || null) === cor && (c.forn || null) === forn;
    // Aviso (não bloqueia): mesmo código já usado por outra combinação.
    const conflitos = codigos.filter(c => c.codigo === codigo && !mesmaComb(c))
      .map(c => ({ matKey: c.matKey, cor: c.cor, forn: c.forn }));

    const idx = codigos.findIndex(mesmaComb);
    const anterior = idx >= 0 ? codigos[idx].codigo : null;
    if (idx >= 0) {
      codigos[idx] = { matKey, cor, forn, codigo };
    } else if (forn) {
      // A busca no cliente devolve o 1º match e uma entrada com forn=null vale
      // para qualquer fornecedor — então a específica precisa vir ANTES dela.
      const iCoringa = codigos.findIndex(c => c.matKey === matKey && (c.cor || null) === cor && (c.forn || null) === null);
      if (iCoringa >= 0) codigos.splice(iCoringa, 0, { matKey, cor, forn, codigo });
      else codigos.push({ matKey, cor, forn, codigo });
    } else {
      codigos.push({ matKey, cor, forn, codigo });
    }
    dbStmts.configSet.run('mp_codigos_gravimetricos', JSON.stringify(codigos));
    logI('db', `Código gravimétrico ${anterior ? 'atualizado' : 'cadastrado'}: ${matKey}/${cor || '-'}/${forn || 'todos'} = ${codigo}${anterior ? ` (era ${anterior})` : ''}`);
    return jsonOk(res, { salvo: true, atualizado: idx >= 0, anterior, conflitos, codigos });
  }

  if (pathname === '/catalogo-mp/codigo/remover' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const matKey = String(body.matKey || '').trim().toUpperCase();
    const cor    = (body.cor  === null || body.cor  === undefined || body.cor  === '') ? null : String(body.cor).trim();
    const forn   = (body.forn === null || body.forn === undefined || body.forn === '') ? null : String(body.forn).trim();
    const cat = lerCatalogoMP();
    const codigos = cat.codigos;
    const idx = codigos.findIndex(c => c.matKey === matKey && (c.cor || null) === cor && (c.forn || null) === forn);
    if (idx < 0) return jsonErr(res, 404, 'Combinação não encontrada.');
    const removido = codigos[idx].codigo;
    codigos.splice(idx, 1);
    dbStmts.configSet.run('mp_codigos_gravimetricos', JSON.stringify(codigos));
    logI('db', `Código gravimétrico removido: ${matKey}/${cor || '-'}/${forn || 'todos'} (era ${removido})`);
    return jsonOk(res, { removido: true, codigo: removido, codigos });
  }

  return NAO_TRATADA;
}

module.exports = rotasCatalogoMp;
