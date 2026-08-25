# Estrutura de arquivos — o que precisa estar na pasta do Mini PC

Tudo abaixo fica numa **única pasta** (a pasta do projeto). O `server.js`
procura tudo relativo a si mesmo, então os itens ficam lado a lado.

═══════════════════════════════════════════════════════════════════════
## 1. OBRIGATÓRIOS — sem isto o sistema não roda (ou roda capado)
═══════════════════════════════════════════════════════════════════════

```
pasta-do-projeto/
├─ server.js                ← o servidor (coração do sistema)
├─ package.json             ← define as dependências (serialport)
├─ INICIAR.bat              ← liga o servidor + abre em tela cheia
│
├─ public/                  ← TODAS as telas (não pode faltar nenhuma)
│  ├─ index.html
│  ├─ materia-prima.html
│  ├─ mp-recebimento-retorno.html
│  ├─ mp-retirada.html
│  ├─ etiqueta-producao.html
│  ├─ manutencao.html
│  └─ seguranca-saida.js    ← trava de saída/senha (usada por todas as telas)
│
└─ node_modules/            ← dependências da balança (serialport)
```

**Sobre o `node_modules/` (atenção — é o ponto que mais confunde):**
- Ele NÃO vem nos pacotes .zip que eu te enviei (os .zip têm só o código).
- O `serialport` tem peças nativas **específicas do Windows**, então tem
  que ser instalado/copiado no próprio Windows. Duas formas:
  1. **Manter** o `node_modules/` da pasta que já funciona (copiando a
     pasta inteira), OU
  2. Rodar **uma vez** na pasta do projeto, no Mini PC:
     `npm install`
     (com o `package.json` presente — ele baixa o serialport certo).
- Sem o `node_modules/`, o sistema ABRE e imprime normalmente, mas a
  **balança não conecta** (aparece "Módulo serialport não disponível").

═══════════════════════════════════════════════════════════════════════
## 2. CONFIGURAÇÃO DO BLING — necessários para a integração funcionar
═══════════════════════════════════════════════════════════════════════

```
├─ credenciais-bling.json   ← credenciais do app no Bling (NÃO compartilhar)
└─ bling_tokens.json        ← tokens de acesso (gerado após autenticar)
```

- Se você copiar a pasta que já funciona, os dois vêm junto e o Bling
  continua autenticado.
- Se começar do zero: o `credenciais-bling.json` precisa existir (com as
  credenciais do seu app Bling). O `bling_tokens.json` é gerado quando
  você autentica em **Manutenção → Autenticar Bling**.
- Enquanto o Bling não está autenticado, o sistema funciona em modo
  simulação de Bling (não envia de verdade).

═══════════════════════════════════════════════════════════════════════
## 3. GERADOS AUTOMATICAMENTE — NÃO precisa copiar (o sistema cria)
═══════════════════════════════════════════════════════════════════════

```
├─ enviar_raw.ps1           ← script de impressão (gerado no 1º boot)
├─ etiquetas.db             ← banco de dados (criado no 1º boot)
├─ logs/                    ← logs do dia, movimentação, desvios...
└─ backups/                 ← backups
```

- O `enviar_raw.ps1` é regenerado pelo servidor se faltar (foi o que
  resolveu a impressão na máquina nova).
- O `etiquetas.db` guarda TODOS os dados (etiquetas, sessões, mapas do
  Bling, senha de supervisor, config). **Se quiser preservar os dados,
  mantenha este arquivo.** Para começar limpo, basta não copiá-lo (um
  novo é criado).

═══════════════════════════════════════════════════════════════════════
## 4. RECOMENDADOS — testes e diagnóstico (não obrigatórios pra rodar)
═══════════════════════════════════════════════════════════════════════

```
├─ RODAR-TESTES.bat
├─ testes/
│  └─ piso-testes.js        ← bateria de testes (rode antes de cada update)
├─ DIAGNOSTICO.bat          ← diagnóstico da impressora (se precisar)
└─ _teste_impressao.ps1     ← usado pelo DIAGNOSTICO.bat
```

═══════════════════════════════════════════════════════════════════════
## 5. PRÉ-REQUISITOS DO MINI PC (fora da pasta — já instalados)
═══════════════════════════════════════════════════════════════════════

- **Node.js 22.5 ou superior** (você tem v24.15.0 ✓) — ESSENCIAL: o banco
  usa o `node:sqlite`, que só existe a partir do 22.5.
- **Google Chrome** instalado — o INICIAR.bat abre o sistema em tela
  cheia no modo aplicativo do Chrome (cai pro Edge se não houver Chrome).
- **Impressora 4BARCODE 4B-2074B** instalada (já confirmada).
- **Balança** na porta serial correta (ajuste a porta no INICIAR.bat se
  não for COM3 — veja em http://localhost:3000/balanca/portas).

═══════════════════════════════════════════════════════════════════════
## RESUMO — o mínimo absoluto para "tudo rodar 100%"
═══════════════════════════════════════════════════════════════════════

server.js + package.json + INICIAR.bat + public/ (com as 7 telas) +
node_modules/ (serialport) + credenciais-bling.json + bling_tokens.json

O resto (etiquetas.db, enviar_raw.ps1, logs/, backups/) o sistema cria
sozinho. testes/ e DIAGNOSTICO.bat são apoio.

**Caminho mais simples e seguro:** copie a pasta inteira que já funciona
(traz node_modules + credenciais + banco) e, por cima, aplique os
arquivos de código da última versão (server.js, public/, testes/,
INICIAR.bat). Depois confira no RODAR-TESTES.bat que a versão no topo é a
esperada e que dá "34 passou".
