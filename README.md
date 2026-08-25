# Ekoplastic — Sistema de Etiquetas (Servidor Unificado)

Sistema único que combina:
- Integração Bling API v3 (OAuth + auto-refresh + proxy)
- Balança WT3000-iR (Serial COM3)
- Impressão EPL2 raw (Win32 Spooler via PowerShell)
- Banco SQLite (etiquetas, sessões, sequenciais, config)
- Servidor de arquivos estáticos (HTMLs em `public/`)

## Estrutura

```
ekoplastic-etiquetas/
├── server.js              ← Servidor unificado (porta 3000)
├── enviar_raw.ps1         ← Script PowerShell (não mexer)
├── INICIAR.bat            ← Único bat para iniciar tudo
├── package.json
├── bling_tokens.json      ← Tokens OAuth (você cria/cola aqui)
├── etiquetas.db           ← Banco SQLite (criado automaticamente)
├── public/
│   ├── index.html         ← Menu principal
│   └── mp-recebimento-retorno.html
├── logs/                  ← Logs diários (criado automaticamente)
└── backups/               ← Backups diários do .db (criado automaticamente)
```

## Pré-requisitos

- **Node.js 22.5 ou superior** (você está no 24, ótimo) — usa o SQLite built-in (`node:sqlite`).
- Windows (10/11) — testado.

## Primeira execução

**Requisito**: Node.js 22.5 ou superior (usa o módulo built-in `node:sqlite`, sem build nativo).

1. Coloque **todos os arquivos da pasta** em uma pasta no PC (sugestão: `C:\ekoplastic-etiquetas\`).
2. Copie o `bling_tokens.json` antigo para essa pasta (se ainda for válido).
3. Dê duplo-clique no `INICIAR.bat`.
4. Na primeira vez, instala dependências automaticamente (`npm install` — apenas o `serialport`) — leva ~30 segundos.
5. Quando o servidor subir, o navegador abre automaticamente em `http://localhost:3000`.

> **Se o `npm install` falhar no `serialport`**: o servidor sobe mesmo assim, mas a balança fica desativada (Bling + impressão continuam funcionando). Pra resolver: instale o **Visual Studio Build Tools** (opcional, somente se quiser balança serial).

## Operação diária

- Duplo-clique no `INICIAR.bat`.
- Deixar a janela do servidor **aberta** enquanto usa o sistema.
- Fechar a janela = encerra o servidor.

## Endpoints expostos (HTTP `localhost:3000`)

### Sistema
- `GET /healthcheck` — status geral (também aceita `/status`)
- `GET /impressoras` — lista impressoras Windows + qual está ativa
- `POST /impressora/redetectar` — re-busca impressora ativa

### Etiquetas
- `GET  /proximo-seq?tipo=recebimento|retorno`
- `GET  /etiqueta/:id` (alias: `/etiquetas/:id`)
- `GET  /etiquetas?tipo=&status=&limit=`
- `POST /print/etiqueta` (alias: `/etiquetas`) — imprime e persiste
- `POST /etiqueta/:id/bipar`
- `POST /etiqueta/:id/cancelar`

### Sessões
- `POST /sessoes` `{tipo, fornecedor?}` — abre sessão
- `GET  /sessoes/:id` — sessão + suas etiquetas
- `GET  /sessoes?status=pendente|pendente_config|erro&tipo=`
- `POST /sessoes/:id/finalizar` — fecha e envia ao Bling
- `POST /sessoes/:id/reenviar-bling` — tenta reenviar em caso de erro

### Bling
- `GET  /bling/status` — autenticação atual
- `GET  /bling/auth/start` — retorna URL de autorização
- `GET  /bling/callback` — callback OAuth (também: `:8888/callback`)
- `ALL  /bling/*` — proxy autenticado para `/Api/v3/*`

### Balança
- `GET /balanca/raw` — leitura bruta + diagnóstico
- `GET /balanca/peso` — peso parseado + estabilidade

### Config
- `GET  /config` — todos os valores
- `POST /config` `{chave: valor, ...}` — atualiza chaves

## Banco de dados

### Tabela `etiquetas`
Toda etiqueta impressa fica aqui. Status: `aguardando_bipe` | `bipada` | `cancelada` | `consumida`.

### Tabela `sessoes`
Cada "rodada" de Recebimento ou Retorno (do abrir até o FINALIZAR). Tem `bling_status`:
- `pendente`         — fechada, aguarda envio
- `pendente_config`  — fechada mas falta config (ex: ID do fornecedor no Bling)
- `enviado`          — sucesso, com `bling_id`
- `erro`             — falha no envio, com `bling_erro`

### Tabela `seqs`
Sequenciais separados por tipo (recebimento e retorno têm contadores independentes).

### Tabela `config`
Chave-valor. Usada para mapas como `mapa_fornecedor_bling`, `id_ekoplastic_bling`, etc.

## Dependências externas

- **`serialport`** (NPM) — para a balança via COM3. Tem prebuilt binaries para Windows (não precisa de Visual Studio Build Tools).
- **SQLite** — usa o módulo **built-in do Node.js** (`node:sqlite`). Sem instalação adicional.

Se o `serialport` falhar na instalação, o servidor continua rodando — apenas a balança fica desativada.

## Backups

A cada inicialização (e a cada 6h enquanto rodando), faz cópia do `etiquetas.db` em `backups/`. Mantém os últimos 7.

## Logs

Arquivos diários em `logs/AAAA-MM-DD.log`. Conteúdo: cada operação relevante (impressão, bipagem, sessão, OAuth, erros).

## Integração com Bling — pendente de configuração

O envio real ao Bling no FINALIZAR está implementado mas comentado (esqueleto pronto). Precisa de:

1. **Mapa fornecedor → ID Bling**:
   ```
   POST /config
   { "mapa_fornecedor_bling": {"Cedro": "12345", "Ycaro": "67890", ...} }
   ```
2. **Mapa código gravimétrico → SKU/ID produto Bling**:
   ```
   POST /config
   { "mapa_sku_bling": {"COL1": "PROD-123", "P2": "PROD-456", ...} }
   ```
3. **ID do contato Ekoplastic** (para retornos):
   ```
   POST /config
   { "id_ekoplastic_bling": "98765" }
   ```

Sem essas configs, o `bling_status` da sessão fica `pendente_config` (sistema avisa qual config falta).

## Troubleshooting

### Impressora não imprime
- Abre `http://localhost:3000/impressoras` no navegador
- Vê qual está ATIVA e em que porta
- Se a errada, edita `PRINTER_NAMES` no `server.js` reordenando

### Balança não conecta
- Confirma cabo USB-Serial em COM3 (Gerenciador de Dispositivos)
- Verifica no menu da balança: `rS1-02 = n81`, `rS1-04 = StrEAn`
- Servidor tenta reconectar a cada 10s

### Bling diz "não autenticado"
- Clica em "AUTENTICAR BLING" no menu inicial
- Faz login no Bling, autoriza
- A página de callback fecha sozinha em 2s

### Token expirou e não renova
- Verifica `bling_tokens.json` na pasta
- Se sumiu ou está corrompido, reautentica via menu inicial

## Decisão de design: por que tudo num arquivo só?

Mantemos o `server.js` único (em vez de modularizar com `require('./balanca')` etc.) porque:
- Facilita revisão (uma única busca cobre tudo)
- Sem dependências internas pra confundir
- ~1000 linhas é gerenciável
- Logs e tratamento de erros consistentes
- Quando precisar escalar, refatora-se em módulos

A organização interna por **seções com cabeçalhos visuais** substitui módulos.

## Modo simulação do Bling

Por padrão, o servidor inicia em **modo simulação** (`bling_simular=1` na tabela config). Nesse modo:

- O FINALIZAR monta o payload completo
- Loga tudo nos logs (INFO resumido + DEBUG com payload inteiro)
- Marca a sessão como `bling_status='enviado'` com `bling_id='SIM-<timestamp>'`
- **NÃO chama** a API do Bling de verdade

Útil pra testar o fluxo todo (UI + impressão + sessões + persistência) sem mexer no Bling real.

### Ver o payload de uma sessão depois

```
GET /sessoes/:id/payload-bling
```
Retorna o JSON que foi enviado (ou seria, se a sessão ainda não finalizou).

### Ativar modo REAL

Quando você tiver os IDs prontos:

```bash
# Pelo curl ou pelo console do navegador (F12):
fetch('/config', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({
    bling_simular: "0",
    mapa_fornecedor_bling: '{"Cedro":"12345","Ycaro":"67890"}',
    mapa_sku_bling: '{"COL1":"PROD-123","NCRIS1":"PROD-456"}',
    id_ekoplastic_bling: "98765"
  })
})
```

A partir daí, FINALIZAR chama o Bling de verdade (POST /Api/v3/pedidos/compras).
