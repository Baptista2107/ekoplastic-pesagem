// ════════════════════════════════════════════════════════════════════
//  HELPERS HTTP — corpo da requisição e respostas JSON
// ════════════════════════════════════════════════════════════════════



// Devolvido por um modulo de rotas quando nenhuma rota dele atende o pedido.
const NAO_TRATADA = Symbol('rota nao tratada');

// ════════════════════════════════════════════════════════════════════
//  HELPERS HTTP
// ════════════════════════════════════════════════════════════════════

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript',
  // Módulo ES. Sem esta linha o arquivo sai como text/plain e o
  // navegador RECUSA o import — foi o que quebrou o leitor de PDF.
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.ico':  'image/x-icon',
  '.svg':  'image/svg+xml',
};

function jsonRes(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function jsonOk(res, obj)  { jsonRes(res, 200, { ok: true,  ...obj }); }
function jsonErr(res, status, msg, extra) {
  jsonRes(res, status, { ok: false, erro: msg, ...(extra||{}) });
}
function lerBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    let tamanho = 0;
    const LIMITE = 1024 * 1024;   // 1 MB — M4: protege contra corpo gigante
    req.on('data', c => {
      tamanho += c.length;
      if (tamanho > LIMITE) {
        reject(new Error('Corpo da requisição excede o limite de 1 MB'));
        req.destroy();
        return;
      }
      b += c;
    });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
async function lerBodyJson(req) {
  const txt = await lerBody(req);
  if (!txt) return {};
  try { return JSON.parse(txt); } catch(e) { throw new Error('JSON inválido no corpo da requisição'); }
}

// Corpo BINÁRIO — usado só pela foto da guia de separação. O limite de
// 1 MB do corpo de texto não serve aqui: foto de celular passa disso
// fácil. A tela reduz a imagem antes de enviar (lado maior 2000 px,
// JPEG), então na prática chega bem abaixo deste teto; o teto existe
// para o caso de alguém mandar o arquivo cru.
function lerBodyBinario(req, limite = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let tamanho = 0;
    req.on('data', c => {
      tamanho += c.length;
      if (tamanho > limite) {
        reject(new Error(`Arquivo excede o limite de ${Math.round(limite / 1048576)} MB`));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

// Validações de campos obrigatórios
function exigeCampos(obj, campos) {
  for (const c of campos) {
    if (obj[c] === undefined || obj[c] === null || obj[c] === '') {
      throw new Error(`Campo obrigatório ausente: ${c}`);
    }
  }
}

module.exports = { exigeCampos, jsonErr, jsonOk, lerBodyBinario, lerBodyJson, MIME, NAO_TRATADA, };
