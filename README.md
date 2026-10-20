# Ekoplastic — Estação de Pesagem

Sistema de chão de fábrica que roda no **Mini PC da pesagem** (Windows, tela de toque,
`C:\Ekoplastic\pesagem`). Pesa e etiqueta matéria-prima, bobinas de extrusão e produto
acabado, controla retirada de bobinas, inventário, endereçamento e separação, e lança
tudo no **Bling**. O coletor **TC60** e os celulares usam as telas pela rede (HTTPS).

Como o sistema funciona por dentro (telas, banco, Bling, impressão, regras de negócio
que não são óbvias): **[docs/sistema.md](docs/sistema.md)**.

## Estrutura

```
server.js        sobe o sistema: carrega lib/ em ordem, despacha para rotas/, serve public/
lib/             config, log, banco (schema e migrações), balança, Bling (OAuth v3),
                 impressão EPL2, endereçamento, separação, bobinas, turnos, atualização
rotas/           as rotas HTTP, um arquivo por assunto (sistema, etiquetas, sessoes,
                 catalogo-mp, produto-acabado, enderecamento, separacao, dashboard,
                 bobinas, inventario)
public/          as telas (HTML puro, sem build) e os scripts comuns
testes/          testes automatizados; cada um sobe o server.js real em banco temporário
android/         app do coletor TC60 (WebView que abre as telas pela rede)
docs/            documentação; docs/historico/ guarda o que já foi feito e não muda mais
node_modules/    VERSIONADO de propósito: o serialport é nativo e não pode depender de
                 npm install no chão de fábrica
*.bat / *.ps1    utilitários do Windows (tabela abaixo)
```

Gerados pela máquina e **fora do git** (ver `.gitignore`): `etiquetas.db` (o banco, dado
real), `credenciais-bling.json` e `bling_tokens.json`, `cert/` (HTTPS, gerado no 1º boot),
`logs/`, `backups/`, `guias/` (fotos das guias de separação), `eko-*.flag`, `estacao.txt`,
`OUTPUT_*.TXT`.

## Portas

| Porta | Escuta | Para quê |
|---|---|---|
| 3000 | `127.0.0.1` | HTTP local — as telas do Mini PC |
| 3443 | rede | HTTPS — TC60 e celulares (câmera exige HTTPS) |
| 8888 | `127.0.0.1` | callback do OAuth do Bling |

Variáveis de ambiente (usadas pelos testes): `EKO_PORT`, `EKO_PORT_HTTPS`, `EKO_PORT_CB`,
`EKO_DB_FILE`, `EKO_LOG_DIR`, `EKO_GUIAS_DIR`, `EKO_TOKEN_FILE`, `EKO_SERIAL_PORT`
(a balança está na `COM1`, definida no `INICIAR.bat`), `EKO_PRINT_SIMULAR`.

## Rodar

Pré-requisitos no Mini PC: **Node.js 22.5+** (usa o `node:sqlite` nativo; a estação está
no 24), Google Chrome, impressora térmica EPL2 e balança na serial.

- **`INICIAR.bat`** sobe o servidor num laço (caiu, volta em 5 s) e abre a tela em modo
  quiosque. Rodar de novo com o sistema aberto só reabre a tela.
- **`ABRIR-TELA.bat`** reabre só o navegador, sem mexer no servidor.
- `/healthcheck` mostra versão (commit), impressora, balança, Bling e início automático.

### Início automático com o Windows

1. `ATIVAR-INICIO-AUTOMATICO.bat` (uma vez): cria um atalho do `INICIAR.bat` na pasta
   *Inicializar*. Vale para atualizações futuras, porque aponta para a pasta.
2. **Login automático** — sem ele o Mini PC (sem teclado) para na tela de senha:
   `Windows + R` → `netplwiz` → desmarcar *"Os usuários devem digitar um nome e senha…"*
   → OK e informar a senha da conta.
3. Testar reiniciando o Mini PC. Para desligar: `DESATIVAR-INICIO-AUTOMATICO.bat`.

O `conferir-inicio-automatico.ps1` confere e corrige o atalho a cada início e grava o
resultado em `eko-autostart.json`, que aparece no `/healthcheck`.

## Atualizar a estação

O Mini PC é um clone deste repositório. A atualização só troca código: banco, tokens,
logs e certificado não são versionados, então nada disso é tocado.

- **Remota (jeito padrão):** `POST /sistema/atualizar` com a senha de supervisor. O
  servidor só aceita se `GET /sistema/janela-atualizacao` disser que é seguro (nenhuma
  sessão aberta, sem bipagem recente); grava `eko-atualizar.flag` e encerra; o
  `INICIAR.bat` faz `git merge --ff-only` com o node parado e sobe de novo. O resultado
  fica em `OUTPUT_ATUALIZACAO_REMOTA.TXT`. Se algo falhar, sobe o código que já estava.
- **Do PC de quem desenvolve:** `ENVIAR-ATUALIZACAO.bat` roda todos os testes, faz commit
  e push e dispara a atualização remota (`DESCOBRIR-MINIPC.bat` grava o endereço da
  estação em `estacao.txt`). `SINCRONIZAR-COM-GITHUB.bat` só traz o que está no GitHub.
- **No próprio Mini PC:** `ATUALIZAR.bat`.

## Testes

```
node testes/rodar-todos.js      (ou npm test, ou RODAR-TESTES.bat)
```

Roda todo `testes/*.js` (menos os `_auxiliares`), um por vez, cada um com o `server.js`
real em portas de teste, banco temporário, Bling e impressão simulados. Não encosta em
produção. Leva uns 2 minutos. É o portão do `ENVIAR-ATUALIZACAO.bat`: teste novo em
`testes/` entra no portão sozinho.

## Logs e backups

- `logs/AAAA-MM-DD.log` — log geral do dia (impressão, bipagem, sessões, Bling, erros).
- `logs/mp/movimentacao-*.jsonl`, `logs/extrusao/`, `logs/producao/` — movimentos por área.
- `logs/desvios-AAAA-MM.jsonl` — desvios de segurança (saída do quiosque etc.).
- `backups/etiquetas-AAAAMMDD.db` — cópia diária do banco (no início e a cada 6 h),
  mantém as 7 mais recentes.

## Utilitários

| Arquivo | Para quê |
|---|---|
| `CALIBRAR-IMPRESSORA.bat` | calibra a impressora ao trocar o tamanho da etiqueta |
| `DIAGNOSTICO.bat` | diagnóstico da impressora |
| `GERAR-DASHBOARD.bat` | gera o dashboard autônomo em `dashboard/` |
| `LIBERAR-ACESSO-CELULAR.bat` | abre a porta 3443 no firewall (pede administrador) |

## Problemas comuns

- **Impressora não imprime:** ver `/healthcheck` (impressora ativa) e
  `POST /impressora/redetectar`. A ordem de preferência é `PRINTER_NAMES` em
  `lib/config.js`.
- **Balança não conecta:** conferir a porta em `/balanca/portas` e o `EKO_SERIAL_PORT`
  do `INICIAR.bat`; na balança, `rS1-02 = n81` e `rS1-04 = StrEAn`. O servidor tenta
  reconectar sozinho.
- **Bling "não autenticado":** Opções → Autenticar Bling. Os tokens ficam em
  `bling_tokens.json` e são renovados sozinhos.
- **Celular/TC60 não abre:** mesma rede, `https://<IP-do-Mini-PC>:3443`, aceitar o aviso
  do certificado; se preciso, `LIBERAR-ACESSO-CELULAR.bat`.

## Modo simulação do Bling

Com `bling_simular = 1` na config (o padrão num banco novo) o sistema monta e registra
no log o que enviaria, marca a sessão como enviada com `bling_id = SIM-<hora>` e **não
chama** o Bling. Em produção é `0`. Os testes sempre rodam simulados.
