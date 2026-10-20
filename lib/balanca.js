// ════════════════════════════════════════════════════════════════════
//  BALANÇA WT3000-iR (serial RS-232)
// ════════════════════════════════════════════════════════════════════

const { SERIAL_BAUD, SERIAL_PORT } = require('./config');
const { logI, logW } = require('./log');

// ════════════════════════════════════════════════════════════════════
//  BALANÇA WT3000-iR (Serial RS-232)
//  Manual: WT3000-iR v20230817_r33 — Seções 7.2, 8 e 8.1
// ════════════════════════════════════════════════════════════════════

let balanca = {
  ultimoPeso:   null,    // peso numérico parseado (kg)
  ultimoRaw:    '',      // linha bruta da última leitura
  pesoEstavel:  false,   // se F-m 14: status estável (S=0)
  portaAberta:  false,
  bytesTotal:   0,
  ultimoByteTs: null,
};
let _balancaReconectando = false;

// "Recebendo" = porta aberta E chegaram bytes há pouco (StrEAn manda várias vezes/s).
// IMPORTANTE: numa porta serial nativa, abrir SEMPRE funciona (mesmo sem aparelho
// ligado) — então "porta aberta" NÃO significa balança conectada. O sinal real de
// comunicação é byte chegando. Por isso o status usa isto, e não só portaAberta.
function balancaRecebendo() {
  return balanca.portaAberta && balanca.ultimoByteTs !== null &&
         (Date.now() - balanca.ultimoByteTs) < 4000;
}

function extrairPeso(linha) {
  let m;
  const sinal = s => (s === '-' ? -1 : 1);   // preserva o sinal que aparece no indicador (peso negativo)
  // F-m 14: "0,+300.000,+100.000,+200.000"  (S=estabilidade, B=bruto, T=tara, L=líquido)
  m = linha.match(/^([01]),([+-])\s*(\d+[.,]\d+)/);
  if (m) {
    balanca.pesoEstavel = (m[1] === '0');
    return sinal(m[2]) * parseFloat(m[3].replace(',', '.'));
  }
  // F-m 0/1/2/9: "ST,GS,+  300.000  kg" (6 ou 7 bytes)
  m = linha.match(/^[A-Z]{2},[A-Z]{2},([+-])\s*(\d+[.,]\d+)/);
  if (m) { balanca.pesoEstavel = linha.startsWith('ST,'); return sinal(m[1]) * parseFloat(m[2].replace(',', '.')); }
  // F-m 3/4/5: "+  300.000"  (também "-  005.000" → peso negativo)
  m = linha.match(/^([+-])\s*(\d+[.,]\d+)/);
  if (m) return sinal(m[1]) * parseFloat(m[2].replace(',', '.'));
  return null;
}

function iniciarBalanca() {
  if (_balancaReconectando) return;   // B5: evita empilhar tentativas concorrentes
  _balancaReconectando = true;
  let SerialPort, ReadlineParser;
  try {
    ({ SerialPort }     = require('serialport'));
    ({ ReadlineParser } = require('@serialport/parser-readline'));
  } catch(e) {
    logW('balanca', 'Módulo serialport não disponível — balança desativada');
    _balancaReconectando = false;
    return;
  }
  logI('balanca', `Conectando em ${SERIAL_PORT} @ ${SERIAL_BAUD} baud (8N1)`);
  const porta = new SerialPort({
    path: SERIAL_PORT, baudRate: SERIAL_BAUD,
    dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false,
  });
  let bufRaw = '';
  porta.on('data', chunk => {
    if (balanca.bytesTotal === 0) {
      logI('balanca', `Balança transmitindo em ${SERIAL_PORT} — primeiros ${chunk.length} bytes recebidos (comunicação OK)`);
    }
    balanca.bytesTotal += chunk.length;
    balanca.ultimoByteTs = Date.now();
    bufRaw += chunk.toString('ascii');
    const linhas = bufRaw.split(/\r\n|\r|\n/);
    bufRaw = linhas.pop();
    for (const linha of linhas) {
      if (!linha.trim()) continue;
      balanca.ultimoRaw = linha;
      const peso = extrairPeso(linha.trim());
      if (peso !== null && !isNaN(peso) && peso >= 0 && peso < 99999) {
        balanca.ultimoPeso = peso;
      }
    }
  });
  porta.open(err => {
    _balancaReconectando = false;   // B5: tentativa concluída (com ou sem sucesso)
    if (err) {
      balanca.portaAberta = false;
      logW('balanca', `Falha ao abrir ${SERIAL_PORT}`, { erro: err.message });
      setTimeout(iniciarBalanca, 10000);
      return;
    }
    balanca.portaAberta = true;
    // pyserial levanta DTR e RTS ao abrir; fazemos o mesmo, caso a balança
    // dependa dessas linhas pra transmitir. Não usamos controle de fluxo.
    porta.set({ dtr: true, rts: true }, e => {
      if (e) logW('balanca', 'Não foi possível ajustar DTR/RTS (seguindo mesmo assim)', { erro: e.message });
    });
    logI('balanca', `Porta ${SERIAL_PORT} aberta — aguardando dados da balança. (Porta serial nativa abre mesmo sem aparelho; só há comunicação de fato quando os bytes começarem a chegar — confira cabo/pinagem e rS1-04 = StrEAn)`);
  });
  porta.on('error', err => { balanca.portaAberta = false; logW('balanca', `Erro na porta`, { erro: err.message }); });
  porta.on('close', () => { balanca.portaAberta = false; _balancaReconectando = false; logW('balanca', 'Porta fechada — reconectando em 10s'); setTimeout(iniciarBalanca, 10000); });
}
iniciarBalanca();

module.exports = { balanca, balancaRecebendo, };
