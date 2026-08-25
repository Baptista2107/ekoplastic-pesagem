# HANDOFF — Migração do Sistema de Pesagem para a estrutura Ekoplastic

> **Para quem lê isto pela primeira vez:** este documento é autossuficiente.
> Ele descreve o objetivo, o estado atual, as decisões já tomadas e o que
> falta fazer.
>
> Data: 25/08/2026 · Versão do sistema: v157 · Autor do sistema: Frederico
> (GitHub: Baptista2107 · mourabaptista@gmail.com)
>
> **REVISÃO 2 — 25/08/2026.** As seções 4.3 e 4.4 foram executadas até onde
> a máquina permitia e **dois defeitos latentes foram encontrados e
> corrigidos**. Ver seção 4.6, que é nova. Os números de arquivos da revisão 1
> estavam certos, mas a conclusão "é só rodar o amend" estava errada: havia
> causa raiz não identificada. Trechos alterados estão marcados com ⟲.

---

## 1. OBJETIVO

Tirar o **Sistema de Pesagem** do isolamento e integrá-lo à estrutura de
desenvolvimento e dados da **Gestão Industrial Ekoplastic**.

Hoje o sistema de pesagem:
- vive numa pasta, distribuído por ZIP, sem controle de versão;
- roda isolado num Mini PC no chão de fábrica;
- não compartilha método de trabalho com os demais desenvolvimentos da fábrica.

O objetivo tem **três frentes independentes**:

| Frente | O que é | Estado |
|---|---|---|
| **A. Versionamento** | Sair do ZIP, entrar no Git/GitHub | EM ANDAMENTO (M2) |
| **B. Método de trabalho** | Adotar o padrão de pacotes/outputs da Gestão Industrial | DEFINIDO |
| **C. Dados** | Integrar produção da pesagem aos dashboards do VPS | DIAGNOSTICADO, não iniciado (M1) |

**Ponto crítico de entendimento:** a *execução* do sistema **não migra** para o
VPS. O Mini PC continua sendo o host, permanentemente, porque só ele tem a
balança (porta serial COM1) e a impressora térmica (EPL2 via PowerShell). O VPS
é Linux e não tem nem serial nem spooler do Windows. O que migra é o **código**
(para o Git) e o **dado** (para os dashboards), não o processo.

---

## 2. AS QUATRO MÁQUINAS

| Máquina | Papel | Ferramentas | Rede |
|---|---|---|---|
| **PC de Pesagem** (onde este trabalho ocorre) | Desenvolvimento do sistema de pesagem. É a máquina do Frederico | Git 2.53.0, PowerShell, **sem Claude Code**, **sem Node** | Tailscale `100.81.107.73` · LAN `192.168.3.156` |
| **Mini PC TANCA** | **Produção do chão de fábrica.** Executa o sistema ao lado da balança, com tela touch | Node ≥22.5, Git instalado | Tailscale (acesso via Moonlight) · mesma LAN |
| **VPS Contabo** | Dashboards, crons, ContaAzul, Bling (app dos dashboards) | Ubuntu, Python, Claude Code, Git | Tailscale `100.107.130.115` · painel HTTP `:8765` |
| **PC do outro dev** | Desenvolvimento dos dashboards/Gestão Industrial | Claude Code, Git, SSH ao VPS | Tailscale |

**Regra de ouro:** conta de usuário é para gente; deploy key é para máquina.
- PC de Pesagem → conta GitHub pessoal do Frederico (leitura+escrita)
- Mini PC → **nenhuma conta**, apenas deploy key **somente leitura**
- VPS → deploy key própria, somente leitura

**Fluxo:** código desce (GitHub → Mini PC / VPS), dado sobe (Mini PC → Bling → VPS).

⟲ **Consequência prática de "o PC de Pesagem não tem Node":** essa máquina
**não consegue validar sozinha** se o `node_modules` versionado funciona.
Qualquer prova de que a balança sobe tem que ser feita no Mini PC. É por isso
que o diagnóstico da seção 4.4 roda lá, e não aqui.

---

## 3. O QUE É O SISTEMA DE PESAGEM (v157)

Node.js + `node:sqlite` (built-in, Node ≥22.5). ~6.255 linhas em `server.js`,
12 telas em `public/`. Roda como servidor local; a interface é aberta na tela
touch do Mini PC e também por celular na LAN (HTTPS porta 3443, para câmera/QR).

**Módulos existentes:**
- Matéria-prima: recebimento, retorno, retirada
- Extrusão: pesagem de bobina por bobina, com etiqueta impressa
- **Produto Acabado**: lançamento de produção das sacoleiras
- **Retirada de bobinas**: bipagem da bobina que entra na sacoleira (baixa)
- Inventário cego por QR de gaiola
- Manutenção, outras pesagens (inventário/resíduos/aparas), diagnóstico

**Hardware acoplado (não migra):**
- Balança Weightech WT3000-iR na serial `COM1` (via módulo `serialport`)
- Impressão EPL2 raw via `enviar_raw.ps1` (PowerShell + spooler do Windows)

**Robustez já implementada:** WAL + `synchronous=FULL`, backup diário com
retenção de 7, 36 testes de piso, PIN por colaborador, log de desvios,
outbox de envio ao Bling (`sessoes.bling_status`: pendente/enviado/erro).

**Arquivos de runtime que NUNCA entram no repositório:**
`etiquetas.db` (+ `-wal`/`-shm`), `credenciais-bling.json`, `logs/`,
`backups/`, `cert/`.

⟲ **Acrescentados à lista após varredura do `server.js`** — todos gravados
pelo próprio sistema em runtime, todos já cobertos pelo `.gitignore` novo:

| Arquivo | Onde nasce no `server.js` |
|---|---|
| `bling_tokens.json` | `TOKEN_FILE`, linha 117 — token OAuth do Bling |
| `eko-encerrar.flag` | `/sistema/encerrar`, linha 3888 — flag de desligamento pela tela |
| `dashboard/` | `/dash`, linha 5385 — dashboards HTML gerados sob demanda |
| `etiquetas-db.json` | `LEGACY_JSON`, linha 123 — import do print-server v2; é dado |
| `enviar_raw.ps1.bak` | `garantirScriptImpressao`, linha 1996 |

---

## 4. FRENTE A — VERSIONAMENTO (M2) — ESTADO ATUAL E PENDÊNCIAS

### 4.1 Decisões tomadas

1. **Repositório próprio e privado:** `ekoplastic-pesagem` — separado do repo
   dos dashboards. Motivo de segurança: o Mini PC fica fisicamente acessível
   no chão de fábrica; ele não deve receber o código do VPS.
2. **Mini PC é consumidor read-only.** Nada de Claude Code nele, nada de
   edição ao vivo. Só `git pull`.
3. **`node_modules` versionado** (em vez de `npm install` no chão de fábrica),
   porque `serialport` é módulo nativo e uma falha de build deixaria a balança
   fora do ar com a fábrica rodando.
   ⟲ **Esta decisão ficou mais segura do que se supunha:** o `serialport` 12
   distribui binários **N-API** (`node.napi.node`), e N-API é interface estável
   entre versões maiores do Node. Ou seja, versionar o binário **não** amarra o
   Mini PC a uma versão exata do Node. O que continua obrigatório é a
   plataforma: Windows x64. O `diagnostico-serialport.js` confere isso sozinho
   e diz na tela qual é o caso.
   ⟲ **Mas a decisão tinha um furo grave no `.gitignore` — ver 4.6, defeito 1.**
4. **`.gitattributes` é crítico:** sem `*.bat text eol=crlf` o Git pode converter
   para LF e **quebrar o `INICIAR.bat`** (labels e `goto` param de funcionar).
   ⟲ **Correção:** a mesma regra aplicada ao `enviar_raw.ps1` **causava** um
   defeito, em vez de evitá-lo. Ver 4.6, defeito 2. O `.ps1` agora tem exceção
   explícita para LF. Para `.bat` a regra CRLF continua valendo e está certa.
5. **`package.json` alinhado:** estava `1.44.0` enquanto `server.js` dizia
   `v157`. Corrigido para `157.0.0` (o `/healthcheck` mostra a versão).
   ⟲ Conferido: o `package.json` em disco é o corrigido, com `serialport`,
   `@serialport/parser-readline` e `node-forge` declarados. **Não existe
   `package-lock.json`** nesta pasta.

### 4.2 O que já foi feito

- Pasta de trabalho:
  `C:\Users\Usuário\Downloads\Projeto Automação\ekoplastic-etiquetas\ekoplastic-etiquetas\v157`
- `git config --global user.name "Baptista2107"` e
  `user.email "mourabaptista@gmail.com"` — configurados
- Chave SSH já existente na máquina e **já autenticando no GitHub**
- Criados e aplicados: `.gitignore`, `.gitattributes`, `package.json` (157.0.0),
  `SETUP-GIT.bat`
- `git init -b main` executado
- **Commit de baseline feito**, tag `v157` criada
- Tailscale funcionando: o PC de Pesagem alcança o VPS
- ⟲ **Confirmado pelo reflog:** `commit (initial)` → `24f12a3c`, depois
  `commit (amend)` → `71e38ec`, ambos como `Baptista2107
  <mourabaptista@gmail.com>`. Ou seja o `--amend` da tentativa anterior
  **executou** — os arquivos voltaram por falta de regra no `.gitignore`, não
  por erro de comando. Existe **exatamente 1 commit**, a
  tag `v157` aponta para ele, e **não há remote configurado**. Ou seja, nada
  foi publicado e o `--amend` é seguro. As três coisas são verificadas de novo
  pelo script antes de ele agir.

### 4.3 ✅ CONCLUÍDA — commit sujo corrigido em 25/08/2026 11:53

**Resultado da execução do `CORRIGIR-COMMIT.bat`:** `RESULTADO: OK — commit de
baseline limpo`. As 12 verificações da FASE 0 passaram, as 8 validações da
FASE 5 passaram.

| Antes | Depois |
|---|---|
| commit `71e38ec` | commit **`2e022d5`** |
| 96 arquivos | **100 arquivos** |
| `files.zip` e `SETUP-GIT-LOG.txt` rastreados | fora, em qualquer subpasta |

Diff exato (validação 5.2) — nada inesperado foi absorvido:

```
D  files.zip                              A  CORRIGIR-COMMIT.bat
D  SETUP-GIT-LOG.txt                      A  INGERIR-NODE-MODULES.bat
M  .gitignore                             A  MINIPC-DIAGNOSTICO-SERIALPORT.bat
M  .gitattributes                         A  MINIPC-EMPACOTAR-NODE-MODULES.bat
                                          A  diagnostico-serialport.js
                                          A  HANDOFF_MIGRACAO_PESAGEM.md
```

**Validação 5.6 — a prova de que o defeito 2 está fechado:**

```
i/lf  w/lf    attr/text eol=lf     enviar_raw.ps1     <- os três batem
i/lf  w/crlf  attr/text eol=crlf   INICIAR.bat
i/lf  w/crlf  attr/text eol=crlf   CALIBRAR-IMPRESSORA.bat
i/lf  w/lf    attr/text eol=lf     server.js
```

O `enviar_raw.ps1` sai LF do commit e está LF no disco: o `server.js` não vai
reescrevê-lo a cada boot, e o `git pull` do futuro `ATUALIZAR.bat` não trava.
Os `.bat` continuam CRLF, como têm que ser.

Outras validações: working tree limpo, nada ignorado dentro do `node_modules`,
nenhum `.gitignore`/`.gitattributes` aninhado, e **5.7 = NÃO** — o `serialport`
ainda não está no commit, ou seja, o bloqueio 4.4 continua de pé e a publicação
segue barrada.

**Rede de segurança criada e ainda no lugar** — só apagar depois do push:

```
branch backup-commit-sujo   -> 71e38ec, o commit antigo
tag    backup-v157-antiga   -> a tag v157 original
```

Desfazer, se precisar: `git reset --soft backup-commit-sujo`.

---

#### Registro do problema original e da causa raiz

O commit tem **96 arquivos**, mas deveria ter **94**. Entraram dois arquivos
indevidos:
- `files.zip` — conferido: é o pacote de entrega da sessão anterior, contendo
  `SETUP-GIT.bat`, `.gitignore`, `.gitattributes` e `package.json`. É artefato
  de transporte, não faz parte do sistema.
- `SETUP-GIT-LOG.txt` — log gerado pelo próprio script de setup (runtime)

**Por que o `--amend` anterior não funcionou — causa raiz confirmada:**
o `.gitignore` novo, com as regras `*.zip` e `SETUP-GIT-LOG.txt`, **nunca chegou
a ser escrito em disco**. O arquivo na pasta ainda era o de 32 linhas, idêntico
ao que veio dentro do `files.zip`, sem nenhuma das duas regras. Sem elas o
`git add -A` recolocava os dois arquivos logo depois do `git rm --cached`.
Não era um erro de sequência de comandos — era um arquivo que faltava.

**Resolvido por:** `CORRIGIR-COMMIT.bat`, de duplo-clique. Ele faz as 5 fases
com relatório em `OUTPUT_CORRIGIR_COMMIT.TXT` e **para na FASE 0 se o
`.gitignore` ou o `.gitattributes` ainda forem os antigos** — o mesmo erro não
tem como se repetir em silêncio.

O script é **reexecutável** e faz, nesta ordem:

| Fase | O quê |
|---|---|
| 0 | 12 verificações de segurança, todas somente leitura |
| 1 | Fotografa o estado, mostra o que será absorvido pelo commit, **para e espera confirmação humana** |
| 2 | `git branch backup-commit-sujo` + `git tag backup-v157-antiga` |
| 3 | `rm --cached` → `add -A` → `add --renormalize .` → `commit --amend` → `checkout-index -f -a` |
| 4 | Recria a tag `v157` |
| 5 | 8 validações, com veredito OK/FALHOU |

Detalhes que valem registro, porque não são óbvios:

- **`git add --renormalize .` é obrigatório.** O `.gitattributes` mudou, e o
  `git add -A` sozinho não reaplica filtros em arquivo cujo tamanho e mtime não
  mudaram. Sem isso a renormalização não acontece.
- **`git checkout-index -f -a`** reescreve a pasta a partir do commit. É o que
  garante que o disco é byte a byte o que um clone novo vai receber —
  `git status` limpo, sozinho, **não** garante isso.
- **A FASE 0 aborta se houver mais de 1 commit.** Com histórico depois da
  baseline, o `--amend` reescreveria o commit errado e arrancaria a tag `v157`
  do lugar, e o próprio backup seria criado sobre o commit errado.
- **`git tag -d` não tem reflog.** Tag apagada só existe como objeto solto até
  o próximo `gc`. Por isso a FASE 2 guarda `backup-v157-antiga` antes.
- **Desfazer é `git reset --soft backup-commit-sujo`**, não `--hard`. O branch
  de backup guarda o commit, não a árvore de trabalho: `--hard` apagaria do
  disco qualquer coisa que o `add -A` tenha absorvido.

⟲ **Contagem esperada — o número 94 mudou.** O `HANDOFF_MIGRACAO_PESAGEM.md`
foi escrito ~12 minutos **depois** do commit, então não estava nos 96 e entra
agora. Somando as ferramentas novas:

```
96  commit atual
-2  files.zip + SETUP-GIT-LOG.txt
+1  HANDOFF_MIGRACAO_PESAGEM.md
+5  CORRIGIR-COMMIT.bat, INGERIR-NODE-MODULES.bat,
    MINIPC-DIAGNOSTICO-SERIALPORT.bat, MINIPC-EMPACOTAR-NODE-MODULES.bat,
    diagnostico-serialport.js
+n  arquivos de node_modules que o .gitignore antigo engolia (ver 4.6)
```

Não vale mais conferir contra um número fixo. A validação 5.2 do script imprime
o **diff exato** contra o commit anterior — cada arquivo que entrou e cada um
que saiu, com letra A/D/M. É isso que deve ser lido.

### 4.4 ✅ RESOLVIDO — `serialport` versionado em 25/08/2026 14:00

`CORRIGIR-COMMIT.bat` rodado após a ingestão: **validação 5.7 = SIM**, o
`serialport` está no commit. Commit **`eadbfdf`**, **281 arquivos**, working
tree limpo, nada ignorado dentro do `node_modules`, `enviar_raw.ps1` em
`i/lf w/lf`. A publicação deixa de estar bloqueada.

Aritmética conferida: 239 arquivos no pacote − 59 do `node-forge`, que já
estava versionado e não mudou, + 1 `package-lock.json` = 181 adicionados;
com 4 modificados, os 185 do relatório. 100 + 181 = 281. Nada entrou sem
explicação.

`public/` e `testes/` foram comparados com a produção: **idênticos**, arquivo
por arquivo, mesmo tamanho e mesma data. A única divergência é na raiz (4.4.4).

#### Registro do bloqueio original

⟲ **Confirmado por inspeção direta:** o `node_modules` da pasta v157 contém
**apenas `node-forge`** — 59 arquivos, nenhum `.node`, nenhum `@serialport`.

⟲ **Mecanismo descoberto — por que ninguém percebeu.** O `INICIAR.bat`, linha 14:

```bat
if not exist "node_modules\node-forge" (
  echo Instalando dependencias pela primeira vez, aguarde...
  call npm install
)
```

A guarda só olha para o `node-forge`. Como ele existe, **o `npm install` nunca
roda**, mesmo faltando o `serialport`. O sistema sobe, as telas abrem, a
impressão funciona, e a balança some sem barulho — o `server.js` cai no
`try/catch` da linha 1748 e só registra "Módulo serialport não disponível".

Os mtimes reforçam: o `node-forge` foi instalado 24 segundos depois de o
`INICIAR.bat` ser gravado, ou seja, por essa própria guarda — numa época em que
o `package.json` era o 1.44.0 e provavelmente não declarava o `serialport`.

**Correção sugerida da guarda** (não aplicada ainda, é mudança de
comportamento em produção — decidir junto):

```bat
if not exist "node_modules\serialport" (
  echo [AVISO] serialport ausente - a balanca vai subir DESATIVADA.
)
```

Avisar é melhor do que chamar `npm install` no chão de fábrica, que é
justamente o que a decisão 4.1.3 quer evitar.

**A fazer — no Mini PC, via Moonlight.** Três scripts prontos, em fases, no
padrão da seção 5 (FASE 1 read-only para e reporta):

| Script | Onde | O que faz |
|---|---|---|
| `MINIPC-DIAGNOSTICO-SERIALPORT.bat` + `diagnostico-serialport.js` | Mini PC | **FASE 1, somente leitura.** Ambiente, ABI, pacotes, binários `.node`, e a prova real: `require('serialport')` + `SerialPort.list()`. **Não abre a COM1** — pode rodar com o sistema ligado. |
| `MINIPC-EMPACOTAR-NODE-MODULES.bat` | Mini PC | **FASE 2, travada.** Refaz o teste de `require` e **se recusa a empacotar** se falhar. Usa o `tar` nativo do Windows, e confere se o pacote tem tantas entradas quanto arquivos — pacote truncado é rejeitado. |
| `INGERIR-NODE-MODULES.bat` | PC de Pesagem | **FASE 3.** Arraste o pacote sobre o ícone. Valida **antes** de trocar, guarda o `node_modules` atual em `node_modules.antigo-<data>` em vez de apagar, e compara o `package.json` das duas máquinas **sem sobrescrever** o daqui. |

Depois da FASE 3, rodar de novo o `CORRIGIR-COMMIT.bat`: a validação 5.7 diz
se o `serialport` entrou mesmo no commit.

#### 4.4.1 ✅ RESOLVIDO — por que o diagnóstico se contradisse

Com acesso **somente leitura** à pasta do Mini PC
(`Y:\Users\usuario\Desktop\PROJETO AUTOMAÇÃO`, mapeada a partir do PC de
Pesagem), deu para inspecionar sem rodar nada na fábrica.

**Aquela pasta É a produção.** Confirmado: `etiquetas.db-wal` com 4,1 MB e
gravação do próprio dia, `etiquetas.db-shm`, `bling_tokens.json` renovado hoje,
`logs/`, `backups/`, `cert/`, `dashboard/`. É o sistema rodando.

**O `server.js` é o MESMO nas duas máquinas:** 331.199 bytes e mtime idêntico
nos dois lados. O código de produção e o do repositório são o mesmo. Era a
maior dúvida em aberto e está fechada.

**A contradição da v1 explicada.** Dentro do `node_modules` do Mini PC:

| Pacote | Como o sistema de arquivos reporta |
|---|---|
| `node-forge` | arquivos **normais**, com tamanho e data |
| `serialport` | **todos** os arquivos são reparse point / link |
| `@serialport/*` | idem, inclusive os `.node` dos `prebuilds` |
| `node-gyp-build` | idem, todos os 8 arquivos |

A varredura da v1 usava `isFile()`, que devolve falso para reparse point.
Ela contou só o `node-forge` — **exatamente os 59 arquivos e 1,6 MB** do
relatório — e não achou nenhum `.node`. O `require` atravessa reparse point,
por isso a FASE 5 carregou o módulo e listou a COM1. As três afirmações eram
verdadeiras; a FASE 4 é que estava cega.

**O mesmo vale para arquivos da raiz:** `etiquetas.db`, `credenciais-bling.json`,
`package-lock.json`, `README.md`, `LEIA-ME_RETIRADA_v1.1.md` e
`enviar_raw.ps1.bak` também são reparse point. Já os arquivos escritos
recentemente — `bling_tokens.json`, `etiquetas.db-wal`, `server.js`,
`enviar_raw.ps1`, `INICIAR.bat` — são arquivos normais.

#### 4.4.2 ⚠️ RISCO NOVO — a pasta de produção parece estar em nuvem sincronizada

O padrão acima — arquivo usado há pouco fica normal, arquivo antigo vira
placeholder — é a assinatura do **OneDrive Files On-Demand**. Como a pasta é
`C:\Users\usuario\Desktop\PROJETO AUTOMAÇÃO`, e Desktop é uma das pastas
que o OneDrive redireciona por padrão, a hipótese é forte. **Não confirmada** —
confirmar é olhar a coluna de status no Explorador do Mini PC, sem risco.

Se for isso, são dois problemas sérios, independentes da migração para o Git:

1. **`etiquetas.db` sincronizado em nuvem.** Banco SQLite em WAL, aberto e
   gravando o tempo todo, dentro de pasta sincronizada. Sincronizador de
   arquivos não entende WAL: pode subir o `.db` sem o `-wal` correspondente,
   gerar cópia de conflito, ou travar o arquivo no meio de uma escrita. É risco
   de corromper o dado real da fábrica.
2. **Código do sistema como placeholder.** Se o `serialport` estiver
   desidratado e a máquina ficar sem internet, o `require` não consegue
   hidratar e **a balança não sobe**. Hoje isso está mascarado porque a
   hidratação funciona.

Recomendação, para decidir junto: tirar a pasta de produção de dentro da área
sincronizada — por exemplo `C:\Ekoplastic\pesagem` — e deixar a nuvem, se for
o caso, só para a pasta de `backups/`. Isso é assunto separado do M2 e não
bloqueia a publicação, mas é mais urgente do que ela.

#### 4.4.3 ✅ RESOLVIDO — node_modules montado sem tocar na produção

Empacotar o `node_modules` do Mini PC deixou de ser opção: o `tar` copiaria os
placeholders. E o pedido foi explícito — fábrica em operação, nenhuma alteração
naquela máquina.

Solução: **remontar a árvore equivalente**, com as versões exatas que a
produção reporta, e conferir contra ela.

| Pacote | Mini PC | Árvore montada |
|---|---|---|
| `serialport` | 12.0.0 | 12.0.0 |
| `@serialport/parser-readline` | 12.0.0 | 12.0.0 |
| `@serialport/bindings-cpp` | 12.0.1 | 12.0.1 |
| `@serialport/stream` | 12.0.0 | 12.0.0 |
| `node-forge` | 1.4.0 | 1.4.0 |
| `node-gyp-build` | 4.6.0 | 4.6.0 |

O primeiro nível do `node_modules` bate item a item com o do Mini PC
(`@serialport`, `debug`, `ms`, `node-addon-api`, `node-forge`, `node-gyp-build`,
`serialport`, `.package-lock.json`). O binário
`prebuilds/win32-x64/node.napi.node` é `PE32+ DLL x86-64 for MS Windows`,
229.376 bytes, N-API. Os `require` foram testados e carregam.

Duas decisões conscientes na árvore montada:

- **`node_modules/.bin` removido.** Só tem atalhos que este sistema nunca
  executa, e no Linux eles são symlink — o `.git/config` desta pasta tem
  `symlinks = false`, então virariam arquivos-lixo no checkout do Windows.
- **`package.json` passa de `node-forge: ^1.3.1` para `^1.4.0`**, alinhando com
  o que a produção roda. O `INGERIR-NODE-MODULES.bat` avisa da diferença e
  **não sobrescreve** o `package.json` local — a troca é decisão sua.

Entregue como `node_modules-serialport-v12.zip` — 1.301.250 bytes, 241 entradas,
10 binários `.node`, zero symlink. SHA256:
`179e6049f61c1e879dc17193892e685996899cdb2c342752fb30811f55ce00c7`

#### 4.4.4 ✅ DECIDIDO — arquivos da produção que faltavam na baseline

Comparando as duas pastas, existem em produção e **não** no repositório:

`ABRIR-TELA.bat` · `LIBERAR-ACESSO-CELULAR.bat` · `README.md` ·
`LEIA-ME_RETIRADA_v1.1.md` · `LEIA-ME-MIGRACAO.txt` · `migrar-goldgreen.js` ·
`migracao-goldgreen-DEPARA.csv` · `RODAR-MIGRACAO.bat` ·
`REIMPRIMIR-MIGRADAS.bat` · `reimprimir-migradas.ps1` · `package-lock.json` ·
`navegador-eko/` · `ZIP das versões/`

**Decisão tomada em 25/08/2026:**

| Grupo | Arquivos | Decisão |
|---|---|---|
| Ferramentas operacionais | `ABRIR-TELA.bat`, `LIBERAR-ACESSO-CELULAR.bat` | **versionar** |
| Documentação | `README.md`, `LEIA-ME_RETIRADA_v1.1.md`, `LEIA-ME-MIGRACAO.txt` | **versionar** |
| Migração GoldGreen jul/2026 | `migrar-goldgreen.js`, `RODAR-MIGRACAO.bat`, `REIMPRIMIR-MIGRADAS.bat`, `reimprimir-migradas.ps1`, `migracao-goldgreen-DEPARA.csv` | **não versionar** — já executada, fica arquivada só na produção |
| `navegador-eko/` | profile do Chrome de quiosque | **bloqueado no `.gitignore`** |
| `ZIP das versões/` | histórico de ZIPs | **bloqueado no `.gitignore`** |
| `package-lock.json` | — | já entrou no commit `eadbfdf` |

Os 5 arquivos a versionar precisam ser **copiados do Mini PC para a pasta v157**
pelo Explorador, via o drive `Y:`. Copiar é leitura: não altera nada na
produção. `README.md` e `LEIA-ME_RETIRADA_v1.1.md` são placeholders e vão
hidratar na cópia — precisa de internet no Mini PC nesse momento.

Depois da cópia, `CORRIGIR-COMMIT.bat` de novo. Esperado: **286 arquivos**
(281 + 5), mais os 3 arquivos de ferramenta que foram reescritos desde então.

`navegador-eko` merece registro: é um profile de Chrome inteiro — `Crashpad`,
`ShaderCache`, `WidevineCdm`, `BrowserMetrics`. Centenas de MB que mudam a cada
segundo. Se entrasse no repositório, o clone do Mini PC ficaria inviável. Ele
se recria sozinho na primeira abertura da tela.

**Limitação encontrada:** no drive mapeado `Y:` dá para **listar**, mas
`device_stage_files` não consegue ler conteúdo — falha no `stat` de qualquer
arquivo, inclusive dos normais. A comparação acima é por nome, tamanho e data.

**Se a FASE 1 disser que o Mini PC também não tem:** procurar outra cópia do
`server.js` na máquina e rodar o mesmo diagnóstico lá. **Não publicar no GitHub
antes de resolver isto.**

### 4.5 ⚠️ ANTES DE PUBLICAR — credencial do Bling estava no código-fonte

Varredura feita em 25/08/2026 nos 286 arquivos versionados, antes do primeiro
push. Um achado, sério:

**`server.js`, linhas 92-93, traziam o `client_id` e o `client_secret` do Bling
escritos no código.** O bloco `LEGADO` de migração gravava esses valores em
`credenciais-bling.json` e imprimia *"NÃO versione nem compartilhe este
arquivo"* — enquanto os valores em si estavam no arquivo que **é** versionado.
O próprio comentário do bloco dizia "M3: fora do código-fonte" e "serão
removidos numa versão futura": era transitório e ficou.

Fora isso, limpo: nenhuma senha, PIN, token ou IP privado nos arquivos
versionados legíveis.

**Por que resolver antes do push:** com um commit só e nada publicado, tirar
custa um `--amend`. Depois do push, custa reescrever histórico e forçar, e o
valor fica na base do GitHub e em todo clone já feito.

**Decisão tomada: remover do código.** Verificado antes de mexer que é seguro:

- `carregarCredenciaisBling()` tenta 1) variáveis de ambiente, 2)
  `credenciais-bling.json`, 3) `LEGADO`. O Mini PC **tem** o arquivo, então o
  caminho 2 vence e o 3 nunca é alcançado. Zero efeito em produção.
- O sistema já prevê credencial ausente: existe o estado
  `bling_status='pendente_config'` (`server.js` linha 3284). Sem credencial, a
  pesagem e a impressão seguem normais e o envio ao Bling fica na fila.
- `CLIENT_ID`/`CLIENT_SECRET` só são usados em 3 pontos, todos dentro da
  integração Bling — nada no caminho de pesar/imprimir/bipar.

O bloco foi substituído por um aviso claro no console, e a função passa a
devolver `origem: 'ausente'`. Os quatro caminhos foram testados em isolamento —
ambiente, arquivo presente, sem nada, arquivo corrompido — e **nenhum lança
exceção**. `server.js`: 6.256 → 6.264 linhas, só o bloco de credenciais mudou.

**Pendência separada, sem pressa:** rotacionar o `client_secret` no Bling. O
valor antigo não está mais no código, mas esteve em ZIPs distribuídos.

### 4.5-b Publicar e conectar

1. Criar no GitHub o repo `ekoplastic-pesagem` (**Private**, sem README/
   .gitignore/licença, pois a pasta já tem conteúdo)
2. `git remote add origin git@github.com:Baptista2107/ekoplastic-pesagem.git`
3. `git push -u origin main` e `git push origin v157`
4. No Mini PC: gerar chave, cadastrar como **deploy key read-only** do repo,
   clonar em pasta nova, copiar para dentro os arquivos de runtime
   (`etiquetas.db`, `credenciais-bling.json`, `logs/`, `backups/`, `cert/`,
   ⟲ e `bling_tokens.json`), subir, conferir `/healthcheck`, e só então trocar
   as pastas
5. Criar um `ATUALIZAR.bat` no Mini PC que faça: backup do `etiquetas.db` →
   `git pull` → reinicia → mostra `/healthcheck`. Um duplo-clique, sem terminal.
   ⟲ **Antes de escrever esse `ATUALIZAR.bat`, ler o defeito 2 da seção 4.6.**
   Ele existia exatamente para fazer esse `git pull` falhar.
6. Rollback passa a ser `git checkout v157` + reiniciar
7. ⟲ Depois que o push der certo, limpar: `git branch -D backup-commit-sujo`,
   `git tag -d backup-v157-antiga`, `rmdir /s /q node_modules.antigo-*`

### 4.6 ⟲ NOVA — DOIS DEFEITOS LATENTES ENCONTRADOS E CORRIGIDOS

Nenhum dos dois aparecia como erro. Os dois só iam se manifestar depois de
publicado, no chão de fábrica. Ambos foram **reproduzidos em repositório de
teste** antes de corrigir — não são suposição.

#### Defeito 1 — o `.gitignore` engolia arquivos dentro do `node_modules`

O `.gitignore` (tanto o antigo quanto o rascunho novo) tem regras genéricas:
`*.db`, `cert/`, `logs/`, `.env`, `*.tmp`, `*.bak`, `.DS_Store`. Regra de
`.gitignore` **vale em qualquer profundidade**, inclusive dentro do
`node_modules`. Qualquer pacote npm que tenha uma pasta `logs`, `cert` ou um
arquivo `.db` de fixture **some do commit** — e pacote inteiro, não só o arquivo.

Teste com 8 arquivos plantados: **7 foram ignorados**, e três pacotes inteiros
apareceram como `!! node_modules/<pkg>/`.

Isso anula a decisão 4.1.3 na prática. O Mini PC clonaria um `node_modules`
incompleto, o `require('serialport')` falharia e **a balança não subiria** — e
o `git status` no PC de Pesagem estaria limpo o tempo todo.

**Correção:** `!node_modules/**` como **última linha** do `.gitignore` — no
`.gitignore` vence a última regra que casa. Reteste: 8 de 8 versionados,
nenhum ignorado. O `CORRIGIR-COMMIT.bat` recusa-se a rodar se essa linha não
estiver lá (verificação 11/12), e as validações 5.4 e 5.5 conferem de novo
depois do commit — inclusive a existência de `.gitignore`/`.gitattributes`
**aninhados** dentro de pacotes, que têm precedência sobre os da raiz e podem
furar a proteção.

#### Defeito 2 — a regra CRLF quebraria o `git pull` do Mini PC

O `enviar_raw.ps1` **não é fonte editada à mão**: o `server.js` o regenera.
`garantirScriptImpressao()`, linha 1986, compara o arquivo em disco com a
constante `ENVIAR_RAW_PS1` e, havendo **qualquer** diferença de byte, faz backup
em `.bak` e reescreve.

Essa constante mora dentro do `server.js`, que é gravado com **LF**. Logo o
`server.js` sempre escreve o `.ps1` com **LF**. Mas o `.gitattributes` dizia
`*.ps1 text eol=crlf`, o que faria o Git entregar o arquivo com **CRLF**.

Medido, em clone de teste:

| `.gitattributes` | Clone entrega | Template no `server.js` | Iguais? |
|---|---|---|---|
| antigo (`*.ps1 eol=crlf`) | CRLF — 2.533 bytes | LF — 2.497 bytes | **não** |
| novo (exceção `eol=lf`) | LF — 2.497 bytes | LF — 2.497 bytes | **sim** |

Com o antigo, a cada boot: o server reescreve o arquivo, cria um `.bak`, o
`git status` fica sujo **permanentemente**, e o **primeiro `git pull` do
`ATUALIZAR.bat` falha** com *"your local changes would be overwritten"* — no
chão de fábrica, com a fábrica rodando.

O próprio Git já avisava, no commit: `warning: in the working copy of
'enviar_raw.ps1', LF will be replaced by CRLF the next time Git touches it`.

**Correção:** exceção explícita e comentada no `.gitattributes`:

```gitattributes
*.ps1           text eol=crlf     # regra geral, continua valendo
enviar_raw.ps1  text eol=lf       # exceção: é gerado pelo server.js
```

A regra CRLF para `.bat` **continua certa e necessária** — `INICIAR.bat` usa
`:loop`/`goto` e quebraria com LF. O erro da revisão 1 foi só ter estendido a
regra a um arquivo que a máquina reescreve.

Validação 5.6 do script imprime `git ls-files --eol` dos arquivos críticos.
Para o `enviar_raw.ps1` tem que sair `i/lf w/lf attr/text eol=lf`.

#### Endurecimento adicional aplicado no `.gitattributes`

- `node_modules/** -text` — desliga toda conversão de fim de linha dentro do
  `node_modules` vendorizado, para que o Mini PC receba byte a byte o que foi
  commitado.
- Regras `binary` para artefatos de build nativo: `.lib .a .o .obj .pdb .exp
  .so .dylib .swf`, além dos `.node` que já estavam.

### 4.7 ⟲ Arquivos entregues nesta rodada

| Arquivo | Onde roda | Papel |
|---|---|---|
| `.gitignore` | — | **Substitui** o atual. Regras `.zip`/`SETUP-GIT-LOG.txt`/`OUTPUT_*.TXT`, runtime novo do `server.js`, e a trava `!node_modules/**` |
| `.gitattributes` | — | **Substitui** o atual. Exceção do `enviar_raw.ps1`, `node_modules/** -text`, binários nativos |
| `CORRIGIR-COMMIT.bat` | PC de Pesagem | Seção 4.3, 5 fases, reexecutável |
| `MINIPC-DIAGNOSTICO-SERIALPORT.bat` | Mini PC | Seção 4.4 FASE 1, somente leitura |
| `diagnostico-serialport.js` | Mini PC | Motor do diagnóstico; acompanha o `.bat` |
| `MINIPC-EMPACOTAR-NODE-MODULES.bat` | Mini PC | Seção 4.4 FASE 2, travada pelo teste de `require` |
| `INGERIR-NODE-MODULES.bat` | PC de Pesagem | Seção 4.4 FASE 3, valida antes de trocar |

Todos escrevem `OUTPUT_<NOME>.TXT` com escrita incremental por fase e
`=== FIM DO DIAGNOSTICO ===` só na última — padrão da seção 5. Todos abrem o
relatório no Notepad ao terminar. Todos são de duplo-clique.

---

## 5. FRENTE B — MÉTODO DE TRABALHO

Padronizado a partir dos chats do Cérebro de Manutenção; documento de
referência: `PADRAO_TRABALHO_VPS.md` (já atualizado no Project Knowledge).

**Marcadores** — sempre FORA da caixa de código:
- `[VPS]` — comando para o terminal do VPS
- `[CC]` — bloco para o Claude Code
- `[PC-PESAGEM]` — comando para o PC de pesagem (marcador novo, a formalizar)
- ⟲ `[MINI-PC]` — a formalizar também; o Mini PC virou destino de bloco próprio
  a partir da seção 4.4

**Regra de relatório:** todo bloco grava `OUTPUT_<NOME>.TXT` na pasta de
outputs no Drive (`/mnt/drive/EKOPLASTIC/DASHBOARDS/OUTPUTS/`), com escrita
incremental por fase (append+flush); só a última fase escreve
`=== FIM DO DIAGNOSTICO ===`. O rclone espelha; a leitura é feita de lá.

⟲ Nas máquinas Windows sem rclone, o `OUTPUT_<NOME>.TXT` fica na própria pasta
do sistema e é ignorado pelo Git via `OUTPUT_*.TXT`.

**Outras regras:** blocos para o CC são autossuficientes (o CC não vê a
conversa); FASE 1 read-only sempre PARA e reporta; nunca dar limiar de teste
sem medir; só vai para o CC o que exige ambiente (cada rodada custa US$5–15).

**Princípio de interface (vale para todo o projeto):** backend robusto,
seguro e técnico; frontend de poucos toques para pessoas com baixo
conhecimento em informática. Quando um requisito de backend pedir um toque a
mais do operador, ele vai para o backend ou para o dashboard — não para a tela
da estação. Isso se aplica também às ferramentas do Frederico: preferir `.bat`
de duplo-clique a comandos digitados.

---

## 6. FRENTE C — INTEGRAÇÃO DE DADOS (M1) — DIAGNÓSTICO FEITO

### 6.1 Descoberta central

O sistema de pesagem **já está integrado ao dashboard PA, por acidente**. Ele
grava pedidos de compra no Bling usando **exatamente os mesmos contatos
fictícios** que o `dashboard_pa_ekoplastic.py` (no VPS) lê:

| ID Bling | Contato |
|---|---|
| 17802279349 | PA Turno A |
| 17803577652 | PA Turno C |
| 18180509587 | PA Turno Extra |
| 18007239571 | Extrusão A-1 (Wallison) |
| 18007242562 | Extrusão A-2 (Davi) |
| 18007241951 | Extrusão C-1 (Alexandro) |
| 18007243073 | Extrusão C-2 (Marlito) |

O Bling funciona hoje como **barramento de integração de fato** entre os dois
mundos.

### 6.2 DEFEITO CONFIRMADO (testado, não suposto)

O `dashboard_pa_ekoplastic.py` usa o regex
`_rx_prod = r"PRODU+[CÇ]+[AÃ]+O?\s*"` e exige o prefixo "PRODUÇÃO" colado no
`C1:`. As observações geradas pela v157:

| Módulo | Observação gerada | Dashboard lê? |
|---|---|---|
| Produto Acabado | `PRODUÇÃO P1: 3200` / `PRODUÇÃO P2: 2800` | **SIM** — P1 e P2 casam |
| Extrusão | `OPERADOR: <nome>` / `C1: 2450,5 KG` / `C2: 2100,0 KG` | **NÃO** — só o OPERADOR casa |

Resultado: o split C1×C2 do dashboard PA **está caindo no fallback de proxy**
(total de bobinas do turno), ou seja, é **estimado e não medido** — apesar de o
dado real existir, pesado bobina a bobina, do outro lado.

**Correção:** uma linha na v157 (escrever `PRODUÇÃO C1:`) ou ampliar o regex no
VPS. É a menor correção do projeto com o maior efeito imediato.

⟲ **Ordem sugerida:** fazer essa correção **depois** que o repo estiver
publicado, para que ela seja o primeiro commit real do fluxo Git — vira o teste
de ponta a ponta do ciclo "edito aqui → push → `ATUALIZAR.bat` no Mini PC".

### 6.3 RISCO A MEDIR — dupla contagem

Com o Produto Acabado sendo lançado pela v157 **e** lido pelo dashboard, se
alguém ainda lançar manualmente o mesmo turno no Bling, a produção é **contada
em dobro** — o parser SOMA (`+=`) múltiplos pedidos no mesmo turno×dia, não usa
`max()`. Precisa confirmar se o lançamento manual foi desativado.

### 6.4 Pacote M1 (auditoria) — pronto, não executado

Bloco `[CC]` já redigido para rodar no VPS, FASE 1 read-only, gravando em
`DASHBOARDS/OUTPUTS/OUTPUT_MIGRACAO_PESAGEM.TXT`. Ele audita os pedidos dos 7
contatos nos últimos 60 dias: confirma o defeito C1/C2, detecta duplicidade
(contato × data com 2+ pedidos), cataloga formatos de observação e verifica se
retirada de bobinas/MP já gera pedidos de venda. Reusa as funções existentes
(`obter_token_valido`, `consultar_bling`, `buscar_pedido_detalhe`) e escreve o
script em `/tmp` para não tocar no repo.

**M1 e M2 são independentes** — o M1 pode rodar a qualquer momento.

---

## 7. MODELO CONCEITUAL DE LONGO PRAZO (já alinhado)

O destino da estação de pesagem é ser a **semente de um almoxarifado digital**:
toda entrada e saída de MP, PA e insumos codificada digitalmente.

### 7.1 Quatro camadas, duas empresas

| Sistema | Papel | Autoridade sobre |
|---|---|---|
| **VPS / Broker** | Camada operacional | Movimento físico: produção, consumo, transferência, lotes, genealogia, auditoria |
| **Bling** | ERP fiscal Ekoplastic | NF Eko + estoque PA — espelho do VPS |
| **CA Nexa** | ERP fiscal NexaPack (Lucro Real) | NF Nexa + financeiro Nexa — **sem estoque** |
| **CA Eko** | Consolidação financeira | Vendas Nexa + Bling, 100% |

### 7.2 Regra de mestre — dono por tipo de fato

- **Movimento interno** (produção, consumo, transferência): broker é mestre,
  empurra para o ERP
- **Documento fiscal** (NF de venda/compra): o ERP é mestre, o broker ingere
- **EXCEÇÃO — entrada de MP:** inverte. Nasce na pesagem (ver 7.3)

### 7.3 Entrada de matéria-prima (regra institucional da fábrica)

Fornecedores Eko **não emitem nota**; fornecedores Nexa emitem. Há divergência
natural de peso. Por isso: **a entrada de estoque de MP é 100% feita na área de
pesagem**, com três pesos registrados — peso informado pelo fornecedor, peso do
caminhão em balança rodoviária terceirizada, e **peso aferido bag a bag /
palete a palete (o oficial)**.

A partir do peso aferido, o broker dispara **dois efeitos com donos distintos**:
- **Estoque → sempre no Bling** (o estoque físico é sempre da Ekoplastic)
- **Financeiro → CA Eko ou CA Nexa**, conforme quem comprou e se há nota

Consumo dá baixa gradual via cliente fictício "Ekoplastic"
(ID Bling `17804838271`), cruzando com o código do dosador gravimétrico para
giro em dias, preço e saldo.

Aditivos, carbonatos e dessecantes podem entrar pelo fiscal; GBD e Polinylon
**têm** que ser pesados. Isso vira propriedade do item: `entrada_por_pesagem`.

### 7.4 Schema do evento genérico de almoxarifado

Não é greenfield: o schema atual já tem enum fechado
(`CHECK(tipo IN ('recebimento','retorno','retirada','extrusao','outras'))`) e
sistema de migração. É uma **migração**, não uma reescrita.

Campos-alvo:
- **Identidade**: `evento_id`, `timestamp`, `data_negocio`, `turno`, `operador`, `estacao`
- **Natureza**: `tipo`, `categoria` (MP/bobina/PA/insumo)
- **Empresa — DOIS EIXOS**: `empresa_estoque` (sempre Eko) ·
  `empresa_fiscal_financeira` (Eko/Nexa). **Nunca um campo só.**
- **Item e rastreio**: `codigo`, `lote`, `lote_pai` (genealogia), `id_bobina`
- **Pesos**: `peso_aferido` (oficial), `peso_fornecedor`, `peso_rodoviaria`
- **Fiscal**: `tem_nota`, `erp_fiscal`, `gera_contas_pagar`
- **Efeitos**: `efeito_estoque`, `efeito_financeiro`
- **Auditoria**: `usuario`, `origem`/`destino` + log append-only imutável

**Regra de turno:** vale a data-de-negócio do turno, não o timestamp bruto.
Turno C é 22h–06h; bobina bipada às 02h pertence ao Turno C do dia anterior.

### 7.5 KPIs que o modelo destrava (hoje não medidos)

- **Rendimento de extrusão** = kg de MP consumida (dosador) → kg de bobina
  produzida (pesagem), por turno/extrusora. **Valida os 80% hoje assumidos.**
- **Rendimento de conversão** = kg de bobina (bipagem na sacoleira) → kg de PA.
  O "% de aproveitamento de cada bobina". Exige contabilizar **aparas**.
- **Divergência por fornecedor** = peso informado vs peso aferido, sistemático.
- **Custo de MP por turno e por cor** = consumo × R$/kg do CPV.
- **Produtividade kg/h por equipe.**

### 7.6 Fase avançada

Estação de bipagem nas sacoleiras (já parcialmente implementada: estado
`consumida`, `ref_id` e bloqueio de consumo duplo 409), lotes em fardos/pacotes,
cruzamento com EServer das sacoleiras, RBAC multiusuário com visões por perfil,
broker com store-and-forward via Tailscale.

---

## 8. ⟲ PRÓXIMOS PASSOS EM ORDEM

1. ~~**[M2-a]** Copiar `.gitignore` e `.gitattributes` novos para a pasta v157~~
   — ✅ **feito em 25/08/2026**
2. ~~**[M2-b]** Rodar o `CORRIGIR-COMMIT.bat`~~ — ✅ **feito em 25/08/2026
   11:53. Commit `2e022d5`, 100 arquivos, todas as validações OK** — seção 4.3
3. ~~**[M2-c]** Diagnóstico do `serialport` no Mini PC~~ — ✅ **feito.
   Resolvido sem tocar na produção** — seções 4.4.1 a 4.4.3
4. ~~**[M2-d]** Ingerir o `node_modules` e refazer a baseline~~ — ✅ **feito em
   25/08/2026 14:00. Commit `eadbfdf`, 281 arquivos, validação 5.7 = SIM**
5. ~~**[M2-e]** Copiar do Mini PC os 5 arquivos decididos em 4.4.4~~ — ✅
   **feito. Commit `d5b64dd`, 286 arquivos, todas as validações OK**
6. **[M2-f]** Rodar o `CORRIGIR-COMMIT.bat` para absorver o `server.js` sem a
   credencial e o `PUBLICAR.bat`; criar o repo no GitHub como **Private e
   vazio**; rodar o `PUBLICAR.bat` — seções 4.5 e 4.5-b
6. **[M2-f]** Configurar Mini PC com deploy key + `ATUALIZAR.bat` — seção 4.5
7. **[M2-g]** Corrigir a guarda do `INICIAR.bat` para avisar quando o
   `serialport` faltar — seção 4.4
8. **[M1]** Rodar a auditoria da integração no VPS — seção 6.4
9. **[M3]** Corrigir o formato da observação de extrusão (C1/C2) — seção 6.2
10. **[M4+]** Migração de schema para o evento genérico de almoxarifado — seção 7.4

---

## 9. ⟲ O QUE NÃO PODE SER ESQUECIDO

- ⟲ **Nunca escrever segredo dentro do `server.js`.** Ele é versionado. Toda
  credencial vem de variável de ambiente ou de `credenciais-bling.json` — ver
  seção 4.5. Antes de todo push, ler a varredura de segredo que o
  `PUBLICAR.bat` mostra na tela
- **Nunca versionar** `etiquetas.db`, `credenciais-bling.json`, `logs/`,
  `backups/`, `cert/`, `bling_tokens.json`, `dashboard/`, `eko-encerrar.flag`
- **`.gitattributes` com CRLF** para `.bat` — sem isso o `INICIAR.bat` quebra
- ⟲ **`enviar_raw.ps1` tem que ficar em LF**, não CRLF. É gerado pelo
  `server.js`. Com CRLF, o `git pull` do Mini PC falha — seção 4.6, defeito 2
- ⟲ **`!node_modules/**` tem que ser a última linha do `.gitignore.`** Sem ela,
  pacotes inteiros somem do commit e a balança não sobe — seção 4.6, defeito 1
- **Backup do `etiquetas.db` antes de todo `git pull`** no Mini PC
- **Mini PC nunca edita código** — se divergir, `git reset --hard`
- **Push sempre manual e humano**, após validação visual
- ⟲ **Desfazer o `--amend` é `git reset --soft`**, nunca `--hard`: o backup
  guarda o commit, não a árvore de trabalho
- ⟲ **A baseline tem que ser o único commit** enquanto o `--amend` for a
  ferramenta de correção. Com histórico em cima, `--amend` reescreve o commit
  errado
- O fluxo operacional local (pesar → imprimir → bipar) **nunca** pode depender
  de rede, VPS ou broker. Operador não espera servidor para imprimir etiqueta.
