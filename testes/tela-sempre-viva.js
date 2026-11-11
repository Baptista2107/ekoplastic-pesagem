// ════════════════════════════════════════════════════════════════════
//  O SERVIDOR NÃO FICA FECHADO E A TELA VOLTA SOZINHA — Ekoplastic (11/11/2026)
//  Gustavo: "esse servidor não pode ficar fechado de jeito algum".
//  Em 11/11: 08h14 o "Fechar agora" desligou o servidor (31 min fora);
//  10h39 a atualização remota abriu o Chrome na sessão 0 do Windows,
//  invisível, e o monitor ficou sem tela.
//
//   A) lib/tela.js com relógio injetado: o que o vigia ouve (ABRIR,
//      AGUARDAR, PAUSADA, ABERTA, DESISTIU), a pausa de 10 min do
//      "Fechar agora", o freio contra encher a tela de janelas e o
//      "só da própria máquina".
//   B) servidor REAL: POST /sistema/encerrar fecha só a tela (o servidor
//      segue respondendo e não grava eko-encerrar.flag); GET /sistema/tela
//      e POST /sistema/tela/abrir; o /healthcheck mostra o vigia.
//   C) INICIAR.bat — CONFERÊNCIA POR LEITURA (o .bat não roda no Linux):
//      a passagem do INICIAR antigo (o cmd relê o arquivo pela posição em
//      bytes depois do git merge), rótulos que existem, nenhum navegador
//      aberto pelo .bat, eko-encerrar.flag não desliga, taskkill só com
//      vigia, merge e goto na mesma linha.
//   D) tela-vigia.ps1 e ATUALIZAR.bat — também só leitura: nomes de
//      bandeira, mutex e palavras batem com o servidor.
//
//  Como rodar:   node testes/tela-sempre-viva.js
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT     = path.join(__dirname, '..');
const SERVER   = path.join(ROOT, 'server.js');
const PORT     = 13987;
const PORT_CB  = 18987;
const PORT_TLS = 14987;
const BASE     = `http://localhost:${PORT}`;
const CARIMBO  = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_tela_${CARIMBO}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_tela_logs_${CARIMBO}`);
const FLAG     = path.join(ROOT, 'eko-encerrar.flag');

let servidor;
let passou = 0, falhou = 0;
const falhas = [];

function ok(cond, nome, detalhe = '') {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${nome}`); }
  else      { falhou++; falhas.push(nome); console.log(`  \x1b[31m✗ ${nome}\x1b[0m ${detalhe}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ler = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
// Como o Mini PC tem o arquivo: CRLF (.gitattributes: *.bat eol=crlf).
const comoNoMiniPc = f => Buffer.from(ler(f).replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'), 'latin1');

// ─── A) decisão da tela, relógio injetado ───
function testeDecisao() {
  console.log('\n[A] lib/tela.js: o que o vigia ouve');
  let tela;
  try { tela = require(path.join(ROOT, 'lib', 'tela.js')); }
  catch (e) { ok(false, 'lib/tela.js existe', `(${e.message.split('\n')[0]})`); return; }
  const { decidir, pausar, liberar, resumoTela, ehLocal, novoEstado, PAUSA_MS, ESPERA_ABRIR_MS } = tela;
  const MIN = 60 * 1000;
  let e = novoEstado();
  let t = 1_000_000_000_000;
  const d = (aberta, dt = 0) => { t += dt; return decidir({ sessao: 1, aberta, agora: t }, e); };

  ok(d(false) === 'ABRIR', 'tela fechada, sem pausa: ABRIR');
  ok(d(false, 2000) === 'AGUARDAR', 'logo depois de mandar abrir: AGUARDAR (o Chrome ainda está subindo)');
  ok(d(true, 3000) === 'ABERTA', 'tela apareceu aberta: ABERTA');
  const x1 = d(false, 5000), x2 = d(false, ESPERA_ABRIR_MS);
  ok(x1 === 'AGUARDAR' && x2 === 'ABRIR', 'fechada pelo X logo depois de abrir: espera os 30 s e abre de novo', `(${x1}, ${x2})`);
  e = novoEstado();
  d(false); d(true, 3000);
  ok(d(false, 10 * MIN) === 'ABRIR', 'fechada pelo X muito depois: ABRIR na hora (próxima pergunta do vigia, até 5 s)');
  e = novoEstado();
  ok(d(false, ESPERA_ABRIR_MS) === 'ABRIR' && d(false, ESPERA_ABRIR_MS) === 'ABRIR' && d(false, ESPERA_ABRIR_MS) === 'ABRIR',
     'três ABRIR seguidos sem a tela aparecer aberta');
  ok(d(false, ESPERA_ABRIR_MS) === 'DESISTIU', 'o quarto vira DESISTIU (não enche a tela de janelas se a detecção falhar)');
  ok(d(false, 60 * MIN) === 'DESISTIU', 'DESISTIU não passa sozinho com o tempo');
  ok(/nunca apareceu aberta/.test(String(resumoTela(t, e).alerta)), 'healthcheck mostra o alerta da detecção');
  ok(d(true, 1000) === 'ABERTA' && d(false, ESPERA_ABRIR_MS) === 'ABRIR', 'tela aberta de novo zera o freio');
  e = novoEstado();
  d(false); d(false, ESPERA_ABRIR_MS); d(false, ESPERA_ABRIR_MS); d(false, ESPERA_ABRIR_MS);
  liberar(e);
  ok(d(false, 1000) === 'ABRIR', 'INICIAR aberto à mão (liberar) tira o DESISTIU');

  e = novoEstado();
  ok(PAUSA_MS === 10 * MIN, 'pausa do "Fechar agora" = 10 min');
  pausar(t, e);
  ok(d(false, 1 * MIN) === 'PAUSADA', '"Fechar agora": 1 min depois a tela continua fechada (PAUSADA)');
  ok(d(false, 8 * MIN + 59 * 1000) === 'PAUSADA', '9 min 59 s depois: ainda PAUSADA');
  ok(resumoTela(t, e).pausada_ate !== null, 'healthcheck mostra até quando está pausada');
  ok(d(false, 2000) === 'ABRIR', 'passados 10 min: a tela volta sozinha (ABRIR)');
  e = novoEstado();
  pausar(t, e);
  liberar(e);
  ok(d(false, 1000) === 'ABRIR', 'INICIAR aberto à mão durante a pausa: abre já');
  e = novoEstado();
  pausar(t, e);
  const c1 = d(true, 500), c2 = d(false, 2000), c3 = d(false, 5000);
  ok(c1 === 'ABERTA' && c2 === 'PAUSADA' && c3 === 'PAUSADA',
     'vigia pergunta antes do taskkill do "Fechar agora" (tela ainda aberta): a pausa NÃO cai', `(${c1}, ${c2}, ${c3})`);
  e = novoEstado();
  pausar(t, e);
  ok(d(true, tela.PAUSA_FIRME_MS + 1000) === 'ABERTA' && d(false, ESPERA_ABRIR_MS) === 'ABRIR',
     'alguém abriu a tela durante a pausa (depois dos 15 s): a pausa acaba (fechar pelo X faz voltar)');
  const r = resumoTela(t + 7000, e);
  ok(r.vigia && r.vigia.sessao === '1' && r.vigia.tela_aberta === false && r.vigia.visto_ha_s === 7,
     'healthcheck mostra a sessão do vigia, se a tela está aberta e quando ele foi visto', JSON.stringify(r.vigia));

  const req = ip => ({ socket: { remoteAddress: ip } });
  ok(ehLocal(req('127.0.0.1')) && ehLocal(req('::1')) && ehLocal(req('::ffff:127.0.0.1')), 'própria máquina: aceita');
  ok(!ehLocal(req('192.168.3.25')) && !ehLocal(req('::ffff:192.168.3.25')) && !ehLocal(req('')) && !ehLocal({}),
     'celular pela rede: recusa (não fecha a tela do monitor)');
}

// ─── B) servidor real ───
async function subirServidor() {
  servidor = spawn(process.execPath, [SERVER], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB), EKO_PORT_HTTPS: String(PORT_TLS),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, EKO_TOKEN_FILE: TMP_DB + '_tokens.json',
           TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1', EKO_FECHAR_TELA_SIMULAR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', x => { if (process.env.VERBOSE) process.stderr.write(x); });
  servidor.on('exit', c => { servidor._saiu = c === null ? 'sinal' : c; });
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return; } catch (e) {}
    await sleep(200);
  }
  throw new Error('Servidor não subiu em 15s');
}

async function texto(caminho, metodo = 'GET') {
  const r = await fetch(BASE + caminho, { method: metodo });
  return { status: r.status, tipo: r.headers.get('content-type') || '', corpo: (await r.text()).trim() };
}

async function testeServidor() {
  console.log('\n[B] servidor real: "Fechar agora" fecha só a tela');
  if (fs.existsSync(FLAG)) throw new Error('ABORTADO: eko-encerrar.flag já existe na pasta (não apago o que não é do teste)');
  const r = await fetch(BASE + '/sistema/encerrar', { method: 'POST' });
  const d = await r.json().catch(() => null);
  ok(r.ok && d && d.encerrando === true, 'POST /sistema/encerrar responde');
  ok(d && d.servidor === 'continua ligado', 'resposta diz que o servidor continua ligado', JSON.stringify(d));
  await sleep(1500);   // o código antigo saía em 200 + 700 ms
  let vivo = false;
  try { vivo = (await fetch(BASE + '/healthcheck')).ok; } catch (e) {}
  ok(vivo && servidor._saiu === undefined, 'servidor continua respondendo depois do "Fechar agora"', `(saiu: ${servidor._saiu})`);
  const flag = fs.existsSync(FLAG);
  if (flag) { try { fs.rmSync(FLAG); } catch (e) {} }
  ok(!flag, 'não grava eko-encerrar.flag (o INICIAR.bat antigo pararia de vez)');

  console.log('\n[B] servidor real: o vigia pergunta');
  let t = await texto('/sistema/tela?s=1&a=0');
  ok(t.status === 200 && /^text\/plain/.test(t.tipo), 'GET /sistema/tela responde texto puro (quem lê é o vigia)', `(${t.status} ${t.tipo})`);
  ok(t.corpo === 'PAUSADA', 'depois do "Fechar agora": PAUSADA', `(veio ${t.corpo.slice(0, 40)})`);
  const a = await texto('/sistema/tela/abrir', 'POST');
  ok(a.status === 200, 'POST /sistema/tela/abrir (INICIAR aberto à mão)');
  t = await texto('/sistema/tela?s=1&a=0');
  ok(t.corpo === 'ABRIR', 'depois do INICIAR à mão: ABRIR', `(veio ${t.corpo.slice(0, 40)})`);
  t = await texto('/sistema/tela?s=1&a=0');
  ok(t.corpo === 'AGUARDAR', 'pergunta de novo logo em seguida: AGUARDAR (não abre duas janelas)', `(veio ${t.corpo.slice(0, 40)})`);
  t = await texto('/sistema/tela?s=1&a=1');
  ok(t.corpo === 'ABERTA', 'tela aberta: ABERTA', `(veio ${t.corpo.slice(0, 40)})`);
  const h = await (await fetch(BASE + '/healthcheck')).json();
  ok(h.tela && h.tela.vigia && h.tela.vigia.sessao === '1' && h.tela.vigia.tela_aberta === true,
     '/healthcheck mostra o vigia da sessão 1 com a tela aberta', JSON.stringify(h.tela));
}

// ─── C) INICIAR.bat por leitura ───
// Sem os comentários (REM e ::): o que o cmd executa.
function linhasDeCodigo(txt) {
  return txt.replace(/\r\n/g, '\n').split('\n')
    .map(l => l.trim()).filter(l => l && !/^rem(\s|$)/i.test(l) && !/^::/.test(l));
}

function testeIniciar() {
  console.log('\n[C] INICIAR.bat (conferência por LEITURA: o .bat não roda aqui)');
  const bin = comoNoMiniPc('INICIAR.bat');
  const txt = bin.toString('latin1');
  const cod = linhasDeCodigo(txt);

  // 1. Passagem. O INICIAR.bat de hoje no Mini PC (main 4ddca84, sha256
  // f703e34f…94b1 com CRLF) roda "git merge --ff-only origin/main" numa
  // linha sozinha, que termina no byte 4115. Depois do merge o cmd lê o
  // arquivo NOVO a partir desse byte. O que ele achar ali tem de levar ao
  // fim da atualização; uma folga de ±800 bytes cobre outra versão próxima.
  const POS_ANTIGA = 4115;
  const ALVO = 'goto atualizar_pos_merge';
  // O cmd termina a linha no LF e descarta o CR: cair em cima do LF dá
  // uma linha vazia, cair no meio dá um pedaço da linha.
  const lerDaqui = pos => {
    const [pedaco, seguinte] = bin.subarray(pos).toString('latin1').split('\n', 2).map(l => l.replace(/\r/g, ''));
    return { pedaco, seguinte };
  };
  const seguro = ({ pedaco, seguinte }) => ALVO.endsWith(pedaco) && seguinte === ALVO;
  ok(seguro(lerDaqui(POS_ANTIGA)), 'INICIAR antigo, ao trocar de arquivo no meio da atualização: o resto de linha dá "não reconhecido" e a linha seguinte é "goto atualizar_pos_merge"',
     JSON.stringify(lerDaqui(POS_ANTIGA)));
  let ruins = 0;
  for (let p = POS_ANTIGA - 800; p <= POS_ANTIGA + 800; p++) if (!seguro(lerDaqui(p))) ruins++;
  ok(ruins === 0, 'qualquer byte a ±800 da posição antiga também cai no goto (pedaço de linha não vira comando perigoso)', `(${ruins} posições ruins)`);
  // Se o histórico estiver aqui, confere a posição no próprio arquivo antigo.
  try {
    const { execFileSync } = require('node:child_process');
    const antigo = execFileSync('git', ['-C', ROOT, 'show', '4ddca84:INICIAR.bat'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('latin1').replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const i = antigo.indexOf('git merge --ff-only origin/main');
    ok(antigo.indexOf('\r\n', i) + 2 === POS_ANTIGA, 'posição 4115 conferida no INICIAR.bat de 4ddca84');
  } catch (e) { console.log('  (sem o histórico 4ddca84 aqui: posição conferida só pela constante)'); }
  const iBloco = txt.indexOf('\r\n' + ALVO + '\r\n'), iInicio = txt.indexOf('\r\n:inicio\r\n');
  const antesDoBloco = linhasDeCodigo(txt.slice(0, iBloco));
  ok(iBloco > 0 && iBloco < iInicio && antesDoBloco[antesDoBloco.length - 1] === 'goto inicio',
     'o bloco de passagem fica depois de "goto inicio": a partida normal não passa por ele');

  // 2. Rótulos: todo goto/call aponta para um rótulo que existe.
  const rotulos = new Set(cod.filter(l => /^:\w/.test(l)).map(l => l.slice(1).split(/\s/)[0].toLowerCase()));
  const alvos = [];
  for (const l of cod) for (const m of l.matchAll(/\b(?:goto\s+:?|call\s+:)([\w]+)/gi)) alvos.push(m[1].toLowerCase());
  const faltam = [...new Set(alvos.filter(a => a !== 'eof' && !rotulos.has(a)))];
  ok(alvos.length > 10 && faltam.length === 0, 'todo goto/call do INICIAR.bat tem rótulo', `(faltam: ${faltam.join(', ')})`);
  for (const r of ['loop', 'atualizar', 'atualizar_fim', 'oculto', 'autostart'])
    ok(rotulos.has(r), `rótulo :${r} continua existindo (o INICIAR antigo e a atualização remota usam)`);

  // 3. Parênteses equilibrados fora de aspas (bloco aberto = .bat quebrado).
  let saldo = 0, minimo = 0;
  for (const l of cod) {
    const semAspas = l.replace(/"[^"]*"/g, '""').replace(/\^[()]/g, '');
    for (const c of semAspas) { if (c === '(') saldo++; if (c === ')') { saldo--; minimo = Math.min(minimo, saldo); } }
  }
  ok(saldo === 0 && minimo === 0, 'parênteses equilibrados no INICIAR.bat', `(saldo ${saldo}, mínimo ${minimo})`);

  // 4. O .bat não abre navegador nenhum: só o vigia, na sessão do monitor.
  ok(!cod.some(l => /--app=|chrome\.exe"?\s+--|msedge\.exe"?\s+--|start\s+""\s+"%(CHROME|EDGE)%"/i.test(l)),
     'INICIAR.bat não abre navegador (na sessão 0 ele abriria invisível)');
  ok(!cod.some(l => /^start\s+""\s+"%?URL%?"/i.test(l)), 'nem o navegador padrão');
  ok(cod.some(l => /tela-vigia\.ps1/.test(l) && /-WindowStyle Hidden/.test(l)), 'INICIAR.bat sobe o vigia oculto (tela-vigia.ps1)');

  // 5. eko-encerrar.flag não desliga mais nada.
  const comFlag = cod.filter(l => /eko-encerrar\.flag/i.test(l));
  ok(comFlag.length > 0 && comFlag.every(l => /^if exist "eko-encerrar\.flag" del "eko-encerrar\.flag" >nul 2>&1$/i.test(l)),
     'eko-encerrar.flag só é apagada, nunca para o laço', JSON.stringify(comFlag));
  const iLoop = cod.indexOf(':loop'), iNode = cod.indexOf('node server.js');
  ok(iLoop >= 0 && iNode > iLoop && cod.slice(iNode, iNode + 6).every(l => !/^exit\b/i.test(l)),
     'depois do node server.js não há "exit" antes de religar');

  // 6. taskkill do navegador só quando há vigia para reabrir.
  const iFecha = cod.indexOf(':atualizar_fecha_tela'), iSobe = cod.indexOf(':atualizar_sobe');
  const kills = cod.map((l, i) => [l, i]).filter(([l]) => /taskkill/i.test(l));
  ok(kills.length > 0 && kills.every(([, i]) => i > iFecha && i < iSobe), 'taskkill do navegador só no ramo "o vigia está ativo"');
  const iFim = cod.indexOf(':atualizar_fim');
  const mutex = cod.slice(iFim, iFecha).find(l => /Mutex\]::OpenExisting\('Global\\EkoplasticTelaVigia'\)/.test(l));
  ok(!!mutex && cod.slice(iFim, iFecha).some(l => /^if "%errorlevel%"=="7" goto atualizar_fecha_tela$/i.test(l)),
     'antes do taskkill, confere o mutex do vigia (erro do PowerShell = não fecha a tela)');
  // O INICIAR antigo chega em :atualizar_fim pela passagem, sem ter lido o
  // começo do arquivo novo: tudo que é usado dali para frente tem padrão.
  const iMutexLinha = cod.indexOf(mutex);
  const padroes = cod.slice(iFim, iMutexLinha).join('\n');
  ok(['LOGA', 'URL', 'PS', 'EKO_SERIAL_PORT'].every(v => new RegExp(`^if not defined ${v} set "?${v}=`, 'm').test(padroes)),
     ':atualizar_fim define LOGA, URL, PS e EKO_SERIAL_PORT se faltarem (INICIAR antigo)');

  // 7. merge e goto na mesma linha: daqui para frente a troca do arquivo não importa.
  const merge = cod.filter(l => /git merge --ff-only origin\/main/.test(l));
  ok(merge.length === 1 && /&& goto atualizar_pos_merge \|\| goto atualizar_merge_falhou$/.test(merge[0]),
     'git merge e o goto na MESMA linha', JSON.stringify(merge));

  // 8. Vigia não sobe outro servidor no meio da atualização.
  const iAtu = cod.indexOf(':atualizar');
  ok(cod.slice(iAtu, iAtu + 3).some(l => /> "%~dp0eko-atualizando\.flag"/.test(l)) &&
     cod.slice(iSobe, iSobe + 2).some(l => /del "%~dp0eko-atualizando\.flag"/.test(l)),
     'atualização grava eko-atualizando.flag no começo e apaga no fim');

  // 9. Servidor já respondendo: o laço não sobe um segundo.
  ok(/curl -s -o nul -m 3 %URL%\/healthcheck/.test(cod[iLoop + 1]) && /^if not errorlevel 1 \($/.test(cod[iLoop + 2]),
     'o laço confere se já há servidor antes de subir o node');
  ok(/^\*\.bat\s+text eol=crlf$/m.test(ler('.gitattributes')) && /^\*\.ps1\s+text eol=crlf$/m.test(ler('.gitattributes')),
     '.bat e .ps1 saem com CRLF no Mini PC (.gitattributes)');
}

// ─── D) vigia e ATUALIZAR.bat por leitura ───
function testeVigia() {
  console.log('\n[D] tela-vigia.ps1 e ATUALIZAR.bat (conferência por LEITURA)');
  let ps;
  try { ps = ler('tela-vigia.ps1'); } catch (e) { ok(false, 'tela-vigia.ps1 existe'); return; }
  ok(!/[^\x00-\x7f]/.test(ps), 'tela-vigia.ps1 só em ASCII (PowerShell 5.1 lê .ps1 sem BOM como ANSI)');
  const iSessao0 = ps.indexOf('if ($Sessao -eq 0)'), iMutex = ps.indexOf("New-Object System.Threading.Mutex($true, 'Global\\EkoplasticTelaVigia'");
  ok(iSessao0 > 0 && iMutex > iSessao0, 'vigia sai na sessão 0 antes de tudo, e é um só (mutex Global\\EkoplasticTelaVigia)');
  ok(ps.includes('("/sistema/tela?s=$Sessao&a=$a")'), 'vigia pergunta na rota que o servidor atende');
  const palavras = ['ABRIR', 'PAUSADA', 'DESISTIU'];
  const lib = ler('lib/tela.js');
  ok(palavras.every(p => ps.includes(`'${p}'`) && lib.includes(`'${p}'`)), 'as palavras do vigia são as do servidor');
  ok(/if \(\$r\.texto -eq 'ABRIR'\) \{ AbrirTela \}/.test(ps) && (ps.match(/AbrirTela\b/g) || []).length === 2,
     'vigia só abre a tela quando o servidor manda ABRIR');
  ok(/Start-Sleep -Seconds \$espera/.test(ps) && /\$espera = 5/.test(ps), 'laço do vigia dorme 5 s entre as conferências');
  ok(/--user-data-dir=/.test(ps) && ps.includes("'navegador-eko'"), 'tela abre no perfil do quiosque (navegador-eko), o que deixa saber se está aberta');
  ok(ps.includes("'eko-atualizando.flag', 'eko-manutencao.flag'") && /TotalMinutes -lt 15/.test(ps),
     'vigia respeita atualização e manutenção, por no máximo 15 min');
  ok(/\$falhas -ge 6/.test(ps) && /node\.exe/.test(ps) && /INICIAR\\\.bat/.test(ps), 'vigia só sobe servidor após 30 s e sem node/INICIAR vivos');
  ok(ps.includes("'\" servidor\"'") || ps.includes("'\" servidor\"')"), 'vigia sobe "INICIAR.bat servidor"');
  ok(/\$pais -contains \$_\.ProcessId/.test(ps) && /CreationDate\)\.TotalMinutes -lt 3/.test(ps),
     'janela do INICIAR parada (sem node, velha) não conta como "alguém cuidando"');
  ok(/\$Mutex\.WaitOne\(15000\)/.test(ps) && /function TrocarDeVersao/.test(ps) && /if \(\$porMinuto\) \{ TrocarDeVersao \}/.test(ps),
     'vigia troca de versão sozinho depois da atualização (o novo espera o mutex do antigo)');
  ok(/KioskNaSessao 0/.test(ps) && /\$aberta = TelaAberta \$porMinuto/.test(ps),
     'uma vez por minuto confere que a tela está NESTA sessão; tela presa na sessão 0 é fechada');
  const abrirTela = linhasDeCodigo(ler('ABRIR-TELA.bat'));
  ok(!abrirTela.some(l => /chrome|msedge|--app=|^start\s/i.test(l)) && abrirTela.includes('call "%~dp0INICIAR.bat" abrir'),
     'ABRIR-TELA.bat não abre navegador: pede a tela ao vigia (INICIAR.bat abrir)');

  const at = ler('ATUALIZAR.bat');
  const atCod = linhasDeCodigo(at);
  ok(atCod.includes('set "MANUT=%~dp0eko-manutencao.flag"') && atCod.some(l => /^> "%MANUT%" echo/.test(l)),
     'ATUALIZAR.bat grava eko-manutencao.flag no começo');
  const iParar = atCod.indexOf(':parar');
  ok(iParar > 0 && atCod[iParar + 1] === 'del "%MANUT%" >nul 2>&1', 'ATUALIZAR.bat apaga a bandeira ao parar');
  const iStart = atCod.findIndex(l => /^start "Ekoplastic - Servidor de Etiquetas" cmd \/c ""%~dp0INICIAR\.bat""$/.test(l));
  ok(iStart > 0 && atCod[iStart - 1] === 'del "%MANUT%" >nul 2>&1',
     'ATUALIZAR.bat apaga a bandeira e sobe o INICIAR com cmd /c (janela cmd /K parada enganaria o vigia)');
  ok(!atCod.some(l => /^start\s+""\s+"%~dp0INICIAR\.bat"/i.test(l)), 'ATUALIZAR.bat não usa mais start "" INICIAR.bat (cmd /K)');
  // Toda saída do .bat (fora das sub-rotinas :copiar e :L, cujo exit /b só
  // volta): ou é a de :parar (que apaga), ou tem o del logo antes, ou é a do
  // sucesso (o del veio antes do start do INICIAR).
  const iCopiar = atCod.indexOf(':copiar'), iL = atCod.indexOf(':L');
  ok(iCopiar > 0 && iParar > iCopiar && iL > iParar, 'ATUALIZAR.bat: ordem :copiar, :parar, :L');
  const saidas = atCod.map((l, i) => [l, i]).filter(([l]) => /^exit\b/i.test(l)).map(([, i]) => i)
    .filter(i => !(i > iCopiar && i < iParar) && !(i > iL));
  const semDel = saidas.filter(i => !(i > iParar && i < iL) && !(i > iStart && i < iCopiar) &&
                                    !atCod.slice(Math.max(0, i - 4), i).includes('del "%MANUT%" >nul 2>&1'));
  ok(saidas.length >= 3 && semDel.length === 0, 'toda saída do ATUALIZAR.bat apaga a bandeira', `(sem del: linhas ${semDel.join(', ')})`);
  const iPause = atCod.indexOf('pause >nul');
  ok(iPause > 0 && atCod.slice(iPause, iPause + 6).some(l => /curl .*%URLSAUDE%/.test(l)),
     'depois da confirmação (pause sem prazo) confere de novo se o servidor voltou');
  const iEsp = atCod.indexOf(':esperar_parar');
  ok(iEsp > 0 && atCod.slice(iEsp, iEsp + 30).some(l => /if %_pare% GEQ 90/.test(l)), 'espera o servidor parar com teto de 3 min');

  const s = ler('public/seguranca-saida.js');
  ok(/O sistema continua ligado/.test(s) && /a tela volta sozinha/.test(s), 'painel de saída diz que o sistema continua ligado e a tela volta sozinha');
}

function encerrar() {
  try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm', TMP_DB + '_tokens.json']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
  try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch (e) {}
}

(async () => {
  try {
    testeDecisao();
    testeIniciar();
    testeVigia();
    await subirServidor();
    const h = await (await fetch(BASE + '/healthcheck')).json();
    if (!h || h.impressao_simulada_forcada !== true) throw new Error('ABORTADO: impressão não está travada em simulação');
    await testeServidor();
  } catch (e) {
    console.error('\nERRO FATAL:', e.message);
    falhou++;
  } finally {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passaram, ${falhou} falharam`);
    if (falhas.length) { console.log(' FALHAS:'); falhas.forEach(f => console.log('   - ' + f)); }
    console.log('═══════════════════════════════════════════════════');
    encerrar();
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
