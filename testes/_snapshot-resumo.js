// ════════════════════════════════════════════════════════════════════
//  FOTOGRAFIA DO EPL DO RESUMO  (ferramenta de refatoração, não é gate)
//  Sobe o server.js REAL, produz um resumo de cada tipo e grava o EPL
//  gerado, normalizado (sem data/hora), num arquivo de referência.
//
//  Uso:  node testes/_snapshot-resumo.js  <arquivo-de-saida.txt>
//
//  Serve para provar, byte a byte, que uma refatoração do layout do
//  resumo NÃO mudou uma vírgula do que sai na impressora.
// ════════════════════════════════════════════════════════════════════

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT   = path.join(__dirname, '..');
const SERVER = path.join(ROOT, 'server.js');
const PORT   = 13930;
const PORT_CB= 18930;
const BASE   = `http://localhost:${PORT}`;
const CARIMBO = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_snap_${CARIMBO}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_snap_logs_${CARIMBO}`);
const SAIDA    = process.argv[2] || path.join(os.tmpdir(), `snapshot_resumo_${CARIMBO}.txt`);

let servidor;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function req(metodo, caminho, corpo) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: corpo ? { 'Content-Type': 'application/json' } : {},
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  let json = null; try { json = await r.json(); } catch(e) {}
  return { status: r.status, json };
}

async function subir() {
  servidor = spawn('node', [SERVER], {
    env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
           EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  servidor.stdout.on('data', () => {});
  servidor.stderr.on('data', d => { if (process.env.VERBOSE) process.stderr.write(d); });
  for (let i = 0; i < 75; i++) {
    try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) return; } catch(e) {}
    await sleep(200);
  }
  throw new Error('Servidor não subiu em 15s');
}

function encerrar() {
  try { servidor && servidor.kill('SIGKILL'); } catch(e) {}
  for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch(e) {} }
  try { fs.rmSync(TMP_LOGS, { recursive: true, force: true }); } catch(e) {}
}

// ── Cenários: um resumo de cada tipo que usa o layout genérico ──
async function cenarioExtrusao() {
  const s = await req('POST', '/sessoes', { tipo: 'extrusao', operador: 'Snap', maquina: 'C1', turno_codigo: 'EXT-A1' });
  const sid = s.json.sessao_id;
  for (let i = 0; i < 3; i++) {
    const r = await req('POST', '/etiquetas/extrusao', {
      clientToken: 'sx-' + i, sessao_id: sid, cor: i === 2 ? 'Branca' : 'Preta',
      tipo_bobina: 'LEVE', largura: '1,60', operador: 'Snap',
      maquina: i === 1 ? 'C2' : 'C1', turno_codigo: 'EXT-A1',
      peso: 100 + i, peso_bruto: 108 + i, tara: 8,
    });
    await req('POST', `/etiquetas/${r.json.id}/bipar`);
  }
  const c = await req('POST', '/etiquetas/capa', {
    clientToken: 'sx-capa', sessao_id: sid, capa_sku: 'CAPA.70X90', peso: 42.5, maquina: 'C1',
  });
  await req('POST', `/etiquetas/${c.json.id}/bipar`);
  await req('POST', `/sessoes/${sid}/finalizar`);
}

async function cenarioRecebimento(tipo) {
  const s = await req('POST', '/sessoes', { tipo, operador: 'Snap', fornecedor: 'Cedro' });
  const sid = s.json.sessao_id;
  const ids = [];
  for (let i = 0; i < 3; i++) {
    const r = await req('POST', '/etiquetas', {
      clientToken: `s${tipo}-${i}`, tipo, materialKey: i === 2 ? 'GAD' : 'GBD',
      materialNomeEt: i === 2 ? 'ALTA DENSIDADE' : 'BAIXA DENSIDADE',
      cor: 'Canela', fornecedor: 'Cedro', peso: 1000 + i, lote: 'L1', codigo: 'CAN1',
      sku: 'GBD.CAN.CED | 1000 | LL1', sessao_id: sid,
    });
    ids.push(r.json.id);
    await req('POST', `/etiquetas/${r.json.id}/bipar`);
  }
  await req('POST', `/sessoes/${sid}/finalizar`);
  return ids;
}

async function cenarioRetirada(origIds) {
  const s = await req('POST', '/sessoes', { tipo: 'retirada', operador: 'Snap' });
  const sid = s.json.sessao_id;
  for (const oid of origIds) await req('POST', `/etiquetas/${oid}/consumir`, { sessao_id: sid });
  await req('POST', '/retirada/aditivo', {
    sessao_id: sid, materialKey: 'PIG', cor: 'Azul', fornecedor: 'Cromex', qtd_sacos: 2,
  });
  await req('POST', `/sessoes/${sid}/finalizar`);
}

async function cenarioOutras() {
  const s = await req('POST', '/sessoes', { tipo: 'outras', operador: 'Snap' });
  const sid = s.json.sessao_id;
  const itens = ['APARA.AMARELA', 'APARA.PRETA', 'RES.BORRA'];
  for (let i = 0; i < itens.length; i++) {
    const r = await req('POST', '/etiquetas/outras', {
      clientToken: 'so-' + i, sessao_id: sid, item_codigo: itens[i], peso: 30 + i,
    });
    await req('POST', `/etiquetas/${r.json.id}/bipar`);
  }
  await req('POST', `/sessoes/${sid}/finalizar`);
}

// ── Coleta e normalização ──
// A linha de data/hora e o "Pag x/y" carregam o relógio; a data some da
// comparação, o Pag fica (é layout). Também some o número da sessão, que
// muda conforme a ordem em que os cenários rodam.
function coletar() {
  const dir = path.join(TMP_LOGS, 'print-simulado');
  if (!fs.existsSync(dir)) return [];
  const blocos = [];
  for (const f of fs.readdirSync(dir).sort()) {
    const txt = fs.readFileSync(path.join(dir, f), 'latin1');
    if (!/A30,24,0,4,1,1,N,"RESUMO/.test(txt)) continue;
    blocos.push(txt
      .replace(/A30,120,0,2,1,1,N,"[\d/]+ [\d:]+ +(Pag \d+\/\d+)"/g, 'A30,120,0,2,1,1,N,"<DATA>   $1"')
      .replace(/\d{2}:\d{2}/g, '<HH:MM>'));
  }
  return blocos.sort();
}

(async () => {
  try {
    await subir();
    await cenarioExtrusao();
    const idsReceb = await cenarioRecebimento('recebimento');
    await cenarioRecebimento('retorno');
    await cenarioRetirada(idsReceb);
    await cenarioOutras();
    await sleep(400);                       // deixa a impressão simulada assentar
    const blocos = coletar();
    fs.writeFileSync(SAIDA, blocos.join('\n=====================\n'), 'utf8');
    console.log(`${blocos.length} resumo(s) capturado(s) → ${SAIDA}`);
    // Desde 01/09/2026 só extrusão e recebimento imprimem ao finalizar — os
    // outros três acumulam no resumo do dia. Então 2 é o esperado aqui; se
    // vier menos, alguma coisa parou de imprimir e isso É um problema.
    if (blocos.length < 2) { console.error('ATENCAO: esperava ao menos 2 resumos (extrusao e recebimento)'); process.exitCode = 2; }
  } catch (e) {
    console.error('ERRO:', e.message);
    process.exitCode = 1;
  } finally {
    encerrar();
    setTimeout(() => process.exit(process.exitCode || 0), 200);
  }
})();
