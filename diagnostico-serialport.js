#!/usr/bin/env node
'use strict';
/* ==========================================================================
 * Ekoplastic Pesagem - diagnostico do serialport  -  VERSAO 2
 * --------------------------------------------------------------------------
 * A versao 1 se contradisse na maquina do chao de fabrica: disse que o
 * serialport estava presente, disse que NAO havia nenhum binario .node, e
 * mesmo assim carregou o modulo e listou a COM1. As tres coisas nao podem
 * ser verdade juntas.
 *
 * Causa provavel: a varredura da v1 usava isDirectory(), que devolve falso
 * para link/junction do Windows. Se os pacotes do serialport forem links
 * apontando para outro lugar do disco, o require segue e funciona, mas a
 * varredura pula tudo - e o empacotamento levaria uma casca vazia.
 *
 * Esta versao responde de forma decisiva:
 *   1. De ONDE o serialport foi carregado de verdade  - require.resolve
 *   2. ONDE esta o binario .node que foi carregado    - require.cache
 *   3. QUAIS entradas de node_modules sao link        - lstat
 *   4. Se ESTA pasta e a que roda a balanca de fato   - arquivos de runtime
 *
 * SOMENTE LEITURA. Nao instala, nao copia, nao move, nao apaga nada.
 * NAO ABRE a porta serial - so' usa SerialPort.list.
 *
 * Uso:
 *   node diagnostico-serialport.js          -> relatorio completo
 *   node diagnostico-serialport.js --gate   -> so' testa o require, silencioso
 * ========================================================================== */

const fs = require('fs');
const path = require('path');

const GATE = process.argv.includes('--gate');
const RAIZ = process.cwd();
const OUT = path.join(RAIZ, 'OUTPUT_DIAGNOSTICO_SERIALPORT.TXT');
const NM = path.join(RAIZ, 'node_modules');

// Amarra o require ao node_modules que esta sendo analisado, para o relatorio
// nao falar de uma pasta e o require carregar de outra.
try { module.paths.unshift(NM); } catch (e) { /* segue */ }

function w(linha) {
  const texto = (linha === undefined ? '' : String(linha));
  if (GATE) return;
  console.log(texto);
  try { fs.appendFileSync(OUT, texto + '\n', 'utf8'); } catch (e) { /* segue */ }
}
function existe(p) { try { fs.accessSync(p); return true; } catch (e) { return false; } }
function versaoDe(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version || '?'; }
  catch (e) { return null; }
}
function kb(n) { return (n / 1024).toFixed(1) + ' KB'; }
function mb(n) { return (n / 1048576).toFixed(1) + ' MB'; }

/* Tipo real de uma entrada, distinguindo link de pasta/arquivo de verdade. */
function tipoReal(p) {
  let l = null;
  try { l = fs.lstatSync(p); } catch (e) { return { tipo: 'ilegivel' }; }
  if (l.isSymbolicLink() || l.isDirectory() === false && l.isFile() === false) {
    let alvo = null, seguido = null;
    try { alvo = fs.readlinkSync(p); } catch (e) { /* junction as vezes nao le */ }
    try { alvo = alvo || fs.realpathSync(p); } catch (e) { /* segue */ }
    try { seguido = fs.statSync(p); } catch (e) { /* link quebrado */ }
    if (l.isSymbolicLink()) {
      return { tipo: 'link', alvo, quebrado: !seguido,
               vira: seguido ? (seguido.isDirectory() ? 'pasta' : 'arquivo') : null };
    }
  }
  if (l.isDirectory()) return { tipo: 'pasta' };
  if (l.isFile()) return { tipo: 'arquivo', size: l.size };
  return { tipo: 'outro' };
}

/* Caminhada que ATRAVESSA links, com protecao contra ciclo. */
function caminhar(dir, aoAchar, limite) {
  const est = { arquivos: 0, bytes: 0, links: 0, estourou: false };
  const vistos = new Set();
  const pilha = [dir];
  while (pilha.length) {
    if (est.arquivos > limite) { est.estourou = true; break; }
    const atual = pilha.pop();
    let real = atual;
    try { real = fs.realpathSync(atual); } catch (e) { /* segue */ }
    if (vistos.has(real)) continue;
    vistos.add(real);
    let itens;
    try { itens = fs.readdirSync(atual, { withFileTypes: true }); } catch (e) { continue; }
    for (const it of itens) {
      const p = path.join(atual, it.name);
      let st = null;
      try { st = fs.statSync(p); } catch (e) { continue; }   // statSync SEGUE o link
      if (it.isSymbolicLink()) est.links++;
      if (st.isDirectory()) { pilha.push(p); continue; }
      if (!st.isFile()) continue;
      est.arquivos++; est.bytes += st.size;
      if (aoAchar) aoAchar(p, st);
    }
  }
  return est;
}

/* ========================================================================== */
async function main() {

  if (GATE) {
    // A trava do empacotamento nao pode se contentar com "o require funcionou":
    // o binario pode estar FORA desta pasta e o pacote sairia como casca vazia.
    try {
      require('serialport'); require('@serialport/parser-readline');
    } catch (e) { console.log('GATE FALHOU: ' + e.message); process.exit(1); }
    const nat = Object.keys(require.cache).filter(k => k.toLowerCase().endsWith('.node'));
    if (!nat.length) {
      console.log('GATE FALHOU: nenhum binario nativo foi carregado.');
      process.exit(1);
    }
    const fora = nat.filter(c => !c.startsWith(RAIZ));
    if (fora.length) {
      console.log('GATE FALHOU: o binario nativo esta FORA desta pasta:');
      for (const f of fora) console.log('  ' + f);
      console.log('Empacotar daqui levaria uma casca sem o binario.');
      process.exit(1);
    }
    console.log('GATE OK: serialport carregou e o binario esta dentro da pasta.');
    for (const n of nat) console.log('  ' + n);
    process.exit(0);
  }

  try { fs.writeFileSync(OUT, ''); } catch (e) { /* segue */ }

  /* ---------- FASE 1 - AMBIENTE ---------- */
  w('------------------------------------------------------------');
  w('FASE 1 - AMBIENTE DESTA MAQUINA');
  w('------------------------------------------------------------');
  w('Node...............: ' + process.version);
  w('ABI / NODE_MODULE..: ' + process.versions.modules);
  w('Plataforma.........: ' + process.platform + ' ' + process.arch);
  w('Executavel do Node.: ' + process.execPath);
  w('Pasta analisada....: ' + RAIZ);
  w('NODE_PATH..........: ' + (process.env.NODE_PATH || '(nao definido)'));
  w('');

  /* ---------- FASE 2 - ESTA PASTA E' A QUE RODA A BALANCA? ---------- */
  w('------------------------------------------------------------');
  w('FASE 2 - ESTA PASTA E A QUE RODA A BALANCA DE VERDADE?');
  w('------------------------------------------------------------');
  w('Os arquivos abaixo so existem onde o sistema RODOU de fato. Pasta com');
  w('server.js mas SEM banco e SEM logs e copia parada, nao e producao.');
  w('');
  const marcas = [
    ['etiquetas.db',            'banco de producao - o dado real'],
    ['etiquetas.db-wal',        'journal WAL - so existe com o banco em uso'],
    ['credenciais-bling.json',  'credenciais do Bling'],
    ['bling_tokens.json',       'token OAuth vivo'],
    ['logs',                    'pasta de logs'],
    ['backups',                 'pasta de backups diarios'],
    ['cert',                    'certificado HTTPS gerado na 1a execucao'],
  ];
  let sinaisVida = 0;
  for (const [nome, desc] of marcas) {
    const p = path.join(RAIZ, nome);
    if (existe(p)) {
      sinaisVida++;
      let info = '';
      try {
        const st = fs.statSync(p);
        info = st.isDirectory()
          ? '  [pasta]'
          : '  ' + kb(st.size) + '  alterado em ' + st.mtime.toISOString().slice(0, 16).replace('T', ' ');
      } catch (e) { /* segue */ }
      w('  EXISTE : ' + nome.padEnd(24) + info);
      w('           ' + desc);
    } else {
      w('  AUSENTE: ' + nome.padEnd(24) + '  ' + desc);
    }
  }
  w('');
  w('  Sinais de vida encontrados: ' + sinaisVida + ' de ' + marcas.length);
  if (sinaisVida === 0) {
    w('  >>> ATENCAO: nenhum. Esta pasta quase certamente NAO e a de producao.');
    w('  >>> Procure a pasta certa antes de empacotar qualquer coisa.');
  } else if (sinaisVida < 3) {
    w('  >>> DUVIDOSO: poucos sinais. Confirme que e esta a pasta em uso.');
  } else {
    w('  >>> OK: tem cara de pasta de producao.');
  }
  w('');

  /* versao do server.js desta pasta */
  const sjs = path.join(RAIZ, 'server.js');
  if (existe(sjs)) {
    try {
      const txt = fs.readFileSync(sjs, 'utf8');
      const m = txt.match(/const\s+VERSION\s*=\s*['"]([^'"]+)['"]/);
      const st = fs.statSync(sjs);
      w('  server.js desta pasta:');
      w('    VERSION declarada..: ' + (m ? m[1] : '(nao encontrei)'));
      w('    tamanho............: ' + kb(st.size));
      w('    alterado em........: ' + st.mtime.toISOString().slice(0, 16).replace('T', ' '));
      w('    linhas.............: ' + txt.split('\n').length);
      w('');
      w('  Compare com o PC de Pesagem: v157, 331.199 bytes, 6.255 linhas.');
      w('  Se nao bater, as duas maquinas tem codigo DIFERENTE e isso precisa');
      w('  ser resolvido antes de publicar a baseline.');
    } catch (e) { w('  ERRO ao ler server.js: ' + e.message); }
  }
  w('');

  /* ---------- FASE 3 - package.json ---------- */
  w('------------------------------------------------------------');
  w('FASE 3 - package.json E LOCK');
  w('------------------------------------------------------------');
  try {
    const j = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
    w('name...............: ' + j.name);
    w('version............: ' + j.version);
    w('engines.node.......: ' + (j.engines && j.engines.node ? j.engines.node : '(nao declarado)'));
    const deps = j.dependencies || {};
    w('dependencies declaradas:');
    for (const n of Object.keys(deps)) w('   ' + n + ' : ' + deps[n]);
  } catch (e) { w('ERRO ao ler package.json: ' + e.message); }
  w('package-lock.json..: ' + (existe(path.join(RAIZ, 'package-lock.json')) ? 'PRESENTE' : 'AUSENTE'));
  w('');

  /* ---------- FASE 4 - LINK OU PASTA DE VERDADE? ---------- */
  w('------------------------------------------------------------');
  w('FASE 4 - node_modules: O QUE E PASTA E O QUE E LINK');
  w('------------------------------------------------------------');
  w('Link/junction e o ponto cego do empacotamento: o require segue o link e');
  w('funciona, mas o tar empacota a casca e nao o conteudo.');
  w('');
  if (!existe(NM)) {
    w('  FALHA: nao existe node_modules nesta pasta.');
  } else {
    const alvos = [
      ['serialport',                    path.join(NM, 'serialport')],
      ['@serialport/parser-readline',   path.join(NM, '@serialport', 'parser-readline')],
      ['@serialport/bindings-cpp',      path.join(NM, '@serialport', 'bindings-cpp')],
      ['@serialport/stream',            path.join(NM, '@serialport', 'stream')],
      ['node-gyp-build',                path.join(NM, 'node-gyp-build')],
      ['node-forge',                    path.join(NM, 'node-forge')],
    ];
    for (const [nome, dir] of alvos) {
      if (!existe(dir)) { w('  AUSENTE  : ' + nome); continue; }
      const t = tipoReal(dir);
      const v = versaoDe(dir);
      let linha = '  ' + (t.tipo === 'link' ? 'LINK     ' : 'PASTA    ') + ': ' + nome + (v ? '  v' + v : '');
      w(linha);
      if (t.tipo === 'link') {
        w('             aponta para: ' + (t.alvo || '(nao consegui ler o alvo)'));
        if (t.quebrado) w('             >>> LINK QUEBRADO - o alvo nao existe mais.');
      }
    }
    w('');
    let nLinks = 0;
    try {
      for (const it of fs.readdirSync(NM, { withFileTypes: true })) {
        if (it.isSymbolicLink()) nLinks++;
      }
    } catch (e) { /* segue */ }
    w('  Entradas do primeiro nivel que sao link: ' + nLinks);
  }
  w('');

  /* ---------- FASE 5 - BINARIOS NATIVOS, ATRAVESSANDO LINKS ---------- */
  w('------------------------------------------------------------');
  w('FASE 5 - BINARIOS .node - varredura que ATRAVESSA link');
  w('------------------------------------------------------------');
  const nativos = [];
  let resumo = { arquivos: 0, bytes: 0, links: 0, estourou: false };
  if (existe(NM)) {
    resumo = caminhar(NM, (p, st) => {
      if (p.toLowerCase().endsWith('.node')) nativos.push({ p, size: st ? st.size : 0 });
    }, 200000);
  }
  let temWin64 = false;
  if (!nativos.length) {
    w('  NENHUM arquivo .node encontrado, nem seguindo links.');
  } else {
    for (const n of nativos) {
      const rel = n.p.startsWith(RAIZ) ? path.relative(RAIZ, n.p) : n.p;
      const napi = /napi/i.test(path.basename(n.p));
      const win = /win32[-_]x64/i.test(n.p);
      if (win) temWin64 = true;
      w('  ' + rel);
      w('       ' + kb(n.size) + '   ' + (napi ? 'N-API' : 'ABI classica') + (win ? '   <-- Windows 64 bits' : ''));
    }
  }
  w('');
  w('  Arquivos em node_modules..: ' + resumo.arquivos + (resumo.estourou ? '  (interrompido no limite)' : ''));
  w('  Tamanho...................: ' + mb(resumo.bytes));
  w('  Links encontrados no meio.: ' + resumo.links);
  w('');

  /* ---------- FASE 6 - DE ONDE O MODULO VEIO DE VERDADE ---------- */
  w('------------------------------------------------------------');
  w('FASE 6 - PROVA REAL: DE ONDE O MODULO FOI CARREGADO');
  w('------------------------------------------------------------');
  w('Esta e a fase que resolve a contradicao. require.resolve devolve o');
  w('caminho EXATO de onde o Node foi buscar o modulo.');
  w('');
  for (const nome of ['serialport', '@serialport/parser-readline', '@serialport/bindings-cpp', 'node-gyp-build']) {
    try { w('  ' + nome.padEnd(30) + ' -> ' + require.resolve(nome)); }
    catch (e) { w('  ' + nome.padEnd(30) + ' -> NAO RESOLVE: ' + e.code); }
  }
  w('');
  w('  Caminhos onde o Node procura, em ordem:');
  for (const p of module.paths) w('    ' + p);
  w('');

  let veredito = false;
  let SerialPort = null;
  try {
    ({ SerialPort } = require('serialport'));
    w('  OK  : require("serialport") carregou.');
    try { require('@serialport/parser-readline'); w('  OK  : parser-readline carregou.'); veredito = true; }
    catch (e2) { w('  ERRO: parser-readline NAO carregou -> ' + e2.message); }
  } catch (e) {
    w('  ERRO: require("serialport") falhou -> ' + e.message);
    w('  E aqui que o server.js cai no try/catch e desativa a balanca.');
  }
  w('');

  /* o .node que foi realmente carregado aparece no cache de modulos */
  const carregados = Object.keys(require.cache).filter(k => k.toLowerCase().endsWith('.node'));
  w('  Binarios nativos EFETIVAMENTE carregados neste processo:');
  if (!carregados.length) {
    w('    nenhum registrado no require.cache.');
  } else {
    for (const c of carregados) {
      let tam = '';
      try { tam = '   ' + kb(fs.statSync(c).size); } catch (e) { /* segue */ }
      w('    ' + c + tam);
      w('    ' + (c.startsWith(RAIZ) ? '>>> DENTRO desta pasta - pode ser empacotado.'
                                     : '>>> FORA desta pasta - NAO seria empacotado pelo tar!'));
    }
  }
  w('');

  /* node-gyp-build sabe apontar o binario exato do bindings-cpp */
  try {
    const ngb = require('node-gyp-build');
    const dirBind = path.dirname(require.resolve('@serialport/bindings-cpp'));
    let base = dirBind;
    for (let i = 0; i < 4; i++) {
      if (existe(path.join(base, 'package.json'))) break;
      base = path.dirname(base);
    }
    w('  node-gyp-build aponta o binario em:');
    w('    ' + ngb.path(base));
  } catch (e) {
    w('  node-gyp-build nao soube apontar o binario: ' + e.message);
  }
  w('');

  if (SerialPort && veredito) {
    w('  Portas seriais do Windows - nao abre a porta:');
    try {
      const portas = await SerialPort.list();
      if (!portas.length) w('    nenhuma porta encontrada.');
      for (const p of portas) {
        w('    ' + p.path + '  |  ' + (p.manufacturer || 'sem fabricante') + '  |  ' + (p.friendlyName || ''));
      }
      w('    COM1 presente: ' + (portas.some(p => String(p.path).toUpperCase() === 'COM1') ? 'SIM' : 'NAO'));
    } catch (e) { w('    ERRO ao listar portas: ' + e.message); }
    w('');
  }

  /* ---------- FASE 7 - VEREDITO ---------- */
  w('------------------------------------------------------------');
  w('FASE 7 - VEREDITO');
  w('------------------------------------------------------------');
  const dentro = carregados.length > 0 && carregados.every(c => c.startsWith(RAIZ));
  const podeEmpacotar = veredito && nativos.length > 0 && dentro;

  if (!veredito) {
    w('  O serialport NAO carrega nesta pasta. NAO empacote.');
  } else if (!carregados.length) {
    w('  O modulo carregou mas nao consegui identificar o binario nativo.');
    w('  NAO empacote ainda - mande este relatorio para analise.');
  } else if (!dentro) {
    w('  ATENCAO - ESTE E O PROBLEMA:');
    w('  o serialport funciona, mas o binario nativo esta FORA desta pasta.');
    w('  Empacotar o node_modules daqui levaria uma casca sem o binario, e a');
    w('  balanca nao subiria no clone do Mini PC.');
    w('  Veja na FASE 6 o caminho real e mande este relatorio.');
  } else if (!nativos.length) {
    w('  Contradicao: o binario carregou mas a varredura nao o achou.');
    w('  Mande este relatorio para analise. NAO empacote.');
  } else {
    w('  LIBERADO PARA EMPACOTAR.');
    w('  serialport carrega, o binario esta dentro desta pasta' +
      (temWin64 ? ' e ha binario win32-x64.' : '.'));
    w('  Proximo passo: MINIPC-EMPACOTAR-NODE-MODULES.bat, nesta mesma pasta.');
  }
  w('');
  w('Relatorio salvo em:');
  w('  ' + OUT);
  w('');
  w('=== FIM DO DIAGNOSTICO ===');

  process.exitCode = podeEmpacotar ? 0 : 1;
}

main().catch(e => {
  w(''); w('ERRO INESPERADO: ' + (e && e.stack ? e.stack : e));
  w('=== FIM DO DIAGNOSTICO ==='); process.exitCode = 1;
});
