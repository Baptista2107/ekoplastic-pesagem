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
function novoFrame(sessionStorage, fetchFalso) {
  const doc = {
    _ids: {}, _ouvintes: [], readyState: 'complete',
    getElementById(id) { return this._ids[id] || null; },
    createElement(tag) { return novoElemento(tag, doc); },
    addEventListener(tipo, fn) { if (tipo === 'keydown') this._ouvintes.push(fn); },
    removeEventListener(tipo, fn) { this._ouvintes = this._ouvintes.filter(f => f !== fn); },
  };
  doc.head = novoElemento('head', doc);
  doc.body = novoElemento('body', doc);
  const win = { document: doc, sessionStorage, fetch: fetchFalso, console, setTimeout, Date, JSON, Promise };
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

  // C) Ana encerra a retirada: o teclado volta só ali.
  const antes = entrouRet.length;
  ret.win.EkoAcesso.encerrar('mp-retirada');
  ok(ret.teclado(), 'encerrar: o teclado volta na Retirada');
  ok(!ret.win.EkoAcesso.liberado('mp-retirada'), 'encerrar: a liberação da Retirada foi apagada');
  ok(rtn.win.EkoAcesso.liberado('mp-retorno'), 'encerrar a Retirada não derruba o Retorno do Bruno');
  ret.win.EkoAcesso.encerrar('mp-retirada');   // clique duplo
  ok(ret.doc.body.children.filter(c => c.id === 'eko-acesso').length === 1, 'encerrar duas vezes não abre dois teclados');
  ret.digitar('2222'); ret.entrar();
  await sleep(600);
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
  ok(/EkoAcesso\.bloqueando\(\)\) \{ _bufKey = ''; return; \}/.test(r), 'Retirada: leitor não dá baixa com o teclado de senha na tela');
  ok(!/\$\{dono\}/.test(r) && !/\$\{eu\}/.test(r), 'Retirada: nome do operador escapado no aviso (showToast monta HTML)');
  ok(/estado\.sessaoOperador = window\.EKO_RESPONSAVEL \|\| null;/.test(r), 'Retirada: quem abre a sessão fica como dono');

  const rr = ler('mp-recebimento-retorno.html');
  ok(/const CHAVE_PIN = 'mp-' \+ ABA_PIN;/.test(rr), 'Recebimento/Retorno: chave pela aba');
  ok(/EkoAcesso\.exigir\(tela, aoEntrar, \{ chave: CHAVE_PIN/.test(rr), 'Recebimento/Retorno passa a chave ao pedir a senha');
  ok(/if \(finalizou\) encerrouProcesso\(\);/.test(rr), 'Recebimento/Retorno: enviar ao Bling encerra a senha');
  ok(/if \(sessaoId\) encerrouProcesso\(\);/.test(rr), 'Recebimento/Retorno: cancelar encerra a senha');
  ok(/aindaValida: sessaoAbertaDe/.test(rr), 'Recebimento/Retorno: a senha guardada só vale com sessão aberta da pessoa');
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

function encerrar() {
  try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
}

(async () => {
  try {
    await testeFrames();
    testeTelas();
    await subirServidor();
    const h = await (await fetch(BASE + '/healthcheck')).json();
    if (!h || h.impressao_simulada_forcada !== true) throw new Error('ABORTADO: impressão não está travada em simulação');
    await testeFecharAgora();
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
