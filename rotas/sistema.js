// ════════════════════════════════════════════════════════════════════
//  ROTAS — sistema: saúde, Bling, encerrar/atualizar, senha, balança,
//   impressora, colaboradores e config
// ════════════════════════════════════════════════════════════════════

const fs     = require('fs');
const path   = require('path');
const crypto = require('node:crypto');
const { spawn } = require('child_process');

const { PRINTER_NAMES, RAIZ, SERIAL_BAUD, SERIAL_PORT, VERSION } = require('../lib/config');
const { commitAtual, estadoInicioAutomatico, hashSenha, logDesvio, logE, logI, logW } = require('../lib/log');
const { configGet, configSet, db, getProximoSeq } = require('../lib/db');
const { balanca, balancaRecebendo } = require('../lib/balanca');
const { blingHostApi, blingHostOauth, CLIENT_ID, tk } = require('../lib/bling');
const {
  detectarImpressora, PRINT_SIMULAR_ENV, RESUMO_AUTO_PADRAO, RESUMO_DIA_TIPOS,
} = require('../lib/impressao');
const { jsonErr, jsonOk, lerBodyJson, NAO_TRATADA } = require('../lib/http');
const { avaliarJanelaAtualizacao } = require('../lib/atualizacao');
const blingMod = require('../lib/bling');   // variaveis que mudam de valor: ler sempre por aqui
const impressaoMod = require('../lib/impressao');   // variaveis que mudam de valor: ler sempre por aqui

// Devolve NAO_TRATADA quando nenhuma rota daqui atende o pedido.
async function rotasSistema(req, res, parsed, pathname) {
  let m;

  if (pathname === '/healthcheck' || pathname === '/status') {
    const counts = {
      etiquetas: db.prepare('SELECT COUNT(*) AS n FROM etiquetas').get().n,
      sessoes:   db.prepare('SELECT COUNT(*) AS n FROM sessoes').get().n,
      pendentes_bling: db.prepare(`SELECT COUNT(*) AS n FROM sessoes WHERE bling_status IN ('pendente','pendente_config','erro')`).get().n,
    };
    return jsonOk(res, {
      servidor: 'online',
      versao: VERSION,
      commit: commitAtual(),
      inicio_automatico: estadoInicioAutomatico(),
      impressora: impressaoMod.PRINTER_DETECTADA ? impressaoMod.PRINTER_ATIVA : null,    // A6: null se não detectada
      impressora_detectada: impressaoMod.PRINTER_DETECTADA,
      impressao_simulada: !impressaoMod.PRINTER_DETECTADA || PRINT_SIMULAR_ENV || configGet('print_simular', '0') === '1',
      impressao_simulada_forcada: PRINT_SIMULAR_ENV,   // true só em servidor de teste
      printer: impressaoMod.PRINTER_DETECTADA ? impressaoMod.PRINTER_ATIVA : null,       // alias
      // Quem imprime resumo sozinho ao finalizar, e quem acumula no dia.
      // Dá pra conferir de outra máquina se a estação está com a regra certa.
      resumo: {
        automatico: String(configGet('resumo_auto_tipos', RESUMO_AUTO_PADRAO) || '')
                      .split(',').map(x => x.trim()).filter(Boolean),
        sob_demanda: RESUMO_DIA_TIPOS,
      },
      proximoSeq: {                                       // compatibilidade com HTML antigo
        recebimento: getProximoSeq('recebimento'),
        retorno:     getProximoSeq('retorno'),
        retirada:    getProximoSeq('retirada'),
        outras:      getProximoSeq('outras'),
      },
      totalEtiquetas: counts.etiquetas,                   // alias
      balanca:   { portaAberta: balanca.portaAberta, recebendo: balancaRecebendo(), ultimoPeso: balanca.ultimoPeso, estavel: balanca.pesoEstavel, bytesTotal: balanca.bytesTotal },
      bling:     { autenticado: !!(tk.accessToken || tk.refreshToken), token_expira_em_s: tk.expiresAt ? Math.max(0, Math.round((tk.expiresAt - Date.now())/1000)) : null, simulacao: configGet('bling_simular', '1') === '1',
                   host_api: blingHostApi(), host_oauth: blingHostOauth() },
      banco:     counts,
    });
  }

  // ─── BLING: OAuth start ───
  // Bling exige o parâmetro 'state' (não pode ser vazio).
  // Guardamos o state em config pra validar quando o callback voltar.
  if (pathname === '/bling/auth/start') {
    const state = crypto.randomBytes(16).toString('hex');
    configSet('oauth_state', state);
    configSet('oauth_state_at', String(Date.now()));
    // Esta URL abre no NAVEGADOR (é a tela onde o usuário autoriza o
    // aplicativo), não é chamada de API — por isso vai no host de OAuth.
    const authUrl = `https://${blingHostOauth()}/Api/v3/oauth/authorize?response_type=code&client_id=${encodeURIComponent(CLIENT_ID)}&state=${state}`;
    logI('bling', `OAuth iniciado — state=${state.substring(0,8)}...`);
    return jsonOk(res, { authUrl, state });
  }

  // ─── BLING: status ───
  if (pathname === '/bling/status') {
    return jsonOk(res, {
      autenticado: !!(tk.accessToken || tk.refreshToken),
      expirado:    tk.expiresAt > 0 && Date.now() >= tk.expiresAt,
      temRefresh:  !!tk.refreshToken,
      tokenInvalido: blingMod._tokenInvalido,
      host_api:   blingHostApi(),
      host_oauth: blingHostOauth(),
    });
  }

  // ─── SISTEMA: encerrar o quiosque de forma limpa ───
  // POST /sistema/encerrar
  // Fecha o navegador do quiosque e encerra o próprio servidor. Cria o
  // arquivo-sinal 'eko-encerrar.flag' — o INICIAR.bat vê esse arquivo e NÃO
  // reabre (sem ele, o loop de auto-recuperação reabriria o servidor em 5s).
  // Usado pelo botão "Fechar agora" da caixa de saída: window.close() não
  // funciona em janela Chrome --app (não foi aberta por script).
  if (pathname === '/sistema/encerrar' && req.method === 'POST') {
    jsonOk(res, { encerrando: true });
    logI('sistema', 'Encerramento solicitado pela tela — fechando navegador e servidor.');
    setTimeout(() => {
      try { fs.writeFileSync(path.join(RAIZ, 'eko-encerrar.flag'), String(Date.now())); } catch (e) {}
      if (process.platform === 'win32') {
        try {
          // Fecha as janelas do navegador do quiosque (Chrome e o fallback Edge).
          spawn('taskkill', ['/IM', 'chrome.exe', '/F'], { detached: true, stdio: 'ignore' }).unref();
          spawn('taskkill', ['/IM', 'msedge.exe', '/F'], { detached: true, stdio: 'ignore' }).unref();
        } catch (e) {}
      }
      setTimeout(() => process.exit(0), 700);
    }, 200);
    return;
  }

  // ─── POST /sistema/atualizar  { senha } ───
  // Dispara, a partir de OUTRA máquina na rede, a atualização do código a
  // partir do GitHub. Quem executa o git NÃO é este processo: ele apenas
  // grava a bandeira e sai. O INICIAR.bat já é um laço supervisor que
  // reinicia o node — ele vê a bandeira, aplica o git e sobe de novo.
  // Isso evita SSH, tarefa agendada e credencial de Windows guardada.
  //
  // Travas, nesta ordem:
  //   1. senha de supervisor (a mesma da trava de saída das telas)
  //   2. janela segura — ver avaliarJanelaAtualizacao() lá em cima:
  //      nada esperando bipe, toda sessão aberta já com etiqueta viva
  //      (à prova da limpeza de startup), silêncio e nada em voo
  //   3. segunda conferência depois de uma pausa: se um comando da
  //      operação chegar nesse meio-tempo, o operador ganha
  //   4. o próprio git: merge --ff-only nunca inventa merge
  //
  //  Sessão aberta NÃO impede mais a atualização — a Extrusão roda
  //  24h e nunca teria sessão fechada. O que impede é trabalho no ar.
  // GET /sistema/janela-atualizacao — só CONSULTA, não atualiza nada.
  // Serve para saber por que a estação está recusando a atualização sem
  // precisar tentar (e sem a senha). Só lê o banco.
  if (pathname === '/sistema/janela-atualizacao' && req.method === 'GET') {
    const quieto = Math.max(10, parseInt(configGet('atualizar_silencio_s', '45'), 10) || 45);
    return jsonOk(res, { janela: avaliarJanelaAtualizacao(quieto), silencio_exigido_s: quieto });
  }

  if (pathname === '/sistema/atualizar' && req.method === 'POST') {
    let body;
    try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }

    const hashAtual = configGet('senha_saida_hash', hashSenha('1234'));
    if (hashSenha((body && body.senha) || '') !== hashAtual) {
      logDesvio({ tipo: 'tentativa_atualizacao_senha_incorreta', tela: 'remoto',
                  detalhe: 'senha incorreta em /sistema/atualizar' });
      return jsonErr(res, 401, 'Senha de supervisor incorreta.');
    }

    const QUIETO_S = Math.max(10, parseInt(configGet('atualizar_silencio_s', '45'), 10) || 45);

    const janela = avaliarJanelaAtualizacao(QUIETO_S);
    if (!janela.pode) {
      logW('sistema', `Atualização adiada: ${janela.motivo}`);
      return jsonErr(res, 409, janela.motivo, { janela, tente_de_novo: true });
    }

    // Pausa curta e segunda conferência. Se qualquer comando da
    // operação chegar aqui no meio, ele ganha: a atualização é
    // adiada e NADA acontece na estação.
    await new Promise(r => setTimeout(r, 1200));
    const confirma = avaliarJanelaAtualizacao(QUIETO_S);
    if (!confirma.pode) {
      logW('sistema', `Atualização adiada na conferência final: ${confirma.motivo}`);
      return jsonErr(res, 409,
        'Chegou operação bem na hora — atualização adiada. Nada foi alterado na estação.',
        { janela: confirma, tente_de_novo: true });
    }

    const pend = db.prepare(
      `SELECT COUNT(*) AS n FROM sessoes WHERE bling_status IN ('pendente','pendente_config','erro')`
    ).get().n;

    // Sessão aberta e VAZIA vai ser fechada pelo reinício. Não perde
    // pesagem nenhuma (não há etiqueta lá dentro), mas o operador vai
    // ter que reescolher o turno — então fica registrado quem era.
    const vaziasFechar = confirma.sessoes_vazias || [];
    if (vaziasFechar.length) {
      logW('sistema', `Atualização vai fechar ${vaziasFechar.length} sessão(ões) aberta(s) e VAZIA(s) `
        + `(nenhuma etiqueta dentro): `
        + vaziasFechar.map(s => `#${s.id} ${s.tipo}${s.turno_codigo ? ' turno ' + s.turno_codigo : ''}`
                               + `${s.operador ? ' — ' + s.operador : ''}`).join('; '));
    }

    // A bandeira é gravada ANTES de responder: se não der para
    // gravar, ninguém encerra e a estação segue exatamente como está.
    try {
      fs.writeFileSync(path.join(RAIZ, 'eko-atualizar.flag'), String(Date.now()));
    } catch (e) {
      logE('sistema', 'Não consegui gravar eko-atualizar.flag — atualização cancelada', { erro: e.message });
      return jsonErr(res, 500, 'Não consegui gravar a bandeira de atualização. Nada foi alterado.');
    }

    jsonOk(res, {
      atualizando: true,
      versao_atual: VERSION,
      commit_atual: commitAtual(),
      pendentes_bling: pend,
      parado_s: confirma.parado_s,
      sessoes_abertas: confirma.abertas.length,
      sessoes_preservadas: confirma.abertas
        .filter(s => !vaziasFechar.some(v => v.id === s.id))
        .map(s => ({ id: s.id, tipo: s.tipo, turno_codigo: s.turno_codigo, operador: s.operador })),
      sessoes_vazias_fechadas: vaziasFechar.map(s => ({
        id: s.id, tipo: s.tipo, turno_codigo: s.turno_codigo, operador: s.operador,
      })),
      aviso: 'O servidor vai encerrar e voltar em alguns segundos. As sessões abertas continuam abertas, com tudo que já foi bipado.'
           + (vaziasFechar.length
               ? ` ATENÇÃO: ${vaziasFechar.length} sessão(ões) estava(m) VAZIA(s) e será(ão) fechada(s) — nenhuma pesagem se perde, mas o operador precisa reabrir o turno.`
               : ''),
    });
    logI('sistema', `Atualização remota autorizada — ${confirma.abertas.length} sessão(ões) aberta(s) preservada(s); estação parada há ${confirma.parado_s}s.`);
    setTimeout(() => process.exit(0), 400);
    return;
  }

  // ─── SEGURANÇA: trava de saída por senha de supervisor ───
  // POST /seguranca/validar-saida { senha, tela }
  // Valida a senha numérica. Se correta → {ok:true}. Se incorreta →
  // registra a tentativa no log de desvios (com tela e hora) → {ok:false}.
  if (pathname === '/seguranca/validar-saida' && req.method === 'POST') {
    let body;
    try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const tela = body.tela || 'desconhecida';
    const hashAtual = configGet('senha_saida_hash', hashSenha('1234'));   // default inicial: 1234
    if (hashSenha(body.senha || '') === hashAtual) {
      logI('seguranca', `Saída autorizada em ${tela}`);
      return jsonOk(res, { ok: true });
    }
    logDesvio({ tipo: 'tentativa_saida_senha_incorreta', tela, detalhe: 'senha de saída incorreta' });
    return jsonOk(res, { ok: false });
  }

  // POST /seguranca/definir-senha { senhaAtual, novaSenha }
  // Troca a senha de saída. Exige a senha atual (default inicial: 1234).
  if (pathname === '/seguranca/definir-senha' && req.method === 'POST') {
    let body;
    try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const hashAtual = configGet('senha_saida_hash', hashSenha('1234'));
    if (hashSenha(body.senhaAtual || '') !== hashAtual) {
      logDesvio({ tipo: 'troca_senha_negada', tela: 'config', detalhe: 'senha atual incorreta' });
      return jsonErr(res, 403, 'Senha atual incorreta');
    }
    const nova = String(body.novaSenha || '');
    if (!/^\d{4,8}$/.test(nova)) return jsonErr(res, 400, 'A nova senha deve ter de 4 a 8 dígitos');
    configSet('senha_saida_hash', hashSenha(nova));
    logI('seguranca', 'Senha de saída alterada');
    return jsonOk(res, { ok: true });
  }

  // ─── BALANÇA ───
  // GET /balanca/portas — lista as portas COM disponíveis no sistema.
  // Útil pra descobrir em qual porta a balança está ligada (ex: ao mudar
  // de máquina). Mostra qual é a porta atualmente configurada (SERIAL_PORT).
  if (pathname === '/balanca/portas' && req.method === 'GET') {
    let SerialPort;
    try { ({ SerialPort } = require('serialport')); }
    catch(e) { return jsonErr(res, 500, 'Módulo serialport indisponível'); }
    try {
      const lista = await SerialPort.list();
      const portas = lista.map(p => ({
        porta: p.path,
        fabricante: p.manufacturer || null,
        numeroSerie: p.serialNumber || null,
        pnpId: p.pnpId || null,
        configurada: p.path === SERIAL_PORT,
      }));
      return jsonOk(res, { porta_configurada: SERIAL_PORT, baud: SERIAL_BAUD, portas });
    } catch(e) {
      return jsonErr(res, 500, 'Falha ao listar portas: ' + e.message);
    }
  }
  if (pathname === '/balanca/raw' && req.method === 'GET') {
    return jsonOk(res, {
      raw: balanca.ultimoRaw, peso: balanca.ultimoPeso, porta: SERIAL_PORT,
      portaAberta: balanca.portaAberta, recebendo: balancaRecebendo(), pesoEstavel: balanca.pesoEstavel,
      bytesTotal: balanca.bytesTotal, ultimoByteTs: balanca.ultimoByteTs,
    });
  }
  if (pathname === '/balanca/peso' && req.method === 'GET') {
    return jsonOk(res, { peso: balanca.ultimoPeso, estavel: balanca.pesoEstavel, portaAberta: balanca.portaAberta });
  }

  if (pathname === '/impressora/redetectar' && req.method === 'POST') {
    return detectarImpressora((match, installed) => {
      if (match) { impressaoMod.PRINTER_ATIVA = match; impressaoMod.PRINTER_DETECTADA = true; logI('print', `Re-detecção: ATIVA = ${impressaoMod.PRINTER_ATIVA}`); jsonOk(res, { printer: impressaoMod.PRINTER_ATIVA, installed }); }
      else jsonErr(res, 404, 'Nenhuma impressora conhecida encontrada', { candidates: PRINTER_NAMES, installed });
    });
  }

  // ─── ETIQUETAS ───
  // GET /proximo-seq?tipo=recebimento|retorno|retirada
  if (pathname === '/proximo-seq' && req.method === 'GET') {
    const tipo = parsed.query.tipo;
    if (!['recebimento','retorno','retirada'].includes(tipo)) return jsonErr(res, 400, 'tipo inválido');
    return jsonOk(res, { tipo, seq: getProximoSeq(tipo) });
  }

  // ─── CONFIG (mapa de fornecedores → ID Bling, etc) ───
  // ══════════════════════════════════════════════════════════════
  //  INVENTÁRIO (leitura por celular) — só leitura/consulta, não cria
  //  nem baixa etiqueta. Compara a soma das etiquetas bipadas com o
  //  saldo do Bling, por produto (material+cor+fornecedor).
  // ══════════════════════════════════════════════════════════════

  // Lista os produtos disponíveis para inventariar (a partir do mapa de
  // produtos do Bling, só os materiais de MP conhecidos).
  // Baixa o certificado do servidor para instalar como confiável no celular.
  // No iPhone, o Safari BLOQUEIA a câmera em sites cujo certificado não é
  // confiável — instalar e confiar neste arquivo resolve.
  if (pathname === '/cert-ekoplastic.pem' && req.method === 'GET') {
    try {
      const certPath = path.join(RAIZ, 'cert', 'cert.pem');
      if (!fs.existsSync(certPath)) return jsonErr(res, 404, 'Certificado ainda não foi gerado (o HTTPS precisa ter subido pelo menos uma vez).');
      const buf = fs.readFileSync(certPath);
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert',
        'Content-Disposition': 'attachment; filename="ekoplastic.pem"',
        'Content-Length': buf.length,
      });
      return res.end(buf);
    } catch(e) { return jsonErr(res, 500, 'Erro ao ler o certificado: ' + e.message); }
  }

  if (pathname === '/colaboradores' && req.method === 'GET') {
    let lista = [];
    try { lista = JSON.parse(configGet('colaboradores', '[]')); } catch(e) {}
    return jsonOk(res, { colaboradores: lista.map(c => ({
      id: c.id, nome: c.nome, telas: c.telas || [], ativo: c.ativo !== false,
    })) });
  }

  // Cadastra ou atualiza um colaborador (usado pela tela de Manutenção).
  if (pathname === '/colaboradores/salvar' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const nome = String(body.nome || '').trim();
    const pin  = String(body.pin || '').trim();
    const telas = Array.isArray(body.telas) ? body.telas.filter(t => ['mp','pa','bobinas'].includes(t)) : [];
    if (!nome) return jsonErr(res, 400, 'Nome obrigatório');
    if (!telas.length) return jsonErr(res, 400, 'Selecione ao menos uma tela');
    let lista = [];
    try { lista = JSON.parse(configGet('colaboradores', '[]')); } catch(e) {}
    const id = body.id || ('C' + Date.now());
    const idx = lista.findIndex(c => c.id === id);
    if (idx < 0 && !pin) return jsonErr(res, 400, 'PIN obrigatório no cadastro');
    if (pin && !/^\d{4,8}$/.test(pin)) return jsonErr(res, 400, 'O PIN deve ter de 4 a 8 números');
    // PIN não pode repetir (senão a entrada ficaria ambígua)
    if (pin) {
      const h = hashSenha(pin);
      if (lista.some(c => c.id !== id && c.pin_hash === h)) return jsonErr(res, 400, 'Este PIN já está em uso por outro colaborador');
    }
    const reg = {
      id, nome, telas, ativo: body.ativo !== false,
      pin_hash: pin ? hashSenha(pin) : (idx >= 0 ? lista[idx].pin_hash : null),
    };
    if (idx >= 0) lista[idx] = reg; else lista.push(reg);
    configSet('colaboradores', JSON.stringify(lista));
    logI('acesso', `Colaborador ${idx >= 0 ? 'atualizado' : 'cadastrado'}: ${nome} (${telas.join(', ')})`);
    return jsonOk(res, { salvo: true, id });
  }

  if (pathname === '/colaboradores/remover' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    let lista = [];
    try { lista = JSON.parse(configGet('colaboradores', '[]')); } catch(e) {}
    const antes = lista.length;
    const alvo = lista.find(c => c.id === body.id);
    lista = lista.filter(c => c.id !== body.id);
    configSet('colaboradores', JSON.stringify(lista));
    if (alvo) logI('acesso', `Colaborador removido: ${alvo.nome}`);
    return jsonOk(res, { removidos: antes - lista.length });
  }

  // Entrada na tela: valida o PIN e devolve o nome do responsável.
  if (pathname === '/colaboradores/entrar' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    const pin  = String(body.pin || '').trim();
    const tela = String(body.tela || '').trim();
    let lista = [];
    try { lista = JSON.parse(configGet('colaboradores', '[]')); } catch(e) {}
    if (!lista.length) return jsonErr(res, 503, 'Nenhum colaborador cadastrado. Peça à manutenção para cadastrar.', { sem_cadastro: true });
    const h = hashSenha(pin);
    const c = lista.find(x => x.pin_hash === h && x.ativo !== false);
    if (!c) {
      logDesvio({ tipo: 'pin_incorreto', tela, detalhe: 'PIN não confere' });
      return jsonErr(res, 401, 'Senha não confere');
    }
    if (tela && !(c.telas || []).includes(tela)) {
      logDesvio({ tipo: 'pin_sem_permissao', tela, detalhe: `${c.nome} não tem acesso a ${tela}` });
      return jsonErr(res, 403, `${c.nome}, você não tem acesso a esta tela`);
    }
    logI('acesso', `${c.nome} entrou em ${tela || '?'}`);
    return jsonOk(res, { id: c.id, nome: c.nome, telas: c.telas || [] });
  }
  if (pathname === '/config' && req.method === 'GET') {
    const all = db.prepare('SELECT chave, valor FROM config').all();
    const obj = {};
    for (const r of all) obj[r.chave] = r.valor;
    return jsonOk(res, { config: obj });
  }
  if (pathname === '/config' && req.method === 'POST') {
    let body; try { body = await lerBodyJson(req); } catch(e) { return jsonErr(res, 400, e.message); }
    for (const [k,v] of Object.entries(body)) configSet(k, typeof v === 'string' ? v : JSON.stringify(v));
    logI('config', `Atualizado: ${Object.keys(body).join(', ')}`);
    return jsonOk(res, {});
  }

  return NAO_TRATADA;
}

module.exports = rotasSistema;
