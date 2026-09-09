// ════════════════════════════════════════════════════════════════════
//  SEPARAÇÃO E CARREGAMENTO — servidor real via HTTP
//  ------------------------------------------------------------------
//  Sobe o server.js de verdade com banco temporário e impressão
//  simulada, e percorre o ciclo inteiro:
//
//    foto da guia → conferência → ordem de carregamento → plano de
//    coleta → bipe (que é a BAIXA) → sobra → etiqueta nova →
//    endereçamento da sobra
//
//  O que mais importa aqui não é "a rota respondeu 200": é que o
//  ALOCADOR não mande separar errado. Instrução errada faz o galpão
//  inteiro andar para o lado errado, e ninguém percebe até faltar
//  produto no caminhão.
// ════════════════════════════════════════════════════════════════════
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs   = require('node:fs');
const os   = require('node:os');

const ROOT = path.join(__dirname, '..');
const PORT = 13905, PORT_CB = 18905;
const BASE = `http://localhost:${PORT}`;
const C = Date.now();
const TMP_DB   = path.join(os.tmpdir(), `eko_sep_${C}.db`);
const TMP_LOGS = path.join(os.tmpdir(), `eko_sep_${C}`);
const TMP_GUIA = path.join(os.tmpdir(), `eko_guias_${C}`);

let passou = 0, falhou = 0, servidor;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function ok(cond, msg, extra) {
  if (cond) { passou++; console.log(`  \x1b[32m✓\x1b[0m ${msg}`); }
  else { falhou++; console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
         if (extra !== undefined) console.log('      →', JSON.stringify(extra).slice(0, 300)); }
}
async function req(metodo, rota, corpo, tipo) {
  const opc = { method: metodo, headers: {} };
  if (corpo !== undefined) {
    if (Buffer.isBuffer(corpo)) { opc.body = corpo; opc.headers['Content-Type'] = tipo || 'image/jpeg'; }
    else { opc.body = JSON.stringify(corpo); opc.headers['Content-Type'] = 'application/json'; }
  }
  const r = await fetch(BASE + rota, opc);
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, body: j };
}

// Coloca uma gaiola num endereço, pelo caminho normal do sistema.
async function endereçar(posicao, corKey, formato, fardos, tipo) {
  const g = await req('POST', '/produto-acabado/etiqueta-gaiola',
                      { corKey, formato, fardos, tipo_gaiola: tipo || 'GRANDE' });
  const id = g.body && g.body.id;
  if (!id) throw new Error('nao consegui gerar a etiqueta: ' + JSON.stringify(g.body));
  const o = await req('POST', '/enderecamento/ocupar', { posicao, gaiola_id: id, tipo_gaiola: tipo || 'GRANDE' });
  if (!o.body || !o.body.ok) throw new Error('nao consegui endereçar: ' + JSON.stringify(o.body));
  return id;
}

(async () => {
  try {
    console.log('\n═══════════════════════════════════════════════════');
    console.log(' SEPARAÇÃO E CARREGAMENTO — Ekoplastic');
    console.log('═══════════════════════════════════════════════════\n');
    console.log('Subindo servidor de teste...');
    servidor = spawn('node', [path.join(ROOT, 'server.js')], {
      env: { ...process.env, EKO_PORT: String(PORT), EKO_PORT_CB: String(PORT_CB),
             EKO_DB_FILE: TMP_DB, EKO_LOG_DIR: TMP_LOGS, EKO_GUIAS_DIR: TMP_GUIA,
             TZ: 'America/Sao_Paulo', EKO_PRINT_SIMULAR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    servidor.stdout.on('data', () => {});
    let vivo = false;
    for (let i = 0; i < 75; i++) {
      try { const r = await fetch(BASE + '/healthcheck'); if (r.ok) { vivo = true; break; } } catch (e) {}
      await sleep(200);
    }
    if (!vivo) throw new Error('servidor não subiu');
    const hc = await req('GET', '/healthcheck');
    ok(hc.body && hc.body.impressao_simulada === true,
       'impressão travada em SIMULAÇÃO pelo ambiente (não gasta etiqueta)');

    // ── [1] A FOTO DA GUIA É O GATILHO ──────────────────────────────
    console.log('\n[1] A foto da guia é o que inicia o processo');
    const vazio = await req('POST', '/separacao/nova', Buffer.alloc(0));
    ok(vazio.status === 400, 'sem foto, o processo NÃO começa', vazio.body);

    // JPEG mínimo de verdade (assinatura + fim), não um texto qualquer
    const foto = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]),
                                Buffer.alloc(4096, 0x20), Buffer.from([0xFF, 0xD9])]);
    const nova = await req('POST', '/separacao/nova', foto);
    ok(nova.status === 200 && nova.body.id, 'com a foto, a separação nasce em rascunho', nova.body);
    const SEP = nova.body.id;
    ok(nova.body.status === 'rascunho', 'status inicial = rascunho');
    ok(fs.existsSync(path.join(TMP_GUIA, nova.body.arquivo)), 'a foto foi gravada no disco');

    const volta = await fetch(`${BASE}/separacao/${SEP}/guia`);
    const buf = Buffer.from(await volta.arrayBuffer());
    ok(volta.status === 200 && buf.length === foto.length,
       'a foto volta pela rota /guia, para ficar na tela durante a conferência');
    ok(String(volta.headers.get('content-type')).includes('image/jpeg'), 'volta com o tipo certo');

    // ── [2] CONFERÊNCIA E ORDEM DE CARREGAMENTO ─────────────────────
    console.log('\n[2] Conferência da guia e ordem de carregamento');
    const cedo = await req('POST', `/separacao/${SEP}/planejar`);
    ok(cedo.status === 409, 'não dá para planejar antes de conferir a guia', cedo.body);

    const conf = await req('POST', `/separacao/${SEP}/conferir`, { pedidos: [
      { ordem: 1, cliente: 'CLIENTE A', cidade: 'Teresina', uf: 'PI',
        itens: [{ cor_key: 'BC', formato: '50x60', fardos: 30 }] },
      { ordem: 2, cliente: 'CLIENTE B', cidade: 'Parnaiba', uf: 'PI',
        itens: [{ cor_key: 'BC', formato: '50x60', fardos: 14 }] },
    ]});
    ok(conf.status === 200 && conf.body.status === 'conferida', 'guia conferida', conf.body);

    const rep = await req('POST', `/separacao/${SEP}/conferir`, { pedidos: [
      { ordem: 1, cliente: 'A', itens: [{ cor_key: 'BC', formato: '50x60', fardos: 1 }] },
      { ordem: 1, cliente: 'B', itens: [{ cor_key: 'BC', formato: '50x60', fardos: 1 }] },
    ]});
    ok(rep.status === 400, 'ordem de carregamento repetida é recusada', rep.body);

    const kg = await req('POST', `/separacao/${SEP}/conferir`, { pedidos: [
      { ordem: 1, cliente: 'A', itens: [{ cor_key: 'BC', formato: '50x60', kg: 260 }] },
    ]});
    ok(kg.status === 200 && kg.body.avisos.length === 1,
       'kg que não fecha em fardos de 25 é arredondado PARA CIMA e avisado', kg.body.avisos);

    const corRuim = await req('POST', `/separacao/${SEP}/conferir`, { pedidos: [
      { ordem: 1, cliente: 'A', itens: [{ cor_key: 'ROXO', formato: '50x60', fardos: 4 }] },
    ]});
    ok(corRuim.status === 400, 'cor que não existe no catálogo é recusada', corRuim.body);

    // volta para a conferência boa
    await req('POST', `/separacao/${SEP}/conferir`, { pedidos: [
      { ordem: 1, cliente: 'CLIENTE A', cidade: 'Teresina', uf: 'PI',
        itens: [{ cor_key: 'BC', formato: '50x60', fardos: 30 }] },
      { ordem: 2, cliente: 'CLIENTE B', cidade: 'Parnaiba', uf: 'PI',
        itens: [{ cor_key: 'BC', formato: '50x60', fardos: 14 }] },
    ]});

    // ── [3] O ALOCADOR: SOMA EXATA, SOBRA ZERO ──────────────────────
    console.log('\n[3] O alocador procura soma exata antes de tudo');
    // 24 + 20 = 44 exatos. A de 16 não deve ser tocada.
    const g24 = await endereçar('01-01-001', 'BC', '50x60', 24);
    const g20 = await endereçar('01-01-002', 'BC', '50x60', 20);
    const g16 = await endereçar('02-01-005', 'BC', '50x60', 16);

    const pl = await req('POST', `/separacao/${SEP}/planejar`);
    ok(pl.status === 200, 'plano gerado', pl.body && pl.body.erro);
    const usadas = (pl.body.coletas || []).map(c => c.gaiola_id).sort();
    ok(usadas.length === 2 && usadas.includes(g24) && usadas.includes(g20),
       `usou as duas que somam exato (${usadas.join(', ')}) e não encostou na terceira`);
    ok(pl.body.coletas.every(c => c.sobra === 0),
       'SOBRA ZERO — nenhuma gaiola fica pela metade, nenhuma reetiquetagem');
    ok(pl.body.resumo.compartilhadas === 1,
       'uma gaiola atende os dois pedidos — é o que evita abrir gaiola nova no pedido 2');
    const comp = pl.body.coletas.find(c => Object.keys(c.reparticao).length > 1);
    ok(comp && comp.reparticao['1'] === 6 && comp.reparticao['2'] === 14,
       `a repartição diz quanto vai para cada pedido: ${JSON.stringify(comp && comp.reparticao)}`);
    const primeiraVisita = pl.body.rota.filter(r => r.buscar).length;
    ok(primeiraVisita === 2, 'a rota manda buscar 2 gaiolas; no pedido 2 a compartilhada já está na doca');

    // Corrigir a guia depois de planejar, mas ANTES de qualquer coleta,
    // tem que continuar livre — é o "errei um número" que acontece toda
    // hora. O que não pode é corrigir com carga já na doca (ver [4]).
    const recon = await req('POST', `/separacao/${SEP}/conferir`, { pedidos: [
      { ordem: 1, cliente: 'CLIENTE A', itens: [{ cor_key: 'BC', formato: '50x60', fardos: 30 }] },
      { ordem: 2, cliente: 'CLIENTE B', itens: [{ cor_key: 'BC', formato: '50x60', fardos: 14 }] },
    ]});
    ok(recon.status === 200, 'dá para corrigir a guia enquanto ninguém coletou', recon.body);
    await req('POST', `/separacao/${SEP}/planejar`);

    // ── [4] O BIPE DA COLETA É A BAIXA ──────────────────────────────
    console.log('\n[4] O bipe da coleta libera o endereço na hora');
    const est = await req('GET', `/separacao/${SEP}`);
    const coleta24 = est.body.coletas.find(c => c.gaiola_id === g24);

    const errada = await req('POST', `/separacao/coleta/${coleta24.id}/confirmar`, { lido: 'G9999999' });
    ok(errada.status === 409, 'bipar a etiqueta errada é recusado', errada.body);

    const conf24 = await req('POST', `/separacao/coleta/${coleta24.id}/confirmar`,
                             { lido: g24, operador: 'DAVI' });
    ok(conf24.status === 200 && conf24.body.usada_100 === true, 'coleta confirmada, gaiola 100% usada');
    ok(conf24.body.posicao_liberada === '01-01-001', 'o endereço liberado é informado');

    const mapa = await req('GET', '/enderecamento/mapa');
    const p001 = mapa.body.posicoes.find(p => p.codigo === '01-01-001');
    ok(p001 && !p001.ocupada, 'o MAPA já mostra 01-01-001 livre — a baixa é automática');
    ok(!conf24.body.sobra_id, 'gaiola 100% usada não gera pendência de reetiquetagem');

    const dnv = await req('POST', `/separacao/coleta/${coleta24.id}/confirmar`, { lido: g24 });
    ok(dnv.status === 200 && dnv.body.ja_estava, 'bipar de novo a mesma coleta não duplica nada');

    // Agora que uma gaiola já está na doca, mexer nos números da guia
    // faria o plano brigar com o que já saiu.
    const tarde = await req('POST', `/separacao/${SEP}/conferir`, { pedidos: [
      { ordem: 1, cliente: 'CLIENTE A', itens: [{ cor_key: 'BC', formato: '50x60', fardos: 8 }] },
    ]});
    ok(tarde.status === 409 && tarde.body.coletadas === 1,
       'depois da primeira coleta, corrigir a guia é RECUSADO', tarde.body);

    // a etiqueta antiga não vale mais
    const velha = await req('POST', '/enderecamento/ocupar', { posicao: '02-02-010', gaiola_id: g24 });
    ok(velha.status === 409 && velha.body.encerrada,
       'a etiqueta da gaiola que já saiu é RECUSADA se alguém tentar endereçar de novo', velha.body);

    // ── [5] SOBRA: UMA SÓ, E VIRA FILA COM FIM ──────────────────────
    console.log('\n[5] Quando sobra, sobra numa gaiola só — e vira fila com fim');
    const foto2 = Buffer.concat([Buffer.from([0xFF, 0xD8, 0xFF, 0xE0]), Buffer.alloc(2048, 0x20)]);
    const SEP2 = (await req('POST', '/separacao/nova', foto2)).body.id;
    await req('POST', `/separacao/${SEP2}/conferir`, { pedidos: [
      { ordem: 1, cliente: 'C', itens: [{ cor_key: 'AM', formato: '30x40', fardos: 35 }] },
      { ordem: 2, cliente: 'D', itens: [{ cor_key: 'AM', formato: '30x40', fardos: 20 }] },
    ]});
    const a1 = await endereçar('01-02-001', 'AM', '30x40', 30, 'PEQUENA');
    await sleep(5);
    const a2 = await endereçar('01-02-002', 'AM', '30x40', 30, 'PEQUENA');
    await sleep(5);
    const a3 = await endereçar('01-03-003', 'AM', '30x40', 30, 'PEQUENA');

    const pl2 = await req('POST', `/separacao/${SEP2}/planejar`);
    const comSobra = pl2.body.coletas.filter(c => c.sobra > 0);
    ok(pl2.body.coletas.length === 2, `abriu só 2 gaiolas para 55 fardos: ${pl2.body.coletas.length}`);
    ok(comSobra.length === 1, 'exatamente UMA gaiola parcial, não várias');
    ok(comSobra[0].sobra === 5, `a sobra é a menor possível: ${comSobra[0].sobra} fardos`);
    ok(comSobra[0].gaiola_id === a2, 'a parcial é a MAIS NOVA das usadas — FIFO: as antigas saem inteiras');

    const est2 = await req('GET', `/separacao/${SEP2}`);
    for (const c of est2.body.coletas)
      await req('POST', `/separacao/coleta/${c.id}/confirmar`, { lido: c.gaiola_id, operador: 'VINICIUS' });

    const sob = await req('GET', '/sobras');
    ok(sob.body.sobras.length === 1, 'uma pendência de reetiquetagem na fila');
    const S = sob.body.sobras[0];
    ok(S.fardos === 5 && S.cor_key === 'AM' && S.formato === '30x40',
       'a pendência carrega o mesmo produto com a quantidade NOVA');
    ok(S.posicao_sugerida && S.posicao_sugerida.split('-')[1] === '01',
       `o endereço sugerido é no nível do chão: ${S.posicao_sugerida}`);
    ok(S.status === 'aguardando_impressao', 'nasce aguardando impressão');

    // ── [6] ETIQUETA NOVA, NÚMERO NOVO ──────────────────────────────
    console.log('\n[6] A etiqueta nova tem número novo e a quantidade certa');
    const imp = await req('POST', `/sobras/${S.id}/imprimir`, { operador: 'VINICIUS' });
    ok(imp.status === 200 && /^G\d{7}$/.test(imp.body.gaiola_nova), `número novo: ${imp.body.gaiola_nova}`);
    ok(imp.body.gaiola_nova !== a2, 'é um número DIFERENTE do da gaiola que saiu');
    ok(imp.body.fardos === 5 && imp.body.kg === 125, 'quantidade nova: 5 fardos = 125 kg');
    const sob2 = (await req('GET', '/sobras')).body.sobras[0];
    ok(sob2.status === 'impressa', 'a pendência passou para impressa');

    // o conteúdo do QR tem que trazer a quantidade NOVA
    const arqs = fs.readdirSync(path.join(TMP_LOGS, 'print-simulado')).sort();
    const epl = fs.readFileSync(path.join(TMP_LOGS, 'print-simulado', arqs[arqs.length - 1]), 'latin1');
    ok(epl.includes(`EKOPA|${imp.body.gaiola_nova}|30x40|AM|5|125`),
       'o QR da etiqueta nova traz o número novo e 5 fardos / 125 kg');

    // ── [7] ENDEREÇAR A SOBRA FECHA A PENDÊNCIA SOZINHO ─────────────
    console.log('\n[7] Endereçar a etiqueta nova fecha a pendência, sem passo extra');
    const end = await req('POST', '/enderecamento/ocupar',
                          { posicao: S.posicao_sugerida, gaiola_id: imp.body.gaiola_nova,
                            tipo_gaiola: 'PEQUENA', operador: 'VINICIUS' });
    ok(end.status === 200 && end.body.sobra && end.body.sobra.id === S.id,
       'o mesmo bipe de sempre fecha a sobra — nenhum passo a mais para o operador', end.body.sobra);
    const fila = await req('GET', '/sobras');
    ok(fila.body.sobras.length === 0, 'a fila de reetiquetagem esvaziou');

    const mapa2 = await req('GET', '/enderecamento/mapa');
    const alvo = mapa2.body.posicoes.find(p => p.codigo === S.posicao_sugerida);
    ok(alvo && alvo.ocupada && alvo.gaiola.fardos === 5,
       `o mapa passa a dizer que ${S.posicao_sugerida} tem 5 fardos`);

    // ── [8] "NÃO ESTÁ AQUI" E REPLANEJAMENTO ────────────────────────
    console.log('\n[8] Quando o mapa mente, a separação não trava');
    const SEP3 = (await req('POST', '/separacao/nova', foto2)).body.id;
    await req('POST', `/separacao/${SEP3}/conferir`, { pedidos: [
      { ordem: 1, cliente: 'E', itens: [{ cor_key: 'PT', formato: '40x50', fardos: 20 }] },
    ]});
    await endereçar('02-01-001', 'PT', '40x50', 20);
    await sleep(5);
    const pt2 = await endereçar('02-01-002', 'PT', '40x50', 20);
    const pl3 = await req('POST', `/separacao/${SEP3}/planejar`);
    const alvo3 = pl3.body.coletas[0];
    ok(pl3.body.coletas.length === 1, 'planejou uma gaiola só');

    ok(Number.isInteger(alvo3.id),
       'o plano devolve o id da coleta — sem ele a tela não teria como confirmar o bipe');
    const nao = await req('POST', `/separacao/coleta/${alvo3.id}/nao-encontrada`, { operador: 'DAVI' });
    ok(nao.status === 200 && nao.body && nao.body.ok === true,
       'o separador consegue dizer "não está aqui"', nao.body);
    const mapa3 = await req('GET', '/enderecamento/mapa');
    const vazia = mapa3.body.posicoes.find(p => p.codigo === alvo3.posicao);
    ok(vazia && !vazia.ocupada, 'o endereço que mentia é corrigido no mapa na hora');

    const pl3b = await req('POST', `/separacao/${SEP3}/planejar`);
    ok(pl3b.body.coletas.length === 1 && pl3b.body.coletas[0].gaiola_id !== alvo3.gaiola_id,
       'o replanejamento manda para a OUTRA gaiola em vez de travar a separação');

    // ── [9] REPLANEJAR NÃO MANDA SEPARAR DE NOVO O QUE JÁ SAIU ──────
    console.log('\n[9] Replanejar desconta o que já está na doca');
    const SEP4 = (await req('POST', '/separacao/nova', foto2)).body.id;
    await req('POST', `/separacao/${SEP4}/conferir`, { pedidos: [
      { ordem: 1, cliente: 'F', itens: [{ cor_key: 'REC', formato: '60x80', fardos: 40 }] },
    ]});
    await endereçar('02-02-001', 'REC', '60x80', 20, 'PEQUENA');
    await sleep(5);
    await endereçar('02-02-002', 'REC', '60x80', 20, 'PEQUENA');
    await sleep(5);
    await endereçar('02-02-003', 'REC', '60x80', 20, 'PEQUENA');
    const pl4 = await req('POST', `/separacao/${SEP4}/planejar`);
    ok(pl4.body.coletas.length === 2, 'plano com 2 gaiolas para 40 fardos');
    const est4 = await req('GET', `/separacao/${SEP4}`);
    const uma = est4.body.coletas.filter(c => c.status === 'planejada')[0];
    await req('POST', `/separacao/coleta/${uma.id}/confirmar`, { lido: uma.gaiola_id });
    const pl4b = await req('POST', `/separacao/${SEP4}/planejar`);
    const totalNovo = pl4b.body.coletas.reduce(
      (a, c) => a + Object.values(c.reparticao).reduce((x, y) => x + y, 0), 0);
    ok(totalNovo === 20, `replanejou só os 20 fardos que faltam, não os 40: ${totalNovo}`);
    ok(!pl4b.body.coletas.some(c => c.gaiola_id === uma.gaiola_id),
       'e não manda buscar de novo a gaiola que já está na doca');

    // ── [10] O QUE ESTÁ EM PRODUÇÃO ─────────────────────────────────
    // Quase nunca a guia inteira está pronta no galpão: parte está na
    // máquina e fica pronta no dia do carregamento. Isso não é erro, é
    // o normal. O erro seria o caminhão sair faltando carga sem
    // ninguém saber — por isso o sistema tem que dizer QUANTO falta e
    // DE QUEM, e a falta tem que sumir sozinha quando a produção chegar.
    console.log('\n[10] O que ainda está em produção é apontado, por pedido');
    const SEP5 = (await req('POST', '/separacao/nova', foto2)).body.id;
    await req('POST', `/separacao/${SEP5}/conferir`, { pedidos: [
      { ordem: 1, cliente: 'PRONTO LTDA',   itens: [{ cor_key: 'PT', formato: '80x100', fardos: 10 }] },
      { ordem: 2, cliente: 'ESPERANDO S.A', itens: [{ cor_key: 'PT', formato: '80x100', fardos: 15 }] },
    ]});
    await endereçar('01-01-003', 'PT', '80x100', 10);
    const pl5 = await req('POST', `/separacao/${SEP5}/planejar`);
    ok(pl5.body.faltas.length === 1 && pl5.body.faltas[0].faltam === 15,
       `avisa que faltam 15 fardos no total: ${JSON.stringify(pl5.body.faltas)}`);
    ok(pl5.body.resumo.faltando === 15, 'o resumo do plano carrega o total faltando');
    const fi = pl5.body.falta.por_item;
    ok(fi.length === 1 && fi[0].ordem === 2 && fi[0].cliente === 'ESPERANDO S.A' && fi[0].faltam === 15,
       `diz QUEM fica faltando: ${JSON.stringify(fi)}`);
    ok(fi[0].kg === 375, 'e em kg também, que é a unidade da guia');
    ok(pl5.body.coletas.length === 1 &&
       Object.keys(pl5.body.coletas[0].reparticao).join() === '1',
       'o que existe é separado assim mesmo — o pedido 1 sai completo, não trava a carga');

    // Agora a produção fica pronta e é endereçada.
    await endereçar('01-01-004', 'PT', '80x100', 15);
    const pl5b = await req('POST', `/separacao/${SEP5}/planejar`);
    ok(pl5b.body.falta.fardos === 0,
       'endereçada a produção e refeito o plano, a falta SOME sozinha');
    ok(pl5b.body.coletas.length === 2, 'e a gaiola nova entra no plano');
    const est5 = await req('GET', `/separacao/${SEP5}`);
    ok(est5.body.falta.fardos === 0, 'a falta também é recalculada ao consultar a separação');
    const lst = await req('GET', '/separacao');
    const l5 = lst.body.separacoes.find(x => x.id === SEP5);
    ok(l5 && l5.faltando === 0, 'e aparece zerada na lista de separações');

    // ── [11] O CICLO SOBREVIVE AO REINÍCIO DA ATUALIZAÇÃO ───────────
    console.log('\n[11] O ciclo sobrevive a um reinício do servidor');
    const antes = await req('GET', '/sobras?todas=1');
    servidor.kill('SIGKILL');
    await sleep(600);
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
    const depois = await req('GET', '/sobras?todas=1');
    ok(depois.body.sobras.length === antes.body.sobras.length,
       'as sobras continuam lá depois do reinício');
    const listagem = await req('GET', '/separacao');
    ok(listagem.body.separacoes.length === 5, `as 5 separações continuam lá: ${listagem.body.separacoes.length}`);
    const guiaViva = await fetch(`${BASE}/separacao/${SEP}/guia`);
    ok(guiaViva.status === 200, 'a foto da guia continua acessível');

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
