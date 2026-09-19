# Padrão de Trabalho — Infra VPS + Dinâmica Claude.ai ↔ Claude Code

Documento de referência pra iniciar novos desenvolvimentos seguindo o modelo Ekoplastic-Bling. Resume infraestrutura, automação, organização de arquivos e o fluxo de colaboração entre Claude.ai (Web/Mobile) e Claude Code (VPS).

---

## 1. Infraestrutura

### Servidor
- **Provider**: Contabo (VPS dedicado)
- **OS**: Ubuntu 24 LTS
- **Usuário operacional**: `ekoplastic` (não-root, com sudo via venv)

### Endereços
| Tipo | Valor |
|---|---|
| IP público | `194.5.152.35` |
| Tailscale | `100.107.130.115` |
| Painel web | `http://100.107.130.115:8765` |
| Repositório Git | `github.com/fredericolm/bling-claude` |

### Storage
- **Workdir do código**: `/home/ekoplastic/bling-claude/`
- **Drive montado** (outputs e dados pesados): `/mnt/drive/EKOPLASTIC/`
- **Subpasta principal de saída**: `/mnt/drive/EKOPLASTIC/DASHBOARDS/`
- **Outputs de desenvolvimento** (relatórios VPS/CC): `/mnt/drive/EKOPLASTIC/DASHBOARDS/OUTPUTS/`

### Acesso
- SSH via chave pública (configurado na máquina principal de desenvolvimento Windows)
- Tailscale conecta máquina principal ao VPS via IP privado `100.107.130.115`
- Painel HTTP serve dashboards na porta 8765
- A máquina secundária Windows (nova) NÃO tem SSH/GitHub configurado — fluxo é editar via Claude.ai, baixar arquivos, transferir pra máquina principal

---

## 2. Estrutura de arquivos

### Scripts Python principais
Todos em `/home/ekoplastic/bling-claude/`:

| Script | Propósito |
|---|---|
| `carteira_pedidos_ekoplastic.py` | Pedidos em aberto, gera dashboard_carteira |
| `dashboard_pa_ekoplastic.py` | Produto Acabado (PA), estoque, gravimétricos |
| `dashboard_mp_ekoplastic.py` | Matéria Prima, consumo, giro, dosadores |
| `dashboard_faturamento_ekoplastic.py` | Vendas, comissões, representantes |
| `dashboard_fluxo_caixa_nexa.py` | Fluxo de caixa Nexa |
| `rebuild_cpv_4tabs.py` | CPV por mês (Eko + Nexa, MP + PA) |
| `cadastrar_venda_contaazul.py` | Cadastra venda Conta Azul a partir de PDF |
| `inserir_pedido_bling.py` | Insere pedido no Bling a partir de Excel |
| `gerar_relatorio_html.py` | Relatório HTML do PA |
| `painel_controle.py` | Servidor web do painel 8765 |

### Wrappers (shell scripts)
Padrão: `set -e`, checagem `mountpoint -q /mnt/drive`, log em `logs/cron/`, ativação venv, timeout 600s:

- `run_dashboard_pa.sh`
- `run_dashboard_mp.sh`
- `run_dashboard_carteira.sh`
- `run_dashboard_faturamento.sh`
- `run_rebuild_cpv.sh`

### Outputs (Drive)
`/mnt/drive/EKOPLASTIC/DASHBOARDS/`:

- HTMLs: `dashboard_pa.html`, `dashboard_mp.html`, `dashboard_carteira.html`, `dashboard_faturamento.html`, `dashboard_fluxo_caixa_nexa.html`, `dashboard_cpv_mp.html`
- JSONs: `dashboard_carteira_data.json` (geocache, watermarks), `historico_gravimetricos_YYYY-MM.json`
- Mensais: `historico_gravimetricos_2026-04.json`, `2026-05.json`, `2026-06.json`

### Pastas auxiliares no Drive
- `/mnt/drive/EKOPLASTIC/DASHBOARDS/COMPRAS MP/` — Excels CA Eko/Nexa cumulativos
- `/mnt/drive/EKOPLASTIC/DASHBOARDS/PEDIDOS EM ABERTO/` — Excels de representantes
- `/mnt/drive/EKOPLASTIC/FATURAMENTO/CADASTRADOS/MAIO_26/`, `JUNHO_26/` — PDFs faturados

### Módulos centralizados
- `feriados.py` — calendário de feriados nacionais + helpers `eh_dia_util`, `listar_feriados_ano`
- `feriados_extra.json` — feriados municipais/regionais (Goiânia)
- `aliases_representante.json` — aliases CNPJ → representante (5 entradas)
- `bling_tokens.json` — access_token Bling v3

### Caches e estado local (gitignored)
- `faturamento_cache.json` (~7.6 MB)
- `carteira_cache.json`
- `cpv_dashboard_data.json`
- `cpv_meses_fechados.json` — meses CPV congelados
- `carteira_snapshot.json` — diff de pedidos
- `pa_typos.log`, `cadastro_typos.log`, `inserir_typos.log`
- `cpv_snapshots_ignorados.log`
- `sacola_costs.json`, `mat_cost_series.json`, `diesel_precos.json`
- `geocache.json` — geocoding Nominatim

---

## 3. Automação (cron)

Crontab do usuário `ekoplastic`. Cobre todo horário comercial brasileiro com ingestão contínua de dados:

| Job | Frequência | Volume |
|---|---|---|
| Ingestão dosadores | `*/5 * * * *` | 288 runs/dia |
| Dashboard MP | `15,30,45,0 * * * *` | 96 runs/dia |
| Rebuild CPV | `10,25,40,55 * * * *` | 96 runs/dia |
| Dashboard PA + Relatório | `0,30 7-19 * * *` | 26 runs/dia |
| Dashboard Carteira | `0,30 7-19 * * *` | 26 runs/dia |
| Dashboard Faturamento | `0 8 * * *` | 1 run/dia |
| Financeiro | `30 18 * * *` | 1 run/dia |

Todos os jobs gravam log em `~/bling-claude/logs/cron/JOB_YYYY-MM-DD.log`. Exit codes tratados (124 = timeout) com mensagens distintas. Falhas preservam cache anterior (blindagem 3 camadas no caso da carteira).

---

## 4. Aliases shell

Bash aliases em `~/.bashrc` do user ekoplastic:

```
alias cadastrarca='cd ~/bling-claude && source venv/bin/activate && python cadastrar_venda_contaazul.py'
alias inserir='python inserir_pedido_bling.py'
alias dashfat='python dashboard_faturamento_ekoplastic.py'
alias dashmp='python dashboard_mp_ekoplastic.py'
alias dashpa='python dashboard_pa_ekoplastic.py'
alias dashcart='python carteira_pedidos_ekoplastic.py'
```

---

## 5. Dinâmica Claude.ai ↔ Claude Code

O fluxo opera em **três atores**:

- **Frederico** — gestor Ekoplastic, opera mobile/desktop, valida visualmente
- **Claude.ai** (este aqui) — recebe pedidos do Frederico, planeja, monta blocos estruturados, valida relatórios
- **Claude Code** (no VPS) — recebe blocos, executa, reporta de volta

### Fluxo típico de um pacote

1. Frederico identifica problema/feature, abre conversa no Claude.ai
2. Claude.ai faz perguntas-chave pra entender escopo (recomendações com opções A/B/C quando há decisões pendentes)
3. Claude.ai monta **bloco estruturado** copiável, rotulado `[VPS]` ou `[CC]` (CONTEXTO + FASE 1 read-only + FASE 2 implementar + FASE 3 validar + COMMIT + REPORTAR)
4. Frederico cola o bloco no destino indicado pelo rótulo
5. A execução grava o relatório em `OUTPUT_<NOME>.TXT` na pasta de outputs do Drive (ver §5.1)
6. rclone espelha o arquivo; Frederico avisa "concluído"
7. Claude.ai **lê o arquivo direto do Drive** (Frederico não precisa colar o conteúdo), revisa e propõe ajustes
8. Frederico valida visualmente no browser (desktop + mobile)
9. Frederico faz push manual (`git push origin main`)

### Por que essa divisão de trabalho

- **Claude.ai**: planeja, mantém contexto longo, propõe decisões, valida relatórios. Tem acesso a arquivos do projeto via project_knowledge, pode pesquisar histórico, manter pendências em mente
- **Claude Code**: executa no VPS com acesso direto a arquivos e ferramentas. Faz investigação read-only profunda, edição cirúrgica, smoke tests, commits locais
- **Frederico**: aprova decisões, valida visualmente, controla quando push acontece

Resultado: contexto longo preservado, execução isolada e auditável, controle humano nas portas críticas (decisão de design + push final).

---

## 5.1 Marcadores, outputs e regras de bloco

> **Premissa de trabalho fixada por Frederico** (chats 2.0 e 3.0 do Cérebro de Manutenção),
> válida para **todos os desenvolvimentos da Gestão Industrial Ekoplastic** — dashboards,
> cérebro de manutenção, pesagem/almoxarifado e o que vier.

### Marcadores obrigatórios

Todo bloco vem rotulado, e **o rótulo fica FORA da caixa de código**:

- **`[VPS]`** — comando para colar no terminal do VPS
- **`[CC]`** — bloco para o Claude Code

Motivos (ambos já causaram erro real):
- Rótulo dentro da caixa vira comando e o bash reclama.
- Trechos de Python dentro de bloco `[CC]` são **conteúdo a editar**, nunca vão para o terminal.

**Um bloco por vez**, copiado e colado inteiro. Frederico é leigo em terminal: nunca misturar
`[VPS]` e `[CC]` na mesma mensagem e deixar ele adivinhar o destino.

### Regra de relatório — em TODO bloco

- Arquivo `OUTPUT_<NOME_DO_DESENVOLVIMENTO>.TXT` — **um arquivo por desenvolvimento**
- **Escrita incremental por fase** (append + flush) — se travar no meio, o que rodou está salvo
- Só a **última fase** escreve `=== FIM DO DIAGNOSTICO ===`
- **VPS e CC gravam na MESMA pasta** — é de lá que o Claude.ai lê
- Primeira linha do bloco confirma que a pasta existe antes de escrever:
  `ls -d "$DIR" || mkdir -p "$DIR"`

### Pasta de outputs (Gestão Industrial)

| Projeto | Pasta |
|---|---|
| Dashboards / Gestão Industrial | `/mnt/drive/EKOPLASTIC/DASHBOARDS/OUTPUTS/` |
| Cérebro de Manutenção | `/mnt/drive/EKOPLASTIC/CEREBRO_CODIGO/OUTPUTS/` |

Separar relatório de desenvolvimento do output de produção: os HTMLs/JSONs dos dashboards
continuam em `DASHBOARDS/`, os `OUTPUT_*.TXT` vão para `DASHBOARDS/OUTPUTS/`.
(Legado a migrar: `OUTPUT.TXT`, `OUTPUT_VPS.TXT`, `OUTPUT_P141_*`, `OUTPUT_P142_*`, `CC_OUTPUT.txt`.)

### Blocos para o CC são autossuficientes

O CC **não vê a conversa do Claude.ai**. Enunciado inteiro sempre — inclusive em correção,
repetindo o enunciado completo, não só o delta.

- **FASE 1 read-only sempre PARA e reporta** antes de implementar
- Fechar todo bloco pedindo: *"o que você achou que contraria este desenho"*
- **Espelhar os `.py` alterados** na pasta de código do Drive ao final (o espelho desatualiza
  no instante em que o CC salva, e o INDEX passa a mentir)

### Duas disciplinas que vieram de erro real

- **Nunca dar limiar de teste sem medir.** Um limiar chutado ("5/5 e 20/20", real 4/5 e 17/20)
  quase fez o CC reverter trabalho correto.
- **Só vai pro CC o que exige ambiente.** Análise, desenho, redação e escrita de código
  acontecem no chat — custo zero. Cada rodada de CC custa **US$ 5–15**. Rodar contra o banco
  real, medir latência, migração e restart: aí sim.

### O CC contesta com medição

Quando o Claude Code contesta um desenho apresentando dado medido, **geralmente tem razão**.
Registrar a correção em vez de insistir.

---

## 6. Padrão de bloco estruturado

Modelo que Claude.ai sempre usa pra mandar tarefa pro Claude Code:

```
PACOTE N — NOME CURTO

CONTEXTO
  Descrição do problema/feature em 3-5 linhas.
  Decisões já tomadas + premissas explícitas.

FASE 1 — INVESTIGAÇÃO READ-ONLY  (quando há ambiguidade)
================================
1.1 Comando de inspeção
1.2 Spot check de dados reais
1.3 ...
1.N Reportar achados A) B) C) ...
PARAR. Reportar.

FASE 2 — IMPLEMENTAR
====================
2.1 Backup:
    cp arquivo.py arquivo.py.bak-$(date +%Y%m%d-%H%M%S)

2.2 Edição com bloco DE/PARA explícito

2.3 py_compile + regerar:
    python -c "import py_compile; py_compile.compile('arquivo.py', doraise=True); print('OK')"
    python arquivo.py 2>&1 | tail -10

FASE 3 — VALIDAÇÃO
==================
3.1 Spot check numérico esperado
3.2 Visual no HTML gerado
3.3 Sem regressão em X, Y, Z

COMMIT
======
tipo(escopo): título curto

- bullet 1
- bullet 2
- premissa explícita

NÃO PUSHAR.

REPORTAR
========
- Hash do commit local
- Checklist de validação
- Aguardar validação visual antes do push
```

### Quando dividir em duas mensagens

Se há **ambiguidade técnica** ou **decisão de design pendente**, manda só a FASE 1 (investigação read-only). Aguarda relatório. Toma decisão. Manda FASE 2/3.

Se está **claro o que fazer**, manda tudo de uma vez.

---

## 7. Convenções operacionais

### Commits
- Formato: `tipo(escopo): título`
  - `feat` — feature nova
  - `fix` — correção de bug
  - `refactor` — reorganização sem mudar comportamento
  - `docs` — documentação
- Mensagem com bullets explicando o que mudou e por quê
- Premissas explícitas no corpo (ex: "Assume pedido em aberto não reserva estoque físico")

### Push
- Sempre manual, pelo Frederico
- Nunca automatizado
- Push depois da validação visual no browser
- Hash do último commit listado no `git log` confirma estado

### Branches
- **Main direto** pra mudanças isoladas ou bem definidas
- **Branch temporária** (ex: `pacote-31-ordem-producao`) quando há sequência multi-commit que mexe no mesmo arquivo. Merge fast-forward + delete branch ao final
- Convenção de nome: `pacote-N-tema`

### Backups antes de editar
- Sempre antes de qualquer edição: `cp arquivo.py arquivo.py.bak-$(date +%Y%m%d-%H%M%S)`
- Backups ficam locais, nunca commitados (gitignored por extensão)

### Validação obrigatória
- `py_compile` como smoke test
- Regerar o dashboard (`python script.py`) pra confirmar exit 0
- Spot check numérico com dados reais quando há cálculo envolvido
- Visual no browser quando há mudança de UI

### Watermarks e banners
Mudanças invisíveis (drops silenciosos, fallbacks aplicados, snapshots ignorados) registram entry em `watermarks_blindagem` do JSON do dashboard. Banner amarelo no HTML alerta o usuário com botão "marcar como visto" (localStorage). Padrão criado no Pacote 2 e estendido nos Pacotes 16, 28, 33.

### Pendências
Após cada pacote, lista 3 níveis:
- **ALTA** — bugs ativos ou impactam decisões de negócio
- **MÉDIA** — refinamentos, edge cases conhecidos, automação
- **BAIXA** — limpeza, investigações sem prazo

---

## 8. Boas práticas observadas

### Refactor mínimo
Cirurgia, não reforma. Mudar só o estritamente necessário. Reuso de infra existente sempre preferido a duplicação.

### Decisões com opções
Quando há dúvida de design, apresenta 2-3 opções (A/B/C) com prós/contras e recomendação. Frederico decide. Bloco FASE 2 só é montado depois da decisão.

### O que NÃO está mudando
Sempre mencionar explicitamente. Reduz ansiedade do usuário e foca atenção no que mudou. Ex: "Bobinas intocadas — endereçar quando implementar controle de estoque".

### Edge cases viram pendências
Não bloqueiam o pacote atual. São documentados na lista de pendências (geralmente MÉDIA) e endereçados quando aparecem em produção.

### Diagnóstico antes de fix
Sempre identificar root cause antes de propor solução. Reproduzir o bug em código quando possível (CC frequentemente faz harness Python pra reproduzir o cálculo do dashboard). Sem diagnóstico, fix é palpite.

### Mobile-first em UI
Dashboard é consumido em mobile (Frederico opera muito do celular). Layout grid responsivo, cards empilham em coluna em viewport pequeno, tabelas com scroll horizontal.

### Reportar com números reais
Relatórios devem incluir cenários reais (ex: "Feira de Santana — 13.600 kg líquido — 1,55 dias"), não só "OK". Isso é prova de que o fix funcionou onde importa.

---

## 9. Replicar pra novo projeto

Pra iniciar um novo desenvolvimento seguindo esse modelo:

### Setup mínimo no VPS
- VPS Ubuntu 24 com user dedicado (não-root)
- Tailscale instalado e ativo
- SSH key configurada da máquina de dev
- Git, Python 3, venv, libs do projeto
- Repo Git criado (público ou privado)
- Estrutura inicial: `repo/`, `repo/logs/cron/`, `mnt/drive/` (se vai ter outputs pesados)

### Convenções iniciais
- Criar `CLAUDE.md` no root do repo com:
  - Aliases shell
  - Cron jobs
  - Paths importantes
  - Convenções de commit
- Configurar Project Knowledge no Claude.ai apontando pro repo
- Setar Claude Code no VPS (ou usar Claude.ai diretamente via SSH MCP)

### Primeiro pacote
- Frederico descreve o problema
- Claude.ai investiga via project_knowledge ou pede FASE 1 read-only
- Itera até bloco claro
- Frederico cola no Claude Code, executa, reporta
- Validação visual + push

A partir daí, cada novo pacote segue o mesmo ritmo. O padrão se mantém porque:
- Blocos são auto-explicativos (qualquer pessoa lendo entende)
- Commits são auto-documentados
- Pendências enumeradas mantêm visibilidade de tudo que ficou pra depois

---

## 10. Resumo executivo

VPS Contabo Ubuntu 24, IP público `194.5.152.35`, Tailscale `100.107.130.115`. User `ekoplastic`, workdir `/home/ekoplastic/bling-claude/`, repo `github.com/fredericolm/bling-claude`. Drive em `/mnt/drive/EKOPLASTIC/`. Cron com 7 jobs diferentes cobrindo 5min até 1×/dia. Sete dashboards diferentes gerados automaticamente.

Trabalho organizado em **pacotes** numerados. Cada pacote: contexto, investigação read-only quando necessário, implementação cirúrgica, validação, commit local, push manual após validação visual.

Claude.ai planeja e valida, Claude Code executa no VPS, Frederico aprova decisões e controla push. Resultado: contexto longo preservado, execução isolada, controle humano nos pontos críticos, histórico Git limpo, dashboards estáveis em produção há 6+ semanas.
