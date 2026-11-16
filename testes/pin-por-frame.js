// ════════════════════════════════════════════════════════════════════
//  SENHA POR FRAME NA MATÉRIA-PRIMA + "FECHAR AGORA" — Ekoplastic (11/11/2026)
//  Gustavo: "as telas retirada, entrada e retorno têm que ter senha nos
//  frames; pra entrar na função não precisa; a senha vale até a pessoa
//  encerrar (a pesagem, a retirada ou o retorno); quando encerrar, pede
//  senha novamente". E em 11/11 08h14 o "Fechar agora" desligou o servidor
//  da pesagem por 31 min.
//
//   A) acesso-colaborador.js REAL rodando em dois frames que dividem o mesmo
//      sessionStorage (como no navegador): a senha dada na Retirada NÃO
//      libera o Retorno nem o Recebimento.
//   B) Dentro do mesmo frame a senha vale (recarregar o frame não pede de novo).
//   C) encerrar(chave) apaga a liberação daquele frame e mostra o teclado de
//      novo; os outros frames continuam como estavam.
//   D) Telas (estático): cada frame usa a sua chave; finalizar/cancelar
//      chamam encerrouProcesso(); entrar na Matéria-Prima não pede senha.
//   E) POST /sistema/encerrar fecha só a tela: o servidor segue respondendo
//      e não grava eko-encerrar.flag (o INICIAR.bat não religaria).
//
//   F) (16/11) continuou a sessão de OUTRA pessoa, saiu e voltou: enquanto
//      aquela sessão segue aberta, não pede a senha nem pergunta de novo.
//   G/H/I) (16/11) achados das três revisões: frame vivo, caixa sem resposta,
//      teto, foco, película, confirmação, conferência adiada, senha sem
//      resposta, validade da caixa. E2) 409 do servidor real × texto da tela.
//
//  Como rodar:   node testes/pin-por-frame.js
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
const vm   = require('node:vm');

const ROOT     = path.join(__dirname, '..');
const SERVER   = path.join(ROOT, 'server.js');
const PUBLIC   = path.join(ROOT, 'public');
const PORT     = 13965;
const PORT_CB  = 18965;
const BASE     = `http://localhost:${PORT}`;
const CARIMBO  = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_pinframe_${CARIMBO}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_pinframe_logs_${CARIMBO}`);
const FLAG     = path.join(ROOT, 'eko-encerrar.flag');

let servidor;
let passou = 0, falhou = 0;
const falhas = [];

function ok(cond, nome, detalhe = '') {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else      { falhou++; falhas.push(nome); console.log(`  \x1b[31m✗ ${nome}\x1b[0m ${detalhe}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── navegador mínimo: o bastante para o acesso-colaborador.js ───
function novoStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    chaves: () => [...m.keys()],
  };
}
function novoElemento(tag, doc) {
  const el = {
    tagName: String(tag).toUpperCase(), id: '', className: '', textContent: '', style: {},
    children: [], parent: null, onclick: null, _sel: {},
    set innerHTML(v) { this._html = v; this._sel = {}; },
    get isConnected() { let e = this; while (e.parent) e = e.parent; return e === doc.body || e === doc.head; },
    get innerHTML() { return this._html || ''; },
    appendChild(c) { c.parent = this; this.children.push(c); if (c.id) doc._ids[c.id] = c; return c; },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(x => x !== this);
      if (this.id && doc._ids[this.id] === this) delete doc._ids[this.id];
      this.parent = null;
    },
    // Os filhos do innerHTML viram elementos sob demanda, um por seletor.
    querySelector(sel) {
      if (!this._sel[sel]) {
        const filho = novoElemento('div', doc);
        if (sel.startsWith('#')) filho.id = sel.slice(1);
        this._sel[sel] = filho;
      }
      return this._sel[sel];
    },
  };
  return el;
}
function novoFrame(sessionStorage, fetchFalso, extras) {
  const doc = {
    _ids: {}, _ouvintes: [], readyState: 'complete',
    getElementById(id) { return this._ids[id] || null; },
    createElement(tag) { return novoElemento(tag, doc); },
    addEventListener(tipo, fn) { if (tipo === 'keydown') this._ouvintes.push(fn); },
    removeEventListener(tipo, fn) { this._ouvintes = this._ouvintes.filter(f => f !== fn); },
  };
  doc.head = novoElemento('head', doc);
  doc.body = novoElemento('body', doc);
  const win = { document: doc, sessionStorage, fetch: fetchFalso, console, setTimeout, clearTimeout, Date, JSON, Promise, ...(extras || {}) };
  win.window = win;
  vm.createContext(win);
  vm.runInContext(fs.readFileSync(path.join(PUBLIC, 'acesso-colaborador.js'), 'utf8'), win, { filename: 'acesso-colaborador.js' });
  return {
    win, doc,
    teclado: () => !!doc.getElementById('eko-acesso'),
    digitar(txt) { for (const ch of txt) for (const f of [...doc._ouvintes]) f({ key: ch }); },
    entrar() { for (const f of [...doc._ouvintes]) f({ key: 'Enter' }); },
  };
}

async function testeFrames() {
  console.log('\n[A-C] senha por frame (acesso-colaborador.js real, sessionStorage compartilhado)');
  const ss = novoStorage();   // mesma origem: os 3 iframes da MP dividem este storage
  const pedidos = [];
  const fetchFalso = async (url, o) => {
    const corpo = JSON.parse(o.body);
    pedidos.push({ url, corpo });
    const nome = corpo.pin === '1111' ? 'ANA' : corpo.pin === '2222' ? 'BRUNO' : null;
    return { ok: !!nome, json: async () => (nome ? { ok: true, nome, id: nome.length } : { ok: false, erro: 'Senha não confere' }) };
  };

  // Frame da Retirada: pede a senha, Ana entra.
  const ret = novoFrame(ss, fetchFalso);
  const entrouRet = [];
  ret.win.EkoAcesso.exigir('mp', nome => entrouRet.push(nome), { chave: 'mp-retirada', nomeTela: 'Retirada de MP' });
  ok(ret.teclado(), 'Retirada: abre o teclado de senha');
  ret.digitar('1111'); ret.entrar();
  await sleep(600);
  ok(entrouRet.join() === 'ANA', 'Retirada: Ana entra com a senha dela', `(entrou: ${JSON.stringify(entrouRet)})`);
  ok(!ret.teclado(), 'Retirada: teclado some depois de entrar');
  ok(pedidos.length === 1 && pedidos[0].corpo.tela === 'mp', 'servidor confere a permissão da tela "mp" (não a chave do frame)',
     `(pedidos: ${JSON.stringify(pedidos.map(p => p.corpo.tela))})`);

  // Frame do Retorno (mesmo storage): NÃO pode entrar no nome da Ana.
  const rtn = novoFrame(ss, fetchFalso);
  const entrouRtn = [];
  rtn.win.EkoAcesso.exigir('mp', nome => entrouRtn.push(nome), { chave: 'mp-retorno', nomeTela: 'Retorno de MP' });
  ok(entrouRtn.length === 0, 'Retorno: a senha da Retirada NÃO libera o Retorno', `(entrou: ${JSON.stringify(entrouRtn)})`);
  ok(rtn.teclado(), 'Retorno: pede a senha');

  const rec = novoFrame(ss, fetchFalso);
  const entrouRec = [];
  rec.win.EkoAcesso.exigir('mp', nome => entrouRec.push(nome), { chave: 'mp-recebimento', nomeTela: 'Recebimento de MP' });
  ok(entrouRec.length === 0 && rec.teclado(), 'Recebimento: a senha da Retirada NÃO libera o Recebimento');

  // Bruno entra no Retorno: cada frame no nome de quem digitou.
  rtn.digitar('2222'); rtn.entrar();
  await sleep(600);
  ok(entrouRtn.join() === 'BRUNO', 'Retorno: Bruno entra com a senha dele');

  // B) Mesmo frame recarregado (saiu para a Extrusão e voltou): a senha vale
  //    enquanto houver processo aberto no nome dela (a tela confere no servidor).
  let abertaDe = 'ANA';
  const aindaValida = async lib => lib.nome === abertaDe;
  const ret2 = novoFrame(ss, fetchFalso);
  const entrouRet2 = [];
  ret2.win.EkoAcesso.exigir('mp', nome => entrouRet2.push(nome), { chave: 'mp-retirada', aindaValida });
  await sleep(50);
  ok(entrouRet2.join() === 'ANA' && !ret2.teclado(), 'Retirada recarregada COM retirada aberta da Ana: segue no nome dela sem pedir a senha',
     `(entrou: ${JSON.stringify(entrouRet2)})`);

  // B2) Ana entrou e saiu sem fazer nada: quem chega depois NÃO entra no nome dela.
  abertaDe = null;
  const ret2b = novoFrame(ss, fetchFalso);
  const entrouRet2b = [];
  ret2b.win.EkoAcesso.exigir('mp', nome => entrouRet2b.push(nome), { chave: 'mp-retirada', aindaValida });
  await sleep(50);
  ok(entrouRet2b.length === 0 && ret2b.teclado(), 'Retirada recarregada SEM processo aberto: pede a senha de novo',
     `(entrou: ${JSON.stringify(entrouRet2b)})`);
  ok(!ret2b.win.EkoAcesso.liberado('mp-retirada'), 'sem processo aberto: a liberação guardada é apagada');

  // B3) A conferência falhou (servidor fora): pede a senha, não segue no nome guardado.
  ss.setItem('eko_liberado_mp-retorno', JSON.stringify({ nome: 'BRUNO', id: 5, ts: Date.now() }));
  const rtnFalha = novoFrame(ss, fetchFalso);
  const entrouFalha = [];
  rtnFalha.win.EkoAcesso.exigir('mp', nome => entrouFalha.push(nome), { chave: 'mp-retorno', aindaValida: async () => { throw new Error('fora'); } });
  await sleep(50);
  ok(entrouFalha.length === 0 && rtnFalha.teclado(), 'conferência falhou: pede a senha');
  rtnFalha.digitar('2222'); rtnFalha.entrar();
  await sleep(600);
  ok(entrouFalha.join() === 'BRUNO', 'Retorno: Bruno entra de novo com a senha');

  // Leitor com o teclado na tela: o bipe não vira senha nem gasta tentativa.
  const nPedidos = pedidos.length;
  ok(ret2b.win.EkoAcesso.bloqueando(), 'teclado na tela: a tela sabe que está bloqueada (leitor não dá baixa)');
  ret2b.digitar('R0001234'); ret2b.entrar();
  await sleep(100);
  ok(pedidos.length === nPedidos, 'bipe com o teclado aberto não é mandado como senha', `(pedidos: ${pedidos.length - nPedidos})`);
  ok(/bipe/i.test(ret2b.doc.getElementById('eko-acesso').querySelector('#eko-msg').textContent), 'avisa que foi um bipe');
  ret2b.digitar('1111'); ret2b.entrar();
  await sleep(600);
  ok(entrouRet2b.join() === 'ANA' && !ret2b.win.EkoAcesso.bloqueando(), 'depois do bipe, a senha digitada funciona e a tela desbloqueia');
  abertaDe = 'ANA';

  // Enquanto a tela confere no servidor se a senha guardada vale, não se sabe
  // quem está ali: o leitor fica bloqueado (bipe abriria sessão sem nome).
  let soltar;
  const lenta = novoFrame(ss, fetchFalso);
  lenta.win.EkoAcesso.exigir('mp', () => {}, { chave: 'mp-retirada', aindaValida: () => new Promise(r => { soltar = r; }) });
  await sleep(20);
  ok(lenta.win.EkoAcesso.bloqueando() && !lenta.teclado(), 'conferindo a senha guardada: leitor bloqueado');
  soltar(true); await sleep(20);
  ok(!lenta.win.EkoAcesso.bloqueando(), 'conferência terminou: leitor liberado');

  // C) Ana encerra a retirada: o teclado volta só ali.
  const antes = entrouRet.length;
  ret.win.EkoAcesso.encerrar('mp-retirada');
  ok(ret.teclado(), 'encerrar: o teclado volta na Retirada');
  ok(!ret.win.EkoAcesso.liberado('mp-retirada'), 'encerrar: a liberação da Retirada foi apagada');
  ok(rtn.win.EkoAcesso.liberado('mp-retorno'), 'encerrar a Retirada não derruba o Retorno do Bruno');
  ret.win.EkoAcesso.encerrar('mp-retirada');   // clique duplo
  ok(ret.doc.body.children.filter(c => c.id === 'eko-acesso').length === 1, 'encerrar duas vezes não abre dois teclados');
  const nAntesTroca = pedidos.length;
  ret.digitar('2222'); ret.entrar();
  await sleep(600);
  ok(pedidos.length === nAntesTroca + 1, 'depois de encerrar, a senha vai UMA vez ao servidor', `(foram ${pedidos.length - nAntesTroca})`);
  ok(entrouRet.length === antes + 1 && entrouRet[entrouRet.length - 1] === 'BRUNO',
     'depois de encerrar, a próxima retirada entra no nome de quem digitou (Bruno)', `(entrou: ${JSON.stringify(entrouRet)})`);

  const ret3 = novoFrame(ss, fetchFalso);
  const entrouRet3 = [];
  abertaDe = 'BRUNO';
  ret3.win.EkoAcesso.exigir('mp', nome => entrouRet3.push(nome), { chave: 'mp-retirada', aindaValida });
  await sleep(50);
  ok(entrouRet3.join() === 'BRUNO', 'Retirada recarregada depois da troca: nome do Bruno, não da Ana');

  // Caixa "sessão de outro": nome escapado e aviso de encerrar recusado.
  const cx = novoFrame(ss, fetchFalso);
  const escolha = cx.win.EkoAcesso.perguntarSessaoDeOutro({ processo: 'Retirada', operador: '<img src=x onerror=alert(1)>', itens: 2, aviso: 'Não deu <b>' });
  const ov = cx.doc.getElementById('eko-outro');
  ok(ov && !/<img/.test(ov.innerHTML) && /&lt;img/.test(ov.innerHTML), 'caixa "sessão de outro": nome do operador escapado');
  ok(ov && /Não deu &lt;b&gt;/.test(ov.innerHTML), 'caixa "sessão de outro": mostra o aviso (escapado)');
  ok(cx.win.EkoAcesso.bloqueando(), 'caixa "sessão de outro" na tela: bloqueia o leitor');
  ov.querySelector('#eko-outro-continuar').onclick();
  ok((await escolha) === 'continuar' && !cx.win.EkoAcesso.bloqueando(), 'continuar: fecha a caixa e libera o leitor');

  // Telas sem chave (PA, Resíduos) seguem como antes: chave = tela.
  const pa = novoFrame(ss, fetchFalso);
  pa.win.EkoAcesso.exigir('pa', () => {});
  ok(pa.teclado(), 'PA sem chave: a liberação das abas da MP não vale para o PA');
}

// ─── F) continuar a sessão de OUTRA pessoa, sair e voltar (16/11/2026) ───
// Gustavo: "saiu voltou mas é a mesma operação segue no nome de quem tava".
// Roda as funções REAIS da tela (tiradas do HTML) junto do acesso-colaborador.js
// real: Ana entra, acha a sessão do Bruno, escolhe continuar, sai e volta.
function extrairFuncao(src, nome) {
  const m = new RegExp('(async\\s+)?function\\s+' + nome + '\\s*\\(').exec(src);
  if (!m) throw new Error('função ' + nome + ' não achada na tela');
  let i = src.indexOf('{', src.indexOf(')', m.index)), prof = 0;
  for (let j = i; j < src.length; j++) {
    if (src[j] === '{') prof++;
    else if (src[j] === '}' && --prof === 0) return src.slice(m.index, j + 1);
  }
  throw new Error('função ' + nome + ' sem fim');
}
// Só as funções que existem na tela (roda também contra o código antigo, para
// ver o teste vermelho sem a correção).
function presentes(src, nomes) {
  return nomes.filter(n => new RegExp('function\\s+' + n + '\\s*\\(').test(src));
}
// Funções do Recebimento/Retorno usadas pela pergunta "sessão de outro".
const FNS_RECEB_OUTRO = ['listaDoFrame', 'textoEncerrarDeOutro', 'motivoNaoEncerrarDeOutro', 'conferirSessaoDeOutro'];

async function testeContinuada(cfg) {
  const html = fs.readFileSync(path.join(PUBLIC, cfg.arquivo), 'utf8');
  const codigo = presentes(html, cfg.funcoes).map(n => extrairFuncao(html, n)).join('\n');
  const ss = novoStorage();
  let abertas = [];
  const fetchFalso = async (url, o) => {
    if (String(url).startsWith('/sessoes/abertas')) return { ok: true, json: async () => ({ ok: true, sessoes: abertas }) };
    const corpo = JSON.parse(o.body);
    const nome = corpo.pin === '1111' ? 'ANA' : null;
    return { ok: !!nome, json: async () => (nome ? { ok: true, nome, id: 3 } : { ok: false, erro: 'Senha não confere' }) };
  };
  const abrirTela = () => {
    const f = novoFrame(ss, fetchFalso);
    Object.assign(f.win, cfg.globais, {
      showToast: () => {}, finalizar: async () => {}, cancelarSessaoSeVazia: async () => {},
      restaurarSessoesAbertas: async () => {}, estado: cfg.estado(77),
    });
    vm.runInContext(codigo, f.win, { filename: cfg.arquivo });
    f.entrou = [];
    f.win.EkoAcesso.exigir('mp', nome => f.entrou.push(nome), { chave: cfg.chave, aindaValida: f.win[cfg.aberta] });
    f.caixa = () => f.doc.getElementById('eko-outro');
    // Roda conferirSessaoDeOutro; se a caixa abrir, escolhe "continuar".
    f.conferir = async () => {
      const p = f.win.conferirSessaoDeOutro();
      await sleep(20);
      const viu = !!f.caixa();
      if (viu) f.caixa().querySelector('#eko-outro-continuar').onclick();
      await p;
      return viu;
    };
    return f;
  };
  const doBruno = id => ({ id, tipo: cfg.tipo, operador: 'BRUNO', etiquetas: [{}, {}] });

  // 1) Ana entra e acha a sessão #77 do Bruno aberta: pergunta, ela continua.
  abertas = [doBruno(77)];
  const a = abrirTela();
  await sleep(50);
  ok(a.teclado(), `${cfg.nome}: Ana sem senha guardada → teclado`);
  a.digitar('1111'); a.entrar();
  await sleep(600);
  ok(a.entrou.join() === 'ANA', `${cfg.nome}: Ana entra com a senha dela`);
  ok(await a.conferir(), `${cfg.nome}: sessão do Bruno aberta → pergunta "continuar ou encerrar"`);

  // 2) Sai (Extrusão) e volta com a MESMA sessão aberta: sem senha, sem pergunta.
  const b = abrirTela();
  await sleep(50);
  ok(b.entrou.join() === 'ANA' && !b.teclado(),
     `${cfg.nome}: continuou a sessão do Bruno, saiu e voltou → NÃO pede a senha de novo`, `(entrou: ${JSON.stringify(b.entrou)}, teclado: ${b.teclado()})`);
  if (!b.teclado()) ok(!(await b.conferir()), `${cfg.nome}: e NÃO pergunta de novo "continuar ou encerrar" para a mesma sessão`);
  else ok(false, `${cfg.nome}: e NÃO pergunta de novo "continuar ou encerrar" para a mesma sessão`, '(nem entrou)');

  // 3) A sessão do Bruno foi encerrada: volta a regra normal (pede a senha).
  abertas = [];
  const c = abrirTela();
  await sleep(50);
  ok(c.entrou.length === 0 && c.teclado(), `${cfg.nome}: sessão continuada encerrada → pede a senha de novo`);

  // 4) Outra sessão do Bruno (não a que ela continuou): pede a senha.
  ss.setItem('eko_liberado_' + cfg.chave, JSON.stringify({ nome: 'ANA', id: 3, ts: Date.now(), continuada: '77' }));
  abertas = [doBruno(78)];
  const d = abrirTela();
  await sleep(50);
  ok(d.entrou.length === 0 && d.teclado(), `${cfg.nome}: outra sessão do Bruno (não a continuada) → pede a senha`);

  // 5) Teto de 8 h segue valendo, e encerrar/trocar apaga o "continuada".
  ss.setItem('eko_liberado_' + cfg.chave, JSON.stringify({ nome: 'ANA', id: 3, ts: Date.now() - 9 * 3600 * 1000, continuada: '77' }));
  abertas = [doBruno(77)];
  const e = abrirTela();
  await sleep(50);
  ok(e.entrou.length === 0 && e.teclado(), `${cfg.nome}: passou de 8 h → pede a senha mesmo com a sessão continuada aberta`);
  ss.setItem('eko_liberado_' + cfg.chave, JSON.stringify({ nome: 'ANA', id: 3, ts: Date.now(), continuada: '77' }));
  e.win.EkoAcesso.encerrar(cfg.chave);
  ok(e.win.EkoAcesso.continuada(cfg.chave) === null, `${cfg.nome}: encerrar apaga a sessão continuada junto com a senha`);
}

async function testeContinuadas() {
  console.log('\n[F] continuou a sessão de outro, saiu e voltou (funções reais das telas)');
  await testeContinuada({
    nome: 'Retirada', arquivo: 'mp-retirada.html', chave: 'mp-retirada', tipo: 'retirada',
    funcoes: ['escRet', 'retiradaAbertaDe', 'conferirSessaoDeOutro'], aberta: 'retiradaAbertaDe',
    globais: { CHAVE_PIN: 'mp-retirada' },
    estado: id => ({ sessaoId: id, sessaoOperador: 'BRUNO', sessaoInicio: null, itens: [1, 2] }),
  });
  for (const aba of ['recebimento', 'retorno']) {
    await testeContinuada({
      nome: aba === 'retorno' ? 'Retorno' : 'Recebimento', arquivo: 'mp-recebimento-retorno.html',
      chave: 'mp-' + aba, tipo: aba,
      funcoes: ['sessaoAbertaDe', ...FNS_RECEB_OUTRO], aberta: 'sessaoAbertaDe',
      globais: { ABA_PIN: aba, CHAVE_PIN: 'mp-' + aba },
      estado: id => ({ sessaoInfo: { [aba]: { operador: 'BRUNO', inicio: null, itens: 2 } },
                       [aba === 'retorno' ? 'sessaoRetorno' : 'sessaoRecebimento']: id }),
    });
  }
}

// ─── G) frame VIVO, leitor na restauração, confirmar encerrar (16/11/2026) ───
// Achados do revisor: F1 (trocar de aba sem recarregar mantinha a senha de quem
// não tinha processo), F2 (teto de 8 h só contava ao recarregar), F5 (bipe entre
// a senha e a caixa "sessão de outro" abria sessão nova), F6 (Gustavo: encerrar
// a sessão de outro no Recebimento/Retorno pede confirmação).
async function testeFrameVivo() {
  console.log('\n[G] frame vivo: reconferir ao voltar à aba, teto de 8 h, leitor seguro, confirmar encerrar');
  const ss = novoStorage();
  const fetchFalso = async (url, o) => {
    const corpo = JSON.parse(o.body);
    const nome = corpo.pin === '1111' ? 'ANA' : null;
    return { ok: !!nome, json: async () => (nome ? { ok: true, nome, id: 3 } : { ok: false, erro: 'Senha não confere' }) };
  };
  const api = f => f.win.EkoAcesso;
  const chama = (f, nome) => (typeof api(f)[nome] === 'function' ? api(f)[nome]() : undefined);

  // F1: Ana entra no Retorno, não faz nada, vai a outra aba e volta (frame vivo).
  let abertaDe = null;
  const aindaValida = async lib => lib.nome === abertaDe;
  const rtn = novoFrame(ss, fetchFalso);
  const entrou = [];
  api(rtn).exigir('mp', nome => entrou.push(nome), { chave: 'mp-retorno', aindaValida });
  rtn.digitar('1111'); rtn.entrar();
  await sleep(600);
  ok(entrou.join() === 'ANA' && !rtn.teclado(), 'F1: Ana entra no Retorno');
  await chama(rtn, 'reconferir'); await sleep(20);
  ok(rtn.teclado(), 'F1: sem processo no nome dela, voltar à aba (sem recarregar) pede a senha de novo');
  ok(!api(rtn).liberado('mp-retorno'), 'F1: e a liberação guardada é apagada');
  rtn.digitar('1111'); rtn.entrar();
  await sleep(600);
  abertaDe = 'ANA';
  await chama(rtn, 'reconferir'); await sleep(20);
  ok(!rtn.teclado(), 'F1: com processo aberto no nome dela, voltar à aba NÃO pede a senha');
  const mpHtml = fs.readFileSync(path.join(PUBLIC, 'materia-prima.html'), 'utf8');
  const ativar = extrairFuncao(mpHtml, 'ativarAba');
  ok(/EkoAcesso\.reconferir\(\)/.test(ativar), 'F1: a Matéria-Prima reconfere a senha do frame ao voltar a uma aba já carregada');

  // F2: 8 h depois do login, com o frame aberto o tempo todo.
  ss.setItem('eko_liberado_mp-retorno', JSON.stringify({ nome: 'ANA', id: 3, ts: Date.now() - 9 * 3600 * 1000 }));
  chama(rtn, 'verificarTeto');
  ok(rtn.teclado(), 'F2: passou de 8 h com o frame aberto → o relógio pede a senha (sem recarregar nem trocar de aba)');
  rtn.digitar('1111'); rtn.entrar();
  await sleep(600);
  ss.setItem('eko_liberado_mp-retorno', JSON.stringify({ nome: 'ANA', id: 3, ts: Date.now() - 9 * 3600 * 1000 }));
  await chama(rtn, 'reconferir'); await sleep(20);
  ok(rtn.teclado(), 'F2: passou de 8 h → voltar à aba pede a senha mesmo com processo aberto');

  // PA/Resíduos (sem aindaValida) não mudam: o relógio não mexe neles.
  const pa = novoFrame(ss, fetchFalso);
  api(pa).exigir('pa', () => {});
  pa.digitar('1111'); pa.entrar();
  await sleep(600);
  ss.setItem('eko_liberado_pa', JSON.stringify({ nome: 'ANA', id: 3, ts: Date.now() - 9 * 3600 * 1000 }));
  chama(pa, 'verificarTeto'); await chama(pa, 'reconferir');
  ok(!pa.teclado(), 'PA (sem conferência de processo) segue como antes: o relógio da MP não pede a senha ali');

  // F5: a tela segura o leitor até restaurar a sessão e conferir se é de outro.
  const ret = novoFrame(ss, fetchFalso);
  let soltar;
  const segura = typeof api(ret).segurar === 'function'
    ? api(ret).segurar(new Promise(r => { soltar = r; })) : null;
  ok(!!segura && api(ret).bloqueando(), 'F5: restaurando a sessão depois da senha → leitor bloqueado');
  if (soltar) { soltar(); await segura; }
  ok(!!segura && !api(ret).bloqueando(), 'F5: restauração terminou → leitor liberado');
  let soltarErro;
  const seguraErro = segura ? api(ret).segurar(new Promise((_, n) => { soltarErro = n; })) : null;
  if (soltarErro) { soltarErro(new Error('rede')); await seguraErro.catch(() => {}); }
  ok(!!seguraErro && !api(ret).bloqueando(), 'F5: restauração falhou → leitor liberado mesmo assim (não trava a tela)');
  for (const [arq, fn, restaura] of [['mp-retirada.html', 'iniciarTelaRetirada', 'restaurarSessaoAberta'],
                                     ['mp-recebimento-retorno.html', 'iniciarTelaMP', 'restaurarSessoesAbertas']]) {
    const corpo = extrairFuncao(fs.readFileSync(path.join(PUBLIC, arq), 'utf8'), fn);
    const chamadas = corpo.split(restaura + '()').length - 1;
    const seguras = (corpo.match(new RegExp('segurarLeitor\\((inicializarServidor\\(\\)[\\s\\S]*?)?' + restaura + '\\(\\)', 'g')) || []).length;
    ok(chamadas > 0 && chamadas === seguras, `F5: ${arq} restaura a sessão SEMPRE com o leitor seguro (${seguras} de ${chamadas})`);
  }

  // F6: Recebimento/Retorno — "Encerrar a de X" pede confirmação antes de ir ao Bling.
  for (const aba of ['recebimento', 'retorno']) {
    const html = fs.readFileSync(path.join(PUBLIC, 'mp-recebimento-retorno.html'), 'utf8');
    const f = novoFrame(novoStorage(), fetchFalso);
    const key = aba === 'retorno' ? 'sessaoRetorno' : 'sessaoRecebimento';
    let finalizou = 0;
    Object.assign(f.win, {
      ABA_PIN: aba, CHAVE_PIN: 'mp-' + aba, showToast: () => {},
      finalizar: async () => { finalizou++; f.win.estado[key] = null; f.win.estado.sessaoInfo = {}; return true; },
      restaurarSessoesAbertas: async () => {},
      estado: { sessaoInfo: { [aba]: { operador: 'BRUNO', inicio: null, itens: 2 } }, [key]: 77,
                itens: aba === 'recebimento' ? [{ status: 'bipada', peso: 10 }] : [],
                retItens: aba === 'retorno' ? [{ status: 'bipada', peso: 10 }] : [] },
    });
    vm.runInContext(presentes(html, FNS_RECEB_OUTRO).map(n => extrairFuncao(html, n)).join('\n'), f.win);
    f.win.EKO_RESPONSAVEL = 'ANA';
    const p = f.win.conferirSessaoDeOutro();
    await sleep(20);
    f.doc.getElementById('eko-outro').querySelector('#eko-outro-encerrar').onclick();
    await sleep(20);
    const cx = f.doc.getElementById('eko-confirma');
    ok(!!cx && finalizou === 0, `F6 ${aba}: "Encerrar a de BRUNO" pede confirmação antes de mandar ao Bling`, `(finalizou: ${finalizou})`);
    ok(api(f).bloqueando(), `F6 ${aba}: com a confirmação na tela, o leitor fica bloqueado`);
    if (cx) cx.querySelector('#eko-confirma-nao').onclick();
    await sleep(20);
    ok(finalizou === 0 && !!f.doc.getElementById('eko-outro'), `F6 ${aba}: "Voltar" não finaliza e volta à pergunta continuar/encerrar`);
    const outro = f.doc.getElementById('eko-outro');
    if (outro) outro.querySelector('#eko-outro-encerrar').onclick();
    await sleep(20);
    const cx2 = f.doc.getElementById('eko-confirma');
    if (cx2) cx2.querySelector('#eko-confirma-sim').onclick();
    await Promise.race([p, sleep(200)]);
    ok(finalizou === 1, `F6 ${aba}: confirmou → finaliza a sessão do Bruno uma vez`, `(finalizou: ${finalizou})`);
  }
}

// ─── H) 2ª revisão (16/11/2026): B1-B6 ───
// B1 caixa sem resposta deixava o próximo entrar sem senha · B2 película na
// conferência · B3 confirmação diz o que vai e o que é descartado · B4 nada
// trava o leitor (teto + caixa trocada responde) · B5 teclado tira o foco do
// campo · B6/F10 falha na consulta ≠ "não há processo"; F8 sessão sem nome.
const espera = (p, ms = 300) => Promise.race([p, sleep(ms).then(() => '__sem_resposta__')]);

async function testeSegundaRevisao() {
  console.log('\n[H] 2ª revisão: caixa sem resposta, teto, foco, falha na consulta, confirmação, película, relógio');
  const fetchFalso = async (url, o) => {
    const corpo = JSON.parse(o.body);
    const nome = corpo.pin === '1111' ? 'ANA' : corpo.pin === '2222' ? 'BRUNO' : null;
    return { ok: !!nome, json: async () => (nome ? { ok: true, nome, id: nome.length } : { ok: false, erro: 'Senha não confere' }) };
  };
  const api = f => f.win.EkoAcesso;
  const logado = async (chave, aindaValida, extras) => {
    const ss = novoStorage();
    const f = novoFrame(ss, fetchFalso, { EKO_TETO_CONFERIR_MS: 150, ...(extras || {}) });
    f.ss = ss; f.entrou = [];
    api(f).exigir('mp', nome => f.entrou.push(nome), { chave, aindaValida });
    f.digitar('1111'); f.entrar();
    await sleep(600);
    return f;
  };

  // B1: Ana entra, aparece "sessão de outro", ela vai a outra aba sem responder.
  {
    const f = await logado('mp-recebimento', async () => false);
    const escolha = api(f).perguntarSessaoDeOutro({ processo: 'Recebimento', operador: 'JOAO', itens: 2 });
    await api(f).reconferir(); await sleep(20);
    ok(f.teclado(), 'B1: caixa "sessão de outro" sem resposta + voltar à aba → pede a senha (quem volta pode ser outro)');
    ok(!f.doc.getElementById('eko-outro'), 'B1: a caixa de quem estava antes sai da tela');
    ok((await espera(escolha)) === 'cancelado', 'B1: a pergunta pendente responde "cancelado" (ninguém decide no nome da Ana)');
    ok(!api(f).liberado('mp-recebimento'), 'B1: a senha da Ana deixa de valer');
  }
  // B1 com a caixa de CONFIRMAÇÃO aberta, e pelo relógio (8 h) com caixa aberta.
  {
    const f = await logado('mp-retorno', async () => true);
    const sim = api(f).confirmar ? api(f).confirmar({ titulo: 't', texto: 'x' }) : Promise.resolve(null);
    await api(f).reconferir(); await sleep(20);
    ok(f.teclado() && (await espera(sim)) === 'cancelado', 'B1: confirmação sem resposta + voltar à aba → pede a senha e a confirmação responde "cancelado"');
  }
  {
    const f = await logado('mp-retirada', async () => true);
    const escolha = api(f).perguntarSessaoDeOutro({ processo: 'Retirada', operador: 'JOAO', itens: 1 });
    f.ss.setItem('eko_liberado_mp-retirada', JSON.stringify({ nome: 'ANA', id: 3, ts: Date.now() - 9 * 3600 * 1000 }));
    api(f).verificarTeto(); await sleep(20);
    ok(f.teclado() && !f.doc.getElementById('eko-outro') && (await espera(escolha)) === 'cancelado',
       'B1: passou de 8 h com a caixa "sessão de outro" aberta → o relógio pede a senha mesmo assim');
  }

  // B4: caixa trocada responde a velha; segurar tem teto; encerrar limpa a caixa.
  {
    const f = await logado('mp-retirada', async () => true);
    const p1 = api(f).perguntarSessaoDeOutro({ processo: 'Retirada', operador: 'JOAO', itens: 1 });
    const p2 = api(f).perguntarSessaoDeOutro({ processo: 'Retirada', operador: 'JOAO', itens: 1 });
    ok((await espera(p1)) === 'cancelado', 'B4: caixa substituída por outra responde "cancelado" (a promessa velha não fica pendurada)');
    f.doc.getElementById('eko-outro').querySelector('#eko-outro-continuar').onclick();
    ok((await espera(p2)) === 'continuar' && !api(f).bloqueando(), 'B4: a caixa nova funciona e libera o leitor');

    const nunca = api(f).segurar(new Promise(() => {}));
    ok(api(f).bloqueando(), 'B4: restauração em curso → leitor bloqueado');
    await sleep(400);
    ok(!api(f).bloqueando(), 'B4: servidor que não responde → o leitor solta no teto (não trava a fábrica)');
    nunca.catch(() => {});

    let soltar;
    const comCaixa = api(f).segurar(new Promise(r => { soltar = r; }));
    const cx = api(f).perguntarSessaoDeOutro({ processo: 'Retirada', operador: 'JOAO', itens: 1 });
    await sleep(400);
    ok(api(f).bloqueando(), 'B4: com a caixa aberta o teto espera a resposta (a caixa segura o leitor)');
    f.doc.getElementById('eko-outro').querySelector('#eko-outro-continuar').onclick();
    await cx; soltar(); await comCaixa;
    ok(!api(f).bloqueando(), 'B4: respondeu e a restauração terminou → leitor liberado');

    const pend = api(f).perguntarSessaoDeOutro({ processo: 'Retirada', operador: 'JOAO', itens: 1 });
    api(f).encerrar('mp-retirada');
    ok(f.teclado() && !f.doc.getElementById('eko-outro') && (await espera(pend)) === 'cancelado',
       'B4: encerrar com uma caixa aberta → só o teclado fica (a caixa vencida sai e responde "cancelado")');
  }

  // B5: o teclado abre com o foco num campo (ex.: peso bruto).
  {
    let blur = 0;
    const campo = { blur: () => { blur++; } };
    const f = await logado('mp-recebimento', async () => false);
    f.doc.activeElement = campo;
    await api(f).reconferir(); await sleep(20);
    ok(f.teclado() && blur === 1, 'B5: o teclado de senha tira o foco do campo onde a pessoa estava', `(blur: ${blur})`);
    let evitou = 0;
    for (const fn of [...f.doc._ouvintes]) fn({ key: '7', preventDefault: () => { evitou++; } });
    ok(evitou > 0, 'B5: o número digitado com o teclado de senha aberto não vai para o campo (preventDefault)');
  }

  // B6/F10: consulta que FALHA não é "não há processo".
  {
    let modo = 'vale', chamadas = 0;
    const aindaValida = async () => { chamadas++; if (modo === 'falha') throw new Error('fora'); return modo === 'vale'; };
    const f = await logado('mp-retorno', aindaValida);
    modo = 'falha';
    const c0 = chamadas;
    await api(f).reconferir(); await sleep(20);
    ok(!f.teclado() && api(f).liberado('mp-retorno'), 'F10: falha na consulta ao voltar à aba → mantém quem está (não pede a senha à toa)');
    modo = 'nao';
    api(f).verificarTeto(); await sleep(50);
    ok(chamadas > c0 + 1 && f.teclado(), 'F10: o relógio confere de novo depois da falha; sem processo → pede a senha', `(chamadas: ${chamadas - c0})`);
  }
  {
    // Ao abrir a tela a consulta falhou: pede a senha, mas a mesma pessoa não perde a sessão que continuava.
    const ss = novoStorage();
    ss.setItem('eko_liberado_mp-retirada', JSON.stringify({ nome: 'ANA', id: 3, ts: Date.now(), continuada: '77' }));
    const f = novoFrame(ss, fetchFalso);
    api(f).exigir('mp', () => {}, { chave: 'mp-retirada', aindaValida: async () => { throw new Error('fora'); } });
    await sleep(50);
    ok(f.teclado(), 'F10: consulta falhou ao abrir a tela → pede a senha (não se sabe quem está)');
    f.digitar('1111'); f.entrar(); await sleep(600);
    ok(api(f).continuada('mp-retirada') === '77', 'F10: a mesma pessoa digitou → segue a sessão que ela continuava (não pergunta de novo)');
    const g = novoFrame(ss, fetchFalso);
    ss.setItem('eko_liberado_mp-retorno', JSON.stringify({ nome: 'ANA', id: 3, ts: Date.now(), continuada: '88' }));
    api(g).exigir('mp', () => {}, { chave: 'mp-retorno', aindaValida: async () => { throw new Error('fora'); } });
    await sleep(50);
    g.digitar('2222'); g.entrar(); await sleep(600);
    ok(api(g).continuada('mp-retorno') === null, 'F10: OUTRA pessoa digitou → não herda a sessão continuada da Ana');
  }

  // Relógio de 1 min de verdade (o frame falso antes não tinha setInterval).
  {
    const timers = [];
    const extras = { setInterval: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearInterval: () => {} };
    const f = await logado('mp-retirada', async () => true, extras);
    api(f).exigir('mp', () => {}, { chave: 'mp-retirada', aindaValida: async () => true });
    ok(timers.length === 1 && timers[0].ms === 60 * 1000, 'relógio: liga UMA vez, de minuto em minuto, nas telas com conferência de processo', `(timers: ${JSON.stringify(timers.map(t => t.ms))})`);
    f.ss.setItem('eko_liberado_mp-retirada', JSON.stringify({ nome: 'ANA', id: 3, ts: Date.now() - 9 * 3600 * 1000 }));
    if (timers[0]) timers[0].fn();
    await sleep(20);
    ok(f.teclado(), 'relógio: o tique de 1 min pede a senha depois de 8 h');
    const t2 = [];
    const pa = novoFrame(novoStorage(), fetchFalso, { setInterval: (fn, ms) => { t2.push(ms); return 1; } });
    api(pa).exigir('pa', () => {});
    ok(t2.length === 0, 'relógio: PA (sem conferência de processo) não liga relógio nenhum');
  }

  // B2: película enquanto confere a senha guardada / restaura; sai ao abrir a caixa.
  {
    let soltar;
    const f = await logado('mp-recebimento', () => new Promise(r => { soltar = r; }));
    const p = api(f).reconferir(); await sleep(20);
    ok(!!f.doc.getElementById('eko-pelicula'), 'B2: conferindo a senha guardada → película cobre a tela (toque não imprime no nome de quem estava)');
    soltar(true); await p; await sleep(20);
    ok(!f.doc.getElementById('eko-pelicula'), 'B2: conferência terminou → película sai');
    let fim;
    const seg = api(f).segurar(new Promise(r => { fim = r; }));
    ok(!!f.doc.getElementById('eko-pelicula'), 'B2: restaurando a sessão depois da senha → película cobre a tela');
    const cx = api(f).perguntarSessaoDeOutro({ processo: 'Recebimento', operador: 'JOAO', itens: 1 });
    ok(!f.doc.getElementById('eko-pelicula') && api(f).bloqueando(), 'B2: a caixa "sessão de outro" abriu → película sai (a caixa segura o leitor)');
    f.doc.getElementById('eko-outro').querySelector('#eko-outro-continuar').onclick();
    await cx; fim(); await seg;
    const nunca = api(f).segurar(new Promise(() => {}));
    await sleep(400);
    ok(!f.doc.getElementById('eko-pelicula'), 'B2: servidor que não responde → película sai no teto (tela nunca fica morta)');
    nunca.catch(() => {});
  }

  // B3 (Recebimento/Retorno, função real): confirmação diz o que vai ao Bling.
  // (3ª revisão, B-d: com etiqueta não bipada o servidor RECUSA — 409 —, então
  // nada é "descartado": esse caso não oferece encerrar, ver seção I.)
  const html = fs.readFileSync(path.join(PUBLIC, 'mp-recebimento-retorno.html'), 'utf8');
  for (const aba of ['recebimento', 'retorno']) {
    const f = novoFrame(novoStorage(), fetchFalso);
    const key = aba === 'retorno' ? 'sessaoRetorno' : 'sessaoRecebimento';
    const lista = [{ status: 'bipada', peso: 25 }, { status: 'consumida', peso: 24.5 }];
    let finalizou = 0;
    Object.assign(f.win, {
      ABA_PIN: aba, CHAVE_PIN: 'mp-' + aba, showToast: () => {},
      finalizar: async () => { finalizou++; },
      restaurarSessoesAbertas: async () => {},
      estado: { sessaoInfo: { [aba]: { operador: 'BRUNO', inicio: null, itens: 2 } }, [key]: 77,
                itens: aba === 'recebimento' ? lista : [], retItens: aba === 'retorno' ? lista : [] },
    });
    vm.runInContext(presentes(html, FNS_RECEB_OUTRO).map(n => extrairFuncao(html, n)).join('\n'), f.win);
    f.win.EKO_RESPONSAVEL = 'ANA';
    const p = f.win.conferirSessaoDeOutro('AVISO DA TENTATIVA');
    await sleep(20);
    f.doc.getElementById('eko-outro').querySelector('#eko-outro-encerrar').onclick();
    await sleep(20);
    const cx = f.doc.getElementById('eko-confirma');
    const txt = cx ? cx.innerHTML : '';
    ok(/2 etiquetas bipadas/.test(txt) && /49\.5 kg/.test(txt), `B3 ${aba}: a confirmação diz o que vai ao Bling (2 bipadas · 49.5 kg)`, `(${txt.replace(/<[^>]+>/g, ' ').slice(0, 160)})`);
    ok(!/descartad/i.test(txt), `B3 ${aba}: e não promete descarte (o servidor não descarta nada)`);
    if (cx) cx.querySelector('#eko-confirma-nao').onclick();
    await sleep(20);
    const volta = f.doc.getElementById('eko-outro');
    ok(!!volta && /AVISO DA TENTATIVA/.test(volta.innerHTML), `B3 ${aba}: "Voltar" volta à pergunta com o mesmo aviso`);
    // Descartada (voltou à aba / teto): não finaliza nada.
    if (volta) api(f).encerrar('mp-' + aba);
    ok((await espera(p)) !== '__sem_resposta__' && finalizou === 0, `B1 ${aba}: pergunta descartada → a tela não finaliza nem continua nada`);
  }

  // F8/B6 (Recebimento/Retorno, função real): sessão DESTE frame sem nome fica no nome de quem entrou.
  {
    const f = novoFrame(novoStorage(), fetchFalso);
    const posts = [];
    const sessoes = [
      { id: 50, tipo: 'recebimento', operador: null, inicio: null, etiquetas: [{ seq: 1, id: 'R1', status: 'bipada', peso: 10 }] },
      { id: 51, tipo: 'retorno', operador: '', inicio: null, etiquetas: [{ seq: 1, id: 'R2', status: 'bipada', peso: 5 }] },
    ];
    f.win.fetch = async (url, o) => {
      if (String(url).startsWith('/sessoes/abertas')) return { ok: true, json: async () => ({ ok: true, sessoes }) };
      posts.push({ url: String(url), corpo: o && o.body });
      return { ok: true, json: async () => ({ ok: true }) };
    };
    Object.assign(f.win, {
      ABA_PIN: 'recebimento', URL_SESSAO: '/sessoes', MATERIAIS: {},
      showToast: () => {}, atualizarEstadoBlocos: () => {}, atualizarQtd: () => {}, renderHistorico: () => {}, atualizarBadgesPai: () => {},
      estado: { sessaoInfo: {}, itens: [], retItens: [] }, EKO_RESPONSAVEL: 'ANA',
    });
    let codigo;
    try { codigo = ['completarResponsavel', 'restaurarSessoesAbertas'].map(n => extrairFuncao(html, n)).join('\n'); }
    catch (e) { codigo = extrairFuncao(html, 'restaurarSessoesAbertas'); }
    vm.runInContext(codigo, f.win);
    await f.win.restaurarSessoesAbertas(); await sleep(20);
    const info = f.win.estado.sessaoInfo;
    ok(info.recebimento && info.recebimento.operador === 'ANA', 'F8: Recebimento sem nome → fica no nome de quem entrou (não pede a senha a cada troca de aba)', `(${JSON.stringify(info.recebimento)})`);
    ok(posts.some(p => p.url === '/sessoes/50/operador' && /ANA/.test(p.corpo)), 'F8: e grava o nome na sessão no servidor');
    ok(!posts.some(p => /\/sessoes\/51\//.test(p.url)) && !(info.retorno && info.retorno.operador), 'F8: a sessão sem nome da OUTRA aba (Retorno) não é tomada pelo Recebimento');
  }
  {
    // A tela: consulta que falha lança erro (não vira "não há processo").
    for (const [arq, fn, tipo] of [['mp-retirada.html', 'retiradaAbertaDe', 'retirada'], ['mp-recebimento-retorno.html', 'sessaoAbertaDe', 'recebimento']]) {
      const f = novoFrame(novoStorage(), async () => ({ ok: false, status: 503, json: async () => ({ ok: false }) }));
      Object.assign(f.win, { ABA_PIN: tipo });
      vm.runInContext(extrairFuncao(fs.readFileSync(path.join(PUBLIC, arq), 'utf8'), fn), f.win);
      let lancou = false;
      try { await f.win[fn]({ nome: 'ANA' }); } catch (e) { lancou = true; }
      ok(lancou, `F10: ${arq}: consulta com erro do servidor LANÇA (o componente mantém e tenta de novo), não diz "sem processo"`);
    }
  }
}

// ─── I) 3ª revisão (16/11/2026): B-a … B-g ───
// B-a a confirmação da Retirada (modal próprio) escapava do descarte · B-b
// conferência adiada sobrevivia à troca de pessoa · B-c senha sem teto travava
// o teclado · B-d prometia descarte que o servidor recusa · B-e película saía
// antes do envio ao Bling da sessão de outro · B-f caixa não vencia na mesma
// aba · B-g caixa abria por baixo do teclado.
function elementoFixo(doc, id) {
  const el = doc.createElement('div');
  el.id = id;
  el.classList = { add() {}, remove() {}, contains() { return false; } };
  doc.body.appendChild(el);
  return el;
}
async function testeTerceiraRevisao() {
  console.log('\n[I] 3ª revisão: confirmação da Retirada, conferência adiada, senha sem resposta, 409, película no envio, validade, teclado');
  const fetchSenha = async (url, o) => {
    const corpo = JSON.parse(o.body);
    const nome = corpo.pin === '1111' ? 'ANA' : corpo.pin === '2222' ? 'BRUNO' : corpo.pin === '3333' ? 'CARLA' : null;
    return { ok: !!nome, json: async () => (nome ? { ok: true, nome, id: nome.length } : { ok: false, erro: 'Senha não confere' }) };
  };
  const api = f => f.win.EkoAcesso;
  const logado = async (chave, aindaValida, extras, pin) => {
    const f = novoFrame(novoStorage(), fetchSenha, { EKO_TETO_CONFERIR_MS: 150, ...(extras || {}) });
    f.entrou = [];
    api(f).exigir('mp', nome => f.entrou.push(nome), { chave, aindaValida });
    f.digitar(pin || '1111'); f.entrar();
    await sleep(600);
    return f;
  };

  // B-a: Retirada, funções REAIS (conferirSessaoDeOutro, finalizar, envio).
  const htmlRet = fs.readFileSync(path.join(PUBLIC, 'mp-retirada.html'), 'utf8');
  const telaRetirada = async () => {
    let valida = true;
    const f = await logado('mp-retirada', async () => valida);
    f.setValida = v => { valida = v; };
    const doc = f.doc;
    elementoFixo(doc, 'btn-finalizar'); elementoFixo(doc, 'ultima-retirada');
    f.modais = 0; f.finalizados = [];
    const fetchSenhaFrame = f.win.fetch;
    f.win.fetch = async (url, o) => {
      if (/\/sessoes\/\d+\/finalizar$/.test(String(url))) {
        f.finalizados.push(String(url));
        return { ok: true, json: async () => ({ ok: true, bling: { ok: true, bling_id: 'X1' } }) };
      }
      return fetchSenhaFrame(url, o);
    };
    Object.assign(f.win, {
      CHAVE_PIN: 'mp-retirada', URL_SESS: '/sessoes', showToast: () => {}, fmtKg: n => String(n),
      renderHistorico: () => {}, atualizarBadgesPai: () => {}, beepOk: () => {}, beep: () => {}, beepErro: () => {}, beepWarn: () => {},
      cancelarSessaoSeVazia: async () => {},
      pedirConfirmacao: async () => { f.modais++; return true; },   // o modal PRÓPRIO da Retirada
      estado: { sessaoId: 77, sessaoOperador: 'JOAO', sessaoInicio: null, itens: [{ peso: 500 }, { peso: 480 }] },
    });
    vm.runInContext(presentes(htmlRet, ['escRet', 'encerrouProcesso', 'finalizar', 'enviarRetirada', 'conferirSessaoDeOutro'])
      .map(n => extrairFuncao(htmlRet, n)).join('\n'), f.win);
    return f;
  };
  {
    // B entrou, achou a retirada do JOAO, tocou "Encerrar"; a confirmação abriu e B saiu da aba.
    const f = await telaRetirada();
    const p = f.win.conferirSessaoDeOutro();
    await sleep(20);
    f.doc.getElementById('eko-outro').querySelector('#eko-outro-encerrar').onclick();
    await sleep(20);
    ok(!!f.doc.getElementById('eko-confirma') && f.modais === 0,
       'B-a: Retirada — "Encerrar a de JOAO" confirma pela caixa do EkoAcesso (descartável), não pelo modal próprio da tela',
       `(caixa: ${!!f.doc.getElementById('eko-confirma')}, modal próprio: ${f.modais})`);
    // C volta à aba: a conferência diz "não" (a sessão é do JOAO) → pede a senha.
    f.setValida(false);
    await api(f).reconferir(); await sleep(20);
    ok(f.teclado() && !f.doc.getElementById('eko-confirma'), 'B-a: quem volta à aba digita a senha; a confirmação de quem saiu some');
    await espera(p);
    ok(f.finalizados.length === 0, 'B-a: a retirada do JOAO NÃO vai ao Bling pela confirmação de quem saiu', `(finalizar: ${f.finalizados.length})`);
  }
  {
    // Caminho feliz: confirmou → envia uma vez, sem o modal próprio, e quem encerrou segue logado.
    const f = await telaRetirada();
    const p = f.win.conferirSessaoDeOutro();
    await sleep(20);
    f.doc.getElementById('eko-outro').querySelector('#eko-outro-encerrar').onclick();
    await sleep(20);
    const cx = f.doc.getElementById('eko-confirma');
    ok(!!cx && /2 itens/.test(cx.innerHTML) && /980/.test(cx.innerHTML), 'B-a: a confirmação da Retirada diz o que vai ao Bling (2 itens · 980 kg)',
       `(${cx ? cx.innerHTML.replace(/<[^>]+>/g, ' ').slice(0, 140) : 'sem caixa'})`);
    if (cx) cx.querySelector('#eko-confirma-sim').onclick();
    await espera(p, 500);
    ok(f.finalizados.length === 1 && f.modais === 0, 'B-a: confirmou → a retirada do JOAO vai ao Bling uma vez, sem segunda confirmação',
       `(finalizar: ${f.finalizados.length}, modal próprio: ${f.modais})`);
    ok(!f.teclado() && api(f).liberado('mp-retirada'), 'B-a: quem encerrou a de outro segue logado para começar a dele');
  }

  // B-b: a conferência que falhou (REFAZER) é da pessoa de antes.
  {
    let modo = 'vale';
    const aindaValida = async () => { if (modo === 'falha') throw new Error('fora'); return modo === 'vale'; };
    const f = await logado('mp-recebimento', aindaValida);
    modo = 'falha';
    await api(f).reconferir(); await sleep(20);
    ok(!f.teclado(), 'B-b: falha na consulta ao voltar à aba → Ana segue (conferência adiada)');
    api(f).encerrar('mp-recebimento');          // Ana trocou o responsável
    f.digitar('2222'); f.entrar(); await sleep(600);
    ok(api(f).responsavel() === 'BRUNO', 'B-b: Bruno entra');
    modo = 'nao';                                // Bruno começou agora, ainda sem etiqueta
    api(f).verificarTeto(); await sleep(50);
    ok(!f.teclado(), 'B-b: o relógio NÃO refaz a conferência adiada da Ana no Bruno (sem senha no meio da pesagem dele)');
  }

  // B-c: servidor que aceita e não responde a senha.
  {
    const f = novoFrame(novoStorage(), async () => new Promise(() => {}), { EKO_TETO_CONFERIR_MS: 150 });
    const entrou = [];
    api(f).exigir('mp', n => entrou.push(n), { chave: 'mp-retorno', aindaValida: async () => true });
    f.digitar('1111'); f.entrar();
    await sleep(400);
    const msg = f.doc.getElementById('eko-acesso') ? f.doc.getElementById('eko-acesso').querySelector('#eko-msg').textContent : '';
    ok(/não respondeu/i.test(msg), 'B-c: senha sem resposta do servidor → "Servidor não respondeu — tente de novo"', `(msg: ${msg})`);
    f.win.fetch = fetchSenha;
    f.digitar('1111'); f.entrar(); await sleep(600);
    ok(entrou.join() === 'ANA' && !f.teclado(), 'B-c: o teclado volta a aceitar a senha (não fica travado até recarregar)', `(entrou: ${JSON.stringify(entrou)})`);
  }

  // B-d: Recebimento/Retorno — com etiqueta impressa e não bipada (ou sem bipada) não oferece encerrar.
  const htmlRec = fs.readFileSync(path.join(PUBLIC, 'mp-recebimento-retorno.html'), 'utf8');
  const telaReceb = (aba, lista, extras) => {
    const f = novoFrame(novoStorage(), fetchSenha, extras);
    const key = aba === 'retorno' ? 'sessaoRetorno' : 'sessaoRecebimento';
    f.finalizou = 0;
    Object.assign(f.win, {
      ABA_PIN: aba, CHAVE_PIN: 'mp-' + aba, showToast: () => {},
      finalizar: async () => { f.finalizou++; return true; },
      restaurarSessoesAbertas: async () => {},
      estado: { sessaoInfo: { [aba]: { operador: 'JOAO', inicio: null, itens: lista.length } }, [key]: 77,
                itens: aba === 'recebimento' ? lista : [], retItens: aba === 'retorno' ? lista : [] },
    });
    vm.runInContext(presentes(htmlRec, FNS_RECEB_OUTRO).map(n => extrairFuncao(htmlRec, n)).join('\n'), f.win);
    f.win.EKO_RESPONSAVEL = 'ANA';
    return f;
  };
  for (const [nome, lista, re] of [
    ['etiqueta não bipada', [{ status: 'bipada', peso: 25 }, { status: 'aguardando_bipe', peso: 25 }], /NÃO bipada/],
    ['nenhuma bipada', [], /nenhuma etiqueta bipada/],
  ]) {
    const f = telaReceb('recebimento', lista);
    const p = f.win.conferirSessaoDeOutro();
    await sleep(20);
    const cx = f.doc.getElementById('eko-outro');
    const h = cx ? cx.innerHTML : '';
    ok(!!cx && !/id="eko-outro-encerrar"/.test(h), `B-d: ${nome} → a caixa NÃO oferece "Encerrar a de JOAO"`);
    ok(re.test(h) && /Continue no nome de JOAO/.test(h), `B-d: ${nome} → diz por quê e o que fazer`, `(${h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)})`);
    if (cx) cx.querySelector('#eko-outro-continuar').onclick();
    await espera(p);
    ok(f.finalizou === 0, `B-d: ${nome} → nada vai ao Bling`);
  }

  // B-e: película e leitor seguros até o envio da sessão de outro terminar (com teto).
  {
    const f = telaReceb('recebimento', [{ status: 'bipada', peso: 25 }], { EKO_TETO_ENCERRAR_MS: 300 });
    let soltar;
    // O envio fecha a sessão do JOAO quando o servidor responder.
    f.win.finalizar = () => { f.finalizou++; return new Promise(r => { soltar = v => { f.win.estado.sessaoInfo = {}; f.win.estado.sessaoRecebimento = null; r(v); }; }); };
    const p = f.win.conferirSessaoDeOutro();
    await sleep(20);
    f.doc.getElementById('eko-outro').querySelector('#eko-outro-encerrar').onclick(); await sleep(20);
    const cx = f.doc.getElementById('eko-confirma');
    if (cx) cx.querySelector('#eko-confirma-sim').onclick();
    await sleep(30);
    ok(f.finalizou === 1 && !!f.doc.getElementById('eko-pelicula') && api(f).bloqueando(),
       'B-e: enviando ao Bling a sessão do JOAO → película cobre a tela e o leitor fica parado (toque/bipe não cai na sessão fechada)');
    if (soltar) soltar(true);
    await espera(p, 500); await sleep(20);
    ok(!f.doc.getElementById('eko-pelicula') && !api(f).bloqueando(), 'B-e: envio terminou → película sai e o leitor volta');

    const g = telaReceb('retorno', [{ status: 'bipada', peso: 25 }], { EKO_TETO_ENCERRAR_MS: 200 });
    g.win.finalizar = () => new Promise(() => {});
    g.win.conferirSessaoDeOutro();
    await sleep(20);
    g.doc.getElementById('eko-outro').querySelector('#eko-outro-encerrar').onclick(); await sleep(20);
    const cg = g.doc.getElementById('eko-confirma');
    if (cg) cg.querySelector('#eko-confirma-sim').onclick();
    await sleep(500);
    ok(!g.doc.getElementById('eko-pelicula') && !api(g).bloqueando(), 'B-e: servidor que não responde ao envio → película sai no teto (tela nunca fica morta)');
  }

  // B-f: caixa sem resposta na MESMA aba vence.
  {
    const f = await logado('mp-retirada', async () => true, { EKO_VALIDADE_DECISAO_MS: 150 });
    const p = api(f).perguntarSessaoDeOutro({ processo: 'Retirada', operador: 'JOAO', itens: 1, chave: 'mp-retirada' });
    await sleep(400);
    ok(!f.doc.getElementById('eko-outro') && (await espera(p)) === 'cancelado', 'B-f: "sessão de outro" sem resposta por 2 min (aqui 150 ms) → vence e responde "cancelado"');
    ok(f.teclado() && !api(f).liberado('mp-retirada'), 'B-f: e pede a senha (quem chega depois não responde no nome de quem entrou)');
  }

  // B-g: com o teclado de senha na tela, a caixa de quem saiu não abre por baixo.
  {
    const f = novoFrame(novoStorage(), fetchSenha);
    api(f).exigir('mp', () => {}, { chave: 'mp-retirada', aindaValida: async () => true });
    ok(f.teclado(), 'B-g: teclado de senha na tela');
    const p = api(f).perguntarSessaoDeOutro({ processo: 'Retirada', operador: 'JOAO', itens: 1, chave: 'mp-retirada' });
    ok((await espera(p)) === 'cancelado' && !f.doc.getElementById('eko-outro'), 'B-g: a caixa "sessão de outro" não abre por baixo do teclado (responde "cancelado")');
  }
}

function testeTelas() {
  console.log('\n[D] telas (conferência estática)');
  const ler = f => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
  const r = ler('mp-retirada.html');
  ok(/const CHAVE_PIN = 'mp-retirada';/.test(r), 'Retirada tem a chave própria');
  ok(/EkoAcesso\.exigir\(tela, aoEntrar, \{ chave: CHAVE_PIN/.test(r), 'Retirada passa a chave ao pedir a senha');
  const fimR = r.slice(r.indexOf('async function finalizar('), r.indexOf('async function finalizar(') + 4000);
  ok(r.indexOf('async function finalizar(') > 0 && /encerrouProcesso\(\)/.test(fimR), 'Retirada: finalizar encerra a senha');
  ok((r.match(/encerrouProcesso\(\);/g) || []).length >= 2, 'Retirada: finalizar e cancelar encerram a senha');
  ok(/aindaValida: retiradaAbertaDe/.test(r), 'Retirada: a senha guardada só vale com retirada aberta da pessoa');
  const fr = extrairFuncao(r, 'retiradaAbertaDe');
  ok(/\(s\.etiquetas \|\| \[\]\)\.length > 0/.test(fr), 'Retirada: sessão vazia no nome da pessoa não vale como processo aberto');
  ok(/EkoAcesso\.bloqueando\(\)\) \{ _bufKey = ''; return; \}/.test(r), 'Retirada: leitor não dá baixa com o teclado de senha na tela');
  ok(/toast: \(tipo, icone, texto, ms\) => showToast\(tipo, icone, escRet\(texto\), ms\)/.test(r) && !/showToast\([^)]*\$\{(dono|eu)\}/.test(r),
     'Retirada: nome do operador escapado no aviso (showToast monta HTML)');
  ok(/estado\.sessaoOperador = window\.EKO_RESPONSAVEL \|\| null;/.test(r), 'Retirada: quem abre a sessão fica como dono');

  const rr = ler('mp-recebimento-retorno.html');
  ok(/const CHAVE_PIN = 'mp-' \+ ABA_PIN;/.test(rr), 'Recebimento/Retorno: chave pela aba');
  ok(/EkoAcesso\.exigir\(tela, aoEntrar, \{ chave: CHAVE_PIN/.test(rr), 'Recebimento/Retorno passa a chave ao pedir a senha');
  ok(/if \(finalizou && !opc\.deOutro\) encerrouProcesso\(\);/.test(rr), 'Recebimento/Retorno: enviar ao Bling a própria sessão encerra a senha');
  ok(/if \(sessaoId\) encerrouProcesso\(\);/.test(rr), 'Recebimento/Retorno: cancelar encerra a senha');
  ok(/aindaValida: sessaoAbertaDe/.test(rr), 'Recebimento/Retorno: a senha guardada só vale com sessão aberta da pessoa');
  const fs2 = extrairFuncao(rr, 'sessaoAbertaDe');
  ok(/\(s\.etiquetas \|\| \[\]\)\.length > 0/.test(fs2), 'Recebimento/Retorno: sessão vazia não vale como processo aberto');
  ok(/EkoAcesso\.bloqueando\(\)\) \{ bipeBuffer = ''; return; \}/.test(rr), 'Recebimento/Retorno: leitor parado com o teclado de senha na tela');
  const rest = rr.slice(rr.indexOf('async function restaurarSessoesAbertas'), rr.indexOf('async function restaurarSessoesAbertas') + 600);
  ok(rest.indexOf('estado.sessaoInfo = {}') > rest.indexOf('if (!r.ok) return;'), 'Recebimento/Retorno: consulta que falha não apaga quem é o dono');

  const mp = ler('materia-prima.html');
  ok(!/<script[^>]+acesso-colaborador\.js/.test(mp) && !/comAcesso\(/.test(mp), 'Matéria-Prima: entrar na função não pede senha');
  ok(/ativarAba\(abaInicial\(\)\);/.test(mp), 'Matéria-Prima: abre a aba direto');

  const s = ler('seguranca-saida.js');
  ok(/O sistema continua ligado/.test(s), 'painel de saída diz que o sistema continua ligado');
}

async function subirServidor() {
  servidor = spawn('node', [SERVER], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, TZ: 'America/Sao_Paulo',
           EKO_PRINT_SIMULAR: '1', EKO_FECHAR_TELA_SIMULAR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
  servidor.on('exit', c => { servidor._saiu = c === null ? 'sinal' : c; });
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error('Servidor não subiu em 15s');
}

async function testeFecharAgora() {
  console.log('\n[E] "Fechar agora" fecha só a tela');
  if (fs.existsSync(FLAG)) throw new Error('ABORTADO: eko-encerrar.flag já existe na pasta (não apago o que não é do teste)');
  const r = await fetch(BASE + '/sistema/encerrar', { method: 'POST' });
  const d = await r.json().catch(() => null);
  ok(r.ok && d && d.encerrando === true, 'POST /sistema/encerrar responde');
  await sleep(1500);   // o código antigo saía em 200 + 700 ms
  let vivo = false;
  try { vivo = (await fetch(BASE + '/healthcheck')).ok; } catch (e) {}
  ok(vivo && servidor._saiu === undefined, 'servidor continua respondendo depois do "Fechar agora"', `(saiu: ${servidor._saiu})`);
  const flag = fs.existsSync(FLAG);
  if (flag) { try { fs.rmSync(FLAG); } catch (e) {} }
  ok(!flag, 'não grava eko-encerrar.flag (o INICIAR.bat não religaria o servidor)');
}

// B-d contra o SERVIDOR de verdade: sessão de recebimento com uma etiqueta
// bipada e outra impressa e não bipada. O finalizar responde 409 e nada é
// descartado nem enviado; a função real da tela, com os status que o servidor
// devolve, não oferece encerrar e diz por quê.
async function testeServidor409() {
  console.log('\n[E2] servidor real: etiqueta não bipada → finalizar recusa (409), a tela não promete descarte');
  const post = async (url, corpo) => {
    const r = await fetch(BASE + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo || {}) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const s = await post('/sessoes', { tipo: 'recebimento', operador: 'JOAO', fornecedor: 'Piquiri' });
  const sid = s.json && s.json.sessao_id;
  const etq = async peso => (await post('/print/etiqueta', {
    clientToken: `pin409-${peso}-${CARIMBO}`, tipo: 'recebimento', materialKey: 'GBD', materialNomeEt: 'BAIXA DENSIDADE',
    cor: 'Canela', fornecedor: 'Piquiri', peso, lote: '4090', codigo: 'CAN1', sku: `GBD.CAN.PIQUIR | ${peso} | L4090`, sessao_id: sid,
  })).json;
  const a = await etq(1001.5), b = await etq(998.5);
  ok(sid && a && a.ok && b && b.ok, 'E2: sessão com duas etiquetas impressas', JSON.stringify([s.json, a, b]));
  await post(`/etiquetas/${a.id}/bipar`);
  const fim = await post(`/sessoes/${sid}/finalizar`);
  ok(fim.status === 409, 'E2: com etiqueta impressa e não bipada, o servidor RECUSA o finalizar (409)', `(status: ${fim.status})`);
  const abertas = await (await fetch(BASE + '/sessoes/abertas?tipo=recebimento')).json();
  const sess = (abertas.sessoes || []).find(x => x.id === sid);
  const st = sess ? (sess.etiquetas || []).map(e => e.status).sort() : [];
  ok(sess && st.join() === 'aguardando_bipe,bipada', 'E2: a sessão segue aberta com as duas etiquetas (nada descartado)', `(status: ${st.join()})`);

  const html = fs.readFileSync(path.join(PUBLIC, 'mp-recebimento-retorno.html'), 'utf8');
  const f = novoFrame(novoStorage(), async () => ({ ok: true, json: async () => ({ ok: true }) }));
  Object.assign(f.win, {
    ABA_PIN: 'recebimento', CHAVE_PIN: 'mp-recebimento', showToast: () => {},
    finalizar: async () => true, restaurarSessoesAbertas: async () => {},
    estado: { sessaoInfo: { recebimento: { operador: 'JOAO', inicio: null, itens: st.length } }, sessaoRecebimento: sid,
              itens: (sess ? sess.etiquetas : []).map(e => ({ status: e.status, peso: e.peso })), retItens: [] },
  });
  vm.runInContext(presentes(html, FNS_RECEB_OUTRO).map(n => extrairFuncao(html, n)).join('\n'), f.win);
  f.win.EKO_RESPONSAVEL = 'ANA';
  const p = f.win.conferirSessaoDeOutro();
  await sleep(20);
  const cx = f.doc.getElementById('eko-outro');
  const h = cx ? cx.innerHTML : '';
  ok(!!cx && !/id="eko-outro-encerrar"/.test(h) && /1 etiqueta impressa e NÃO bipada/.test(h),
     'E2: com os status do servidor, a tela não oferece encerrar e diz que há 1 etiqueta impressa e não bipada',
     `(${h.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 200)})`);
  if (cx) cx.querySelector('#eko-outro-continuar').onclick();
  await Promise.race([p, sleep(300)]);
}

function encerrar() {
  try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
}

(async () => {
  try {
    await testeFrames();
    await testeContinuadas();
    await testeFrameVivo();
    await testeSegundaRevisao();
    await testeTerceiraRevisao();
    testeTelas();
    await subirServidor();
    const h = await (await fetch(BASE + '/healthcheck')).json();
    if (!h || h.impressao_simulada_forcada !== true) throw new Error('ABORTADO: impressão não está travada em simulação');
    await testeFecharAgora();
    await testeServidor409();
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passaram, ${falhou} falharam`);
    if (falhou) { console.log(' FALHAS:'); falhas.forEach(f => console.log('   - ' + f)); }
    console.log('═══════════════════════════════════════════════════');
  } catch (e) {
    console.error('\nERRO FATAL:', e.message);
    falhou++;
  } finally {
    encerrar();
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
