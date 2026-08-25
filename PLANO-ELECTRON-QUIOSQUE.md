# Plano — Electron + Modo Quiosque com trava de supervisor

Objetivo: transformar o sistema num aplicativo de tela cheia "blindado",
onde o operador NÃO consegue sair pro Windows / internet, e a saída só é
possível com **senha de supervisor**.

---

## 1. O que cada camada cobre (expectativa realista)

Nenhuma solução isolada bloqueia 100% do Windows. A blindagem real vem da
combinação de duas camadas:

| Camada | Cobre | Não cobre sozinha |
|--------|-------|-------------------|
| **Electron** (este plano) | Tela cheia real sem barra, sem F11 de escape; bloqueio de Alt+Tab, Alt+F4, Ctrl+W, tecla Windows; fechar/minimizar só com senha de supervisor | `Ctrl+Alt+Del` (é do kernel do Windows — nenhum app bloqueia) |
| **Windows (Assigned Access / políticas)** | Trava a máquina num único app, some a barra de tarefas, bloqueia o resto do SO | — |

A recomendação é: **Electron agora** (resolve ~90% e já entrega a trava
por senha) e, se quiser fechar os 100%, ativar o **Modo Quiosque do
Windows (Assigned Access)** depois — é configuração de SO, sem código.

---

## 2. Arquitetura escolhida

**Decisão técnica importante:** o `server.js` usa `node:sqlite`
(`DatabaseSync`), que exige **Node 22.5+**. O Node embutido no Electron
nem sempre é 22.5+, então NÃO vamos rodar o server.js dentro do Electron.

Em vez disso:

```
┌─────────────────────────────────────────────┐
│  App Electron (a "casca" blindada)           │
│                                              │
│  • Processo principal (main.js):             │
│     - dá spawn em "node server.js" usando    │
│       o Node 22.5+ JÁ INSTALADO no Mini PC   │
│     - cria a janela quiosque                 │
│     - bloqueia teclas de fuga                │
│     - intercepta fechar/minimizar → senha    │
│                                              │
│  • Janela (renderer):                        │
│     - carrega http://localhost:3000          │
│       (o próprio sistema, sem mudança)       │
└─────────────────────────────────────────────┘
```

**Vantagens:**
- Reaproveita **100%** do server.js e dos HTMLs sem alteração.
- Não dependemos da versão de Node do Electron (usamos o do sistema).
- Se um dia o Electron tiver problema, o sistema continua rodando no
  navegador normal (nada fica preso ao Electron).

---

## 3. Travas implementadas no Electron

### 3.1 Janela quiosque
```js
new BrowserWindow({
  kiosk: true,            // tela cheia "dura", sem decoração
  fullscreen: true,
  frame: false,           // sem barra de título
  autoHideMenuBar: true,
  webPreferences: { ... }
});
```
Resultado: sem barra de endereço, sem botões de janela, F11 não escapa.

### 3.2 Bloqueio de teclas de fuga
Dois mecanismos combinados:
- `globalShortcut.register(...)` para Alt+Tab, tecla Windows (Super),
  Ctrl+Esc, Alt+F4 — registrados como "no-op" enquanto o app tem foco.
- `webContents.on('before-input-event')` para interceptar Ctrl+W,
  Ctrl+R, Ctrl+Shift+I (devtools), F5, etc. dentro da janela.

> `Ctrl+Alt+Del` não entra aqui — só o Windows (Assigned Access) bloqueia.

### 3.3 Saída só com senha de supervisor
- Evento `close` da janela é interceptado (`e.preventDefault()`).
- Abre um prompt de senha (uma telinha HTML própria, dentro do quiosque).
- A senha digitada é comparada com um **hash** salvo (ver seção 4).
- Só fecha/minimiza se a senha conferir. Senão, volta ao trabalho.
- Mesmo fluxo para um eventual botão "Sair do sistema".

### 3.4 Encerramento limpo
Ao sair com senha válida, o Electron mata o processo do server.js
(o spawn) antes de fechar, pra não deixar o Node órfão.

---

## 4. Senha de supervisor (como fica segura)

- A senha **nunca** é gravada em texto. Guardamos um **hash**
  (SHA-256 + salt) num arquivo local `supervisor.json`.
- Primeira configuração: um comando/telinha define a senha inicial
  (ex.: `DEFINIR-SENHA.bat` que pede e grava o hash).
- Troca de senha: mesma telinha, exige a senha atual antes de trocar.
- Se perder a senha: como é o dono da máquina, dá pra resetar apagando
  o `supervisor.json` (volta a pedir definição). Isso é aceitável no seu
  contexto (você controla o Mini PC), mas registramos no log quando
  acontece.

> Observação: por ser uma senha "de balcão" (proteção operacional, não
> contra um atacante técnico determinado), o hash local é adequado. Se um
> dia quiser nível maior, dá pra exigir a senha contra um servidor.

---

## 5. Estrutura de arquivos

```
ekoplastic-quiosque/
├─ main.js                  ← processo principal do Electron (casca + travas)
├─ preload.js               ← ponte segura renderer↔main (validar senha)
├─ senha.html               ← telinha de senha de supervisor (saída/troca)
├─ package.json             ← deps: electron, electron-builder
├─ supervisor.json          ← hash da senha (gerado, NÃO versionar)
│
├─ servidor/                ← o sistema atual, intacto
│  ├─ server.js
│  ├─ public/
│  ├─ testes/
│  ├─ node_modules/
│  ├─ enviar_raw.ps1
│  ├─ etiquetas.db
│  └─ credenciais-bling.json
│
└─ (após build) dist/       ← o .exe empacotado
```

---

## 6. Empacotamento

- **electron-builder** gera um executável Windows.
- Duas opções de formato:
  - **Portable** (`.exe` único, roda de uma pasta) — mais simples de
    atualizar (troca a pasta `servidor/` por dentro).
  - **Instalador** (`Setup.exe`) — instala na máquina, cria atalho,
    pode configurar auto-start.
- **Auto-start no boot do Windows**: configurável (atalho na pasta
  Startup, ou via instalador). Assim o Mini PC liga já no sistema.

---

## 7. Fechando os 100%: Modo Quiosque do Windows (opcional, sem código)

Depois do Electron, se quiser blindagem total contra `Ctrl+Alt+Del` e
qualquer escape de SO:
- **Assigned Access (Quiosque)** no Windows Pro: configura o Mini PC pra
  rodar SÓ o app do Electron, com uma conta dedicada. O Windows trava o
  resto (barra, gerenciador de tarefas, etc.).
- Alternativa via **políticas de grupo / shell customizado**: substitui o
  Explorer pelo nosso app como "shell" daquela conta.
- Isso é configuração de sistema (eu te passo o passo a passo quando
  chegarmos lá), não exige mudança no código.

---

## 8. Etapas de implementação (quando você der o sinal)

1. **Esqueleto Electron**: main.js que sobe o server.js e abre a janela
   quiosque em localhost:3000 (sem travas ainda) — validar que o sistema
   roda dentro do Electron.
2. **Travas de teclado**: globalShortcut + before-input-event.
3. **Senha de supervisor**: supervisor.json (hash), telinha senha.html,
   interceptação do fechar/minimizar.
4. **DEFINIR-SENHA**: utilitário pra definir/trocar a senha.
5. **Empacotamento** com electron-builder (portable primeiro).
6. **Teste no Mini PC**: validar travas com o operador real.
7. **(Opcional) Assigned Access** do Windows pra fechar os 100%.

Cada etapa é entregável e testável isoladamente.

---

## 9. Pré-requisitos e decisões pra você

**Pré-requisito a confirmar:**
- Versão do Node no Mini PC precisa ser **22.5+** (o sistema já roda lá,
  então provavelmente sim — confirme com `node --version`).
- Windows do Mini PC é **Pro**? (necessário só pra etapa 7, Assigned
  Access; as etapas 1–6 funcionam em qualquer Windows).

**Decisões:**
- Formato do pacote: **Portable** (recomendo pra começar — atualização
  mais fácil) ou **Instalador**?
- **Auto-start no boot** do Mini PC: sim ou não?
- A senha de supervisor é **uma só** pra todas as máquinas/frentes, certo?
  (você indicou senha de supervisor/gerente)

---

## 10. O que NÃO muda

- O `server.js`, os HTMLs, o banco, os mapas do Bling, o piso de testes:
  tudo permanece igual. O Electron é só uma "casca" por cima.
- Continua dando pra rodar no navegador normal (via INICIAR.bat) pra
  testes/manutenção — o Electron é o modo de produção blindado.
