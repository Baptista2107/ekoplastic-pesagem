# HANDOFF — Migração do Sistema de Pesagem para a estrutura Ekoplastic

> **Para quem lê isto pela primeira vez:** este documento é autossuficiente.
> Ele descreve o objetivo, o estado atual, as decisões já tomadas e o que
> falta fazer. Foi escrito para permitir a continuidade do trabalho numa
> sessão nova (Cowork, com acesso à pasta do projeto).
>
> Data: 25/08/2026 · Versão do sistema: v157 · Autor do sistema: Frederico
> (GitHub: Baptista2107 · mourabaptista@gmail.com)

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
| **PC de Pesagem** (onde este trabalho ocorre) | Desenvolvimento do sistema de pesagem. É a máquina do Frederico | Git 2.53.0, PowerShell, **sem Claude Code**, sem Node | Tailscale `100.81.107.73` · LAN `192.168.3.156` |
| **Mini PC TANCA** | **Produção do chão de fábrica.** Executa o sistema ao lado da balança, com tela touch | Node ≥22.5, Git instalado | Tailscale (acesso via Moonlight) · mesma LAN |
| **VPS Contabo** | Dashboards, crons, ContaAzul, Bling (app dos dashboards) | Ubuntu, Python, Claude Code, Git | Tailscale `100.107.130.115` · painel HTTP `:8765` |
| **PC do outro dev** | Desenvolvimento dos dashboards/Gestão Industrial | Claude Code, Git, SSH ao VPS | Tailscale |

**Regra de ouro:** conta de usuário é para gente; deploy key é para máquina.
- PC de Pesagem → conta GitHub pessoal do Frederico (leitura+escrita)
- Mini PC → **nenhuma conta**, apenas deploy key **somente leitura**
- VPS → deploy key própria, somente leitura

**Fluxo:** código desce (GitHub → Mini PC / VPS), dado sobe (Mini PC → Bling → VPS).

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
   fora do ar com a fábrica rodando. Máquina única, plataforma fixa
   (Windows x64) → o binário é sempre o mesmo. **ATENÇÃO: ver bloqueio 4.4.**
4. **`.gitattributes` é crítico:** sem `*.bat text eol=crlf` e
   `*.ps1 text eol=crlf`, o Git pode converter para LF e **quebrar o
   `INICIAR.bat` e o `enviar_raw.ps1`** — ou seja, quebrar a inicialização e a
   impressão de etiquetas.
5. **`package.json` alinhado:** estava `1.44.0` enquanto `server.js` dizia
   `v157`. Corrigido para `157.0.0` (o `/healthcheck` mostra a versão).

### 4.2 O que já foi feito

- Pasta de trabalho:
  `C:\Users\Usuário\Downloads\Projeto Automação\ekoplastic-etiquetas\ekoplastic-etiquetas\v157`
- `git config --global user.name "Baptista2107"` e
  `user.email "mourabaptista@gmail.com"` — configurados
- Chave SSH já existente na máquina e **já autenticando no GitHub**
- Criados e aplicados: `.gitignore`, `.gitattributes`, `package.json` (157.0.0),
  `SETUP-GIT.bat`
- `git init -b main` executado
- **Commit de baseline feito** (último hash conhecido: `71e38ec`), tag `v157` criada
- Tailscale funcionando: o PC de Pesagem alcança o VPS
  (`Test-NetConnection 100.107.130.115 -Port 8765` → `TcpTestSucceeded : True`)

### 4.3 PENDÊNCIA IMEDIATA — commit sujo

O commit atual tem **96 arquivos**, mas deveria ter **94**. Entraram dois
arquivos indevidos:
- `files.zip` — arquivo solto, sem relação com o sistema
- `SETUP-GIT-LOG.txt` — log gerado pelo próprio script de setup (runtime)

Houve uma tentativa de correção com `git rm --cached` + `git add -A` +
`git commit --amend`, **que não funcionou**: o `.gitignore` em vigor no commit
tem 32 linhas (versão antiga, sem as regras `*.zip` e `SETUP-GIT-LOG.txt`), então
o `git add -A` recolocou os arquivos.

**A fazer:**
1. Confirmar que o `.gitignore` da pasta é a versão nova (deve conter as linhas
   `SETUP-GIT-LOG.txt` e `*.zip`). Se não for, aplicar a versão correta.
2. `git rm --cached files.zip SETUP-GIT-LOG.txt`
3. `git add -A`
4. `git commit --amend --no-edit`
5. `git tag -d v157` e recriar `git tag -a v157 -m "..."`
6. Validar com `git ls-files | Measure-Object -Line` → esperado **94**

Como nada foi publicado ainda, o `--amend` é seguro e deixa a baseline limpa.

### 4.4 BLOQUEIO PRINCIPAL — `serialport` ausente

O `node_modules` da pasta v157 contém **apenas `node-forge`**. Não há
`serialport`, não há `@serialport/parser-readline`, e não há nenhum binário
nativo `.node`.

Consequência: **este repositório, como está, não roda a balança.** Se o Mini PC
clonar em pasta nova, o sistema sobe, as telas abrem e a impressão funciona,
mas a leitura da balança cai no `try/catch` do `server.js` e fica desativada
(o código já prevê isso e apenas loga "Módulo serialport não disponível").

**Hipótese mais provável:** o Mini PC tem um `node_modules` completo, instalado
uma vez com `npm install`, e os ZIPs aplicados nunca substituíram essa pasta.

**A fazer — verificação no Mini PC (via Moonlight):**
- Abrir a pasta do sistema em produção e listar `node_modules`
- Confirmar se existem `serialport` e `@serialport`
- Se existirem: copiar esse `node_modules` completo para a pasta de
  desenvolvimento e refazer o commit, para que a baseline no GitHub seja
  funcional
- Se não existirem: descobrir onde o `serialport` está instalado antes de publicar

**Não publicar no GitHub antes de resolver isto.** Melhor a baseline nascer
correta do que corrigir com commit de remendo.

### 4.5 Depois de resolvido — publicar e conectar

1. Criar no GitHub o repo `ekoplastic-pesagem` (**Private**, sem README/
   .gitignore/licença, pois a pasta já tem conteúdo)
2. `git remote add origin git@github.com:Baptista2107/ekoplastic-pesagem.git`
3. `git push -u origin main` e `git push origin v157`
4. No Mini PC: gerar chave, cadastrar como **deploy key read-only** do repo,
   clonar em pasta nova, copiar para dentro os arquivos de runtime
   (`etiquetas.db`, `credenciais-bling.json`, `logs/`, `backups/`, `cert/`),
   subir, conferir `/healthcheck`, e só então trocar as pastas
5. Criar um `ATUALIZAR.bat` no Mini PC que faça: backup do `etiquetas.db` →
   `git pull` → reinicia → mostra `/healthcheck`. Um duplo-clique, sem terminal.
6. Rollback passa a ser `git checkout v157` + reiniciar

---

## 5. FRENTE B — MÉTODO DE TRABALHO

Padronizado a partir dos chats do Cérebro de Manutenção; documento de
referência: `PADRAO_TRABALHO_VPS.md` (já atualizado no Project Knowledge).

**Marcadores** — sempre FORA da caixa de código:
- `[VPS]` — comando para o terminal do VPS
- `[CC]` — bloco para o Claude Code
- `[PC-PESAGEM]` — comando para o PC de pesagem (marcador novo, a formalizar)

**Regra de relatório:** todo bloco grava `OUTPUT_<NOME>.TXT` na pasta de
outputs no Drive (`/mnt/drive/EKOPLASTIC/DASHBOARDS/OUTPUTS/`), com escrita
incremental por fase (append+flush); só a última fase escreve
`=== FIM DO DIAGNOSTICO ===`. O rclone espelha; a leitura é feita de lá.

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

## 8. PRÓXIMOS PASSOS EM ORDEM

1. **[M2-a]** Corrigir o commit sujo (96 → 94 arquivos) — seção 4.3
2. **[M2-b]** Resolver o `serialport` ausente — seção 4.4 · **BLOQUEIA A PUBLICAÇÃO**
3. **[M2-c]** Criar repo no GitHub, publicar, taguear — seção 4.5
4. **[M2-d]** Configurar Mini PC com deploy key + `ATUALIZAR.bat` — seção 4.5
5. **[M1]** Rodar a auditoria da integração no VPS — seção 6.4
6. **[M3]** Corrigir o formato da observação de extrusão (C1/C2) — seção 6.2
7. **[M4+]** Migração de schema para o evento genérico de almoxarifado — seção 7.4

---

## 9. O QUE NÃO PODE SER ESQUECIDO

- **Nunca versionar** `etiquetas.db`, `credenciais-bling.json`, `logs/`,
  `backups/`, `cert/`
- **`.gitattributes` com CRLF** para `.bat` e `.ps1` — sem isso a impressão quebra
- **Backup do `etiquetas.db` antes de todo `git pull`** no Mini PC
- **Mini PC nunca edita código** — se divergir, `git reset --hard`
- **Push sempre manual e humano**, após validação visual
- O fluxo operacional local (pesar → imprimir → bipar) **nunca** pode depender
  de rede, VPS ou broker. Operador não espera servidor para imprimir etiqueta.
