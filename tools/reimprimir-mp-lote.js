// ════════════════════════════════════════════════════════════════════
//  TROCA DAS ETIQUETAS DE MP PELO LAYOUT NOVO — roda NO MINI PC (25/11/2026)
//
//  Lê as etiquetas R/T ainda no galpão (banco só leitura), separa por
//  fornecedor e, para cada grupo: imprime uma etiqueta de SEPARAÇÃO e depois
//  reimprime cada etiqueta pela rota do próprio servidor
//  (POST /etiquetas/<id>/reimprimir: mesmo número, data da pesagem, status
//  e Bling intocados). Uma de cada vez, esperando a impressora responder.
//
//  Uso (na pasta C:\Ekoplastic\pesagem):
//    node tools\reimprimir-mp-lote.js                       só lista os grupos (não imprime)
//    node tools\reimprimir-mp-lote.js --fornecedor "KARINA"  imprime só esse fornecedor
//    node tools\reimprimir-mp-lote.js --todos               imprime todos, grupo a grupo
//  Opções: --pausa <ms> entre etiquetas (padrão 400) · --servidor <url>
//
//  --arquivo <pasta>: NÃO imprime nem fala com servidor. Gera, com o mesmo
//  código da rota de reimpressão (dadosReimpressao + gerarEPL), um .epl por
//  fornecedor (separador + etiquetas) para mandar a OUTRA impressora (ex.: a
//  térmica do Arch). Use com EKO_DB_FILE apontando para uma CÓPIA do banco e
//  rodando de uma cópia do código: carregar as libs abre o banco e grava o
//  backup diário na pasta do código.
//
//  Repetir é seguro: reimprimir não cria etiqueta nem mexe em status; o
//  pior caso é sair uma cópia a mais do mesmo número.
// ════════════════════════════════════════════════════════════════════
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { agruparPorFornecedor, eplSeparador } = require('../lib/troca-etiquetas');

const RAIZ = path.join(__dirname, '..');
const arg = (nome, padrao) => { const i = process.argv.indexOf(nome); return i > 0 ? process.argv[i + 1] : padrao; };
const tem = nome => process.argv.includes(nome);

const SERVIDOR = arg('--servidor', 'http://localhost:3000');
const PAUSA    = Math.max(0, Number(arg('--pausa', 400)) || 0);
const SO_FORN  = arg('--fornecedor', null);
const TODOS    = tem('--todos');
const DB_FILE  = process.env.EKO_DB_FILE || path.join(RAIZ, 'etiquetas.db');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = v => String(v == null ? '' : v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

function lerEtiquetas() {
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  try {
    return db.prepare(`SELECT id, tipo, status, fornecedor, material_nome, cor, lote, peso
                         FROM etiquetas WHERE tipo IN ('recebimento','retorno') AND status = 'bipada'`).all();
  } finally { db.close(); }
}

async function nomeImpressora() {
  const r = await fetch(SERVIDOR + '/healthcheck', { signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  if (!j.printer || j.impressao_simulada) throw new Error(`impressora indisponível no servidor (${j.printer || 'sem nome'}${j.impressao_simulada ? ', simulada' : ''})`);
  return j.printer;
}

function imprimirSeparador(epl, impressora) {
  const arq = path.join(os.tmpdir(), `troca_sep_${Date.now()}.epl`);
  fs.writeFileSync(arq, epl, 'latin1');
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(RAIZ, 'enviar_raw.ps1'), '-EplFile', arq, '-PrinterName', impressora], { encoding: 'utf8', timeout: 60000 });
    if (r.status !== 0 || !/^OK/m.test(r.stdout || '')) throw new Error(`separador não imprimiu: ${(r.stderr || r.stdout || '').trim().slice(0, 200)}`);
  } finally { try { fs.unlinkSync(arq); } catch {} }
}

async function reimprimir(id) {
  const r = await fetch(`${SERVIDOR}/etiquetas/${id}/reimprimir`, { method: 'POST', signal: AbortSignal.timeout(60000) });
  let j = null; try { j = await r.json(); } catch {}
  if (r.status !== 200 || !j || !j.reimpresso) throw new Error(`${id}: ${(j && (j.erro || j.error)) || 'HTTP ' + r.status}`);
}

(async () => {
  const grupos = agruparPorFornecedor(lerEtiquetas());
  const total = grupos.reduce((s, g) => s + g.itens.length, 0);
  console.log(`\n${total} etiquetas de MP no galpão, ${grupos.length} fornecedores:\n`);
  grupos.forEach((g, i) => console.log(`  ${String(i + 1).padStart(2)}. ${g.fornecedor.padEnd(34)} ${String(g.itens.length).padStart(4)} etiq.  ${Math.round(g.kg).toLocaleString('pt-BR').padStart(9)} kg`));

  const escolhidos = TODOS ? grupos : SO_FORN ? grupos.filter(g => g.fornecedor === norm(SO_FORN)) : [];
  if (!escolhidos.length) {
    console.log(SO_FORN ? `\nFornecedor "${SO_FORN}" não está na lista. Nada impresso.` :
      '\nSó listei. Para imprimir: --fornecedor "NOME" (um grupo) ou --todos.');
    return;
  }
  const PASTA = arg('--arquivo', null);
  // "--arquivo" sem pasta não pode cair na impressão de verdade (revisor de 3547d1f).
  if (tem('--arquivo') && (!PASTA || PASTA.startsWith('--'))) {
    console.error('ERRO: --arquivo precisa da pasta de saída. Nada impresso.');
    process.exit(2);
  }
  if (PASTA) {
    // As libs abrem o banco em ESCRITA (migração de schema): só numa cópia.
    // Revisor de f742d0f: sem isto, no Mini PC abriria o etiquetas.db de
    // produção num segundo processo; apontado para o pesagem.db da VPS,
    // mudaria o schema dele.
    // Caminhos de produção FIXOS também: rodando de uma cópia do código, o
    // RAIZ é a cópia e o banco do Mini PC passaria (revisor de 3547d1f).
    const PASTA_PROD = 'c:\\ekoplastic\\pesagem';
    const prod = [path.join(RAIZ, 'etiquetas.db'), PASTA_PROD + '\\etiquetas.db',
                  path.join(os.homedir(), 'dados', 'pesagem', 'pesagem.db')]
      .map(p => path.resolve(p).toLowerCase().replace(/\//g, '\\'));
    const alvo = path.resolve(DB_FILE).toLowerCase().replace(/\//g, '\\');
    if (!process.env.EKO_DB_FILE || prod.includes(alvo)) {
      console.error('ERRO: --arquivo só roda com EKO_DB_FILE apontando para uma CÓPIA do banco do Mini PC.');
      process.exit(2);
    }
    // Carregar as libs grava backup diário e logs na pasta do código: na
    // pasta de produção, o backup do dia sairia da cópia e o servidor pularia o dele.
    if (path.resolve(RAIZ).toLowerCase().replace(/\//g, '\\') === PASTA_PROD) {
      console.error('ERRO: --arquivo roda de uma CÓPIA do código, não de C:\\Ekoplastic\\pesagem.');
      process.exit(2);
    }
    // Só aqui carrega as libs do servidor (abrem o banco): o modo normal no
    // Mini PC não abre o banco em escrita num segundo processo.
    const { dadosReimpressao } = require('../lib/negocio');
    const { gerarEPL } = require('../lib/impressao');
    const db = new DatabaseSync(DB_FILE, { readOnly: true });
    const ler = db.prepare('SELECT * FROM etiquetas WHERE id = ?');
    fs.mkdirSync(PASTA, { recursive: true });
    for (const g of escolhidos) {
      const n = grupos.indexOf(g) + 1;
      const partes = [eplSeparador(g, n, grupos.length)];
      for (const e of g.itens) {
        const reg = ler.get(e.id);
        partes.push(gerarEPL(dadosReimpressao({ ...reg, seq: reg.seq != null ? reg.seq : Number(reg.id.slice(1)) })));
      }
      const nome = `${String(n).padStart(2, '0')}-${g.fornecedor.replace(/[^A-Z0-9]+/g, '_')}.epl`;
      fs.writeFileSync(path.join(PASTA, nome), partes.join('\n'), 'latin1');
      console.log(`  ${nome}: separador + ${g.itens.length} etiquetas`);
    }
    db.close();
    process.exit(0);    // as libs deixam timers vivos
  }

  const impressora = await nomeImpressora();
  const falhas = [];
  for (const g of escolhidos) {
    const n = grupos.indexOf(g) + 1;
    console.log(`\n▶ ${g.fornecedor}: separador + ${g.itens.length} etiquetas`);
    imprimirSeparador(eplSeparador(g, n, grupos.length), impressora);
    for (const e of g.itens) {
      try { await reimprimir(e.id); process.stdout.write(`  ${e.id} ok\n`); }
      catch (x) { falhas.push(x.message); process.stdout.write(`  ${e.id} FALHOU: ${x.message}\n`); }
      await sleep(PAUSA);
    }
  }
  console.log(`\nFim: ${escolhidos.reduce((s, g) => s + g.itens.length, 0) - falhas.length} reimpressas, ${falhas.length} falhas.`);
  if (falhas.length) { falhas.forEach(f => console.log('  ✗ ' + f)); process.exitCode = 1; }
})().catch(e => { console.error('ERRO: ' + e.message); process.exitCode = 1; });
