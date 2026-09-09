// ════════════════════════════════════════════════════════════════════
//  LEITURA DA GUIA DE SEPARAÇÃO EM PDF
//  ------------------------------------------------------------------
//  O PDF da guia tem camada de texto. A tela extrai as linhas com o
//  pdf.js e o servidor as interpreta. Este teste exercita o servidor:
//  dá as linhas e confere que sai a carga certa.
//
//  O que mais importa aqui é a coluna EDITADO. Usar a ORIGINAL mandaria
//  separar o que o cliente não vai levar — e ninguém perceberia até o
//  caminhão estar carregado errado.
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13907, PORT_CB = 18907;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_gp_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_gp_${C}`);
const TMP_GUIA = path.join(os.tmpdir(), `eko_gpg_${C}`);

let passou = 0, falhou = 0, servidor;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 400)); }
}
async function req(metodo, rota, corpo) {
  const opc = { method: metodo, headers: {} };
  if (corpo !== undefined) { opc.body = JSON.stringify(corpo); opc.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(BASE + rota, opc);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

// As linhas como o pdf.js as entrega: cada altura da página vira uma
// linha, os pedaços juntados pela ordem horizontal.
const GUIA = [
  'PEDIDOS DA SELECAO',
  'TOTAL EDITADO: 7.700 kg',
  '',
  'ILHA PLASTIC COMERCIO ATACADISTA DE EMBALAGENS LTDA',
  'Teresina - PI',
  'FORMATO PRODUTO ORIGINAL EDITADO',
  'BRANCA',
  'TAMANHO: 50x60 800 750',
  'TAMANHO: 40x50 300 250',
  'PRETA',
  'TAMANHO: 40x50 500 500',
  '',
  'EMBALO EMBALAGENS EIRELI',
  'Parnaiba - PI',
  'FORMATO PRODUTO ORIGINAL EDITADO',
  'COLORIDA',
  'TAMANHO: 30x40 1.200 1.000',
  'TAMANHO: 60x80 250 200',
  '',
  'A C M DA SILVA COMERCIO - ME',
  'Timon - MA',
  'FORMATO PRODUTO ORIGINAL EDITADO',
  'AMARELA',
  'TAMANHO: 30x45 500 500',
  'BRANCA',
  'TAMANHO: 80x100 100 100',
];

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' GUIA DE SEPARAÇÃO EM PDF — Ekoplastic');
    console.log('═══════════════════════════════════════════════════\n');
    servidor = spawn('node', [path.join(ROOT, 'server.js')], {
      env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
             EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, EKO_GUIAS_DIR: TMP_GUIA,
             TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    servidor.stdout.on('data', () => {});
    for (let i = 0; i < 75; i++) {
      try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) break; } catch (e) {}
      await sleep(200);
    }

    // ── [1] A LEITURA ───────────────────────────────────────────────
    console.log('[1] A guia inteira é lida do PDF, sem ninguém digitar');
    const pv = await req('POST', '/separacao/guia/previa', { linhas: GUIA });
    ok(pv.status === 200 && pv.body.pedidos.length === 3,
       `os 3 clientes da guia foram reconhecidos: ${pv.body.pedidos.length}`, pv.body);
    const p = pv.body.pedidos;
    ok(p[0].cliente.startsWith('ILHA PLASTIC'), `o nome sai inteiro: "${p[0].cliente}"`);
    ok(p[0].cidade === 'Teresina' && p[0].uf === 'PI', `cidade e UF: ${p[0].cidade}/${p[0].uf}`);
    ok(p[2].cliente === 'A C M DA SILVA COMERCIO - ME',
       'nome com hífen não é confundido com cidade');

    // ── [2] A COLUNA QUE VALE É A EDITADO ───────────────────────────
    console.log('\n[2] Vale a coluna EDITADO — a ORIGINAL é histórico');
    const i0 = p[0].itens[0];
    ok(i0.kg === 750, `50x60 BRANCA: leu 750 (EDITADO), não 800 (ORIGINAL): ${i0.kg}`);
    ok(i0.fardos === 30, `e converteu para 30 fardos de 25 kg: ${i0.fardos}`);
    const rec = p[1].itens[0];
    ok(rec.kg === 1000, `número com ponto de milhar: "1.200 1.000" → ${rec.kg}`);
    ok(pv.body.total_kg === 750 + 250 + 500 + 1000 + 200 + 500 + 100,
       `total confere com a guia: ${pv.body.total_kg} kg`);

    // ── [3] CORES E FORMATOS DO GALPÃO ──────────────────────────────
    console.log('\n[3] As cores da guia viram as chaves do galpão');
    ok(p[0].itens[0].cor_key === 'BC' && p[0].itens[2].cor_key === 'PT',
       'BRANCA→BC e PRETA→PT, com a cor valendo até a próxima');
    ok(p[1].itens[0].cor_key === 'REC', 'COLORIDA→REC');
    ok(p[2].itens[0].cor_key === 'AM' && p[2].itens[1].cor_key === 'BC',
       'AMARELA→AM e a BRANCA seguinte troca a cor corrente');
    ok(p[2].itens[1].formato === '80x100', 'formato de 3 dígitos (80x100) é lido certo');

    // ── [4] O QUE NÃO FOR ENTENDIDO NÃO SOME ────────────────────────
    console.log('\n[4] Linha não entendida é reportada, nunca descartada calada');
    const estranho = await req('POST', '/separacao/guia/previa', { linhas: [
      'CLIENTE TESTE LTDA', 'Teresina - PI', 'FORMATO PRODUTO ORIGINAL EDITADO',
      'BRANCA', 'TAMANHO: 50x60 800 750',
      'TAMANHO: 90x90 100 100',          // formato que a fábrica não faz
      'VERDE', 'TAMANHO: 30x40 200 200', // cor que não existe no galpão
    ]});
    const av = estranho.body.avisos;
    // três: o formato que a fábrica não faz, o cabeçalho VERDE, e o item
    // que ficou órfão de cor por causa dele.
    ok(av.length === 3, `as três linhas problemáticas foram reportadas: ${av.length}`, av);
    ok(av.every(a => a.cliente === 'CLIENTE TESTE LTDA'),
       'cada aviso diz de qual cliente é', av.map(a => a.cliente));
    ok(av.some(a => /cor "VERDE" não existe/.test(a.motivo)),
       'a cor desconhecida NÃO herda a anterior — seria produto errado no caminhão');
    ok(av.some(a => /90x90/.test(a.linha) && /não é do galpão/.test(a.motivo)),
       'formato que a fábrica não produz é apontado');
    ok(av.some(a => /30x40/.test(a.linha)), 'cor desconhecida também é apontada');
    ok(estranho.body.pedidos[0].itens.length === 1,
       'e só o item bom entra na carga — não entra lixo');

    // ── [5] PDF SEM TEXTO É RECUSADO COM CLAREZA ────────────────────
    console.log('\n[5] PDF que é imagem digitalizada é recusado explicando');
    const vazio = await req('POST', '/separacao/de-guia', { linhas: [] });
    ok(vazio.status === 400 && /imagem/.test(vazio.body.erro || ''),
       'diz que o PDF pode ser imagem em vez de dar erro genérico', vazio.body);
    const semAncora = await req('POST', '/separacao/de-guia', { linhas: ['bla', 'ble', 'bli'] });
    ok(semAncora.status === 422 && /FORMATO/.test(semAncora.body.erro || ''),
       'e diz qual cabeçalho procurou quando não achou nada', semAncora.body);

    // ── [6] DA GUIA AO PLANO, DIRETO ────────────────────────────────
    console.log('\n[6] Da guia ao plano de coleta, sem passo manual');
    const cri = await req('POST', '/separacao/de-guia', { linhas: GUIA, operador: 'FREDERICO' });
    ok(cri.status === 200 && cri.body.id, 'a carga nasceu do PDF', cri.body);
    const SEP = cri.body.id;
    ok(cri.body.status === 'conferida', 'já nasce conferida — o dado veio do documento');

    const est = await req('GET', `/separacao/${SEP}`);
    ok(est.body.pedidos.length === 3, 'três pedidos gravados');
    ok(est.body.pedidos[0].ordem === 1 && est.body.pedidos[0].cliente.startsWith('ILHA'),
       'a ordem de carregamento nasce igual à da guia — e dá para mudar depois');
    const totalFardos = est.body.pedidos.reduce(
      (a, x) => a + x.itens.reduce((s, i) => s + i.fardos, 0), 0);
    ok(totalFardos === 30 + 10 + 20 + 40 + 8 + 20 + 4, `total em fardos: ${totalFardos}`);

    // estoque parcial: o plano tem que sair mesmo faltando produção
    const g = await req('POST', '/produto-acabado/etiqueta-gaiola',
                        { corKey: 'BC', formato: '50x60', fardos: 30, tipo_gaiola: 'GRANDE' });
    await req('POST', '/enderecamento/ocupar',
              { posicao: '01-01-001', gaiola_id: g.body.id, tipo_gaiola: 'GRANDE' });
    const pl = await req('POST', `/separacao/${SEP}/planejar`);
    ok(pl.status === 200 && pl.body.coletas.length === 1, 'plano gerado com o que existe');
    ok(pl.body.falta.fardos > 0, `e aponta o que ainda está em produção: ${pl.body.falta.fardos} fardos`);
    ok(pl.body.falta.por_item.length >= 3, 'dizendo de quais pedidos, um a um');

    // ── [7] O PDF FICA GUARDADO COMO COMPROVANTE ────────────────────
    console.log('\n[7] O PDF fica anexado à carga');
    const pdfBytes = fs.readFileSync(path.join(__dirname, 'dados', 'guia-exemplo.pdf'));
    const anex = await fetch(`${BASE}/separacao/${SEP}/guia`,
      { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: pdfBytes });
    const aj = await anex.json();
    ok(anex.status === 200 && /\.pdf$/.test(aj.arquivo || ''), `guardado como ${aj.arquivo}`, aj);
    const volta = await fetch(`${BASE}/separacao/${SEP}/guia`);
    ok(volta.status === 200 && String(volta.headers.get('content-type')).includes('pdf'),
       'e volta como PDF, para conferir depois');

  } catch (e) {
    falhou++;
    console.error('\n\x1b[31mERRO NO TESTE:\x1b[0m', e.stack || e.message);
  } finally {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(` RESULTADO: ${passou} passou, ${falhou} falhou`);
    console.log('═══════════════════════════════════════════════════\n');
    try { servidor && servidor.kill('SIGKILL'); } catch (e) {}
    for (const f of [TMP_DB, TMP_DB + '-wal', TMP_DB + '-shm']) { try { fs.rmSync(f, { force: true }); } catch (e) {} }
    for (const d of [TMP_LOGS, TMP_GUIA]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch (e) {} }
    setTimeout(() => process.exit(falhou ? 1 : 0), 200);
  }
})();
