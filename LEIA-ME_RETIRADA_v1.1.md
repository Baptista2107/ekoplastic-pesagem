# Patch v1.1 — Módulo RETIRADA de Matéria-prima

## Arquivos deste pacote

```
server.js                       (substitui o atual — agora com 1.561 linhas)
public/index.html               (ativa o tile RETIRADA — antes era alert)
public/mp-retirada.html         (NOVO — página da Retirada)
```

## Como aplicar

1. **Pare o servidor** (feche o terminal do INICIAR.bat ou Ctrl+C)
2. **Faça backup do banco** (boa prática):
   ```
   copy etiquetas.db etiquetas_backup_antes_v1.1.db
   ```
3. **Substitua os 3 arquivos** por cima dos atuais em:
   ```
   C:\Users\Usuário\Downloads\Projeto Automação\ekoplastic-etiquetas\ekoplastic-etiquetas\
   ```
4. **Inicie o servidor** com INICIAR.bat
5. Na primeira inicialização você verá nos logs:
   ```
   [SCHEMA] Migrando schema para v3 (suporte a retirada)...
   [SCHEMA] Migração v3 concluída. N sessões + M etiquetas preservadas.
   ```
   Isso é **normal e seguro** — preserva todas as 11 sessões e 15 etiquetas existentes.

## O que mudou

### Backend (server.js)

- Schema v3: `etiquetas.tipo` e `sessoes.tipo` agora aceitam `'retirada'`
- Sequência nova: prefixo `S` (Saída) — primeira etiqueta de retirada será `S0000001`
- **Rotas novas**:
  - `POST /etiquetas/:id/consumir` — bipa etiqueta na Retirada (bloqueia se já consumida com HTTP 409 + dados da retirada anterior)
  - `POST /retirada/aditivo` — registra aditivos contados (PIG/DESSEC × N sacos × 25kg)
- **Branch Bling novo**: sessões de retirada usam `POST /Api/v3/pedidos/vendas` com contato Ekoplastic (não fornecedor)
- Compatibilidade total: rotas existentes inalteradas, Recebimento e Retorno seguem como estavam

### Frontend (mp-retirada.html novo)

- Tema laranja `#f07040` (cor de saída)
- 2 sub-abas:
  - **🏷 BIPAGEM** (GBD / POLI / CARBO) — leitor de código de barras, palete inteiro
  - **📦 SACOS 25KG** (PIG / DESSEC) — seletor cor (se PIG) + fornecedor + contador × 25kg
- Modal vermelho de bloqueio quando bipa etiqueta já consumida (mostra data/mês/hora)
- Histórico unificado com totalizadores (itens, kg)
- Captura global de teclado pro leitor Comtac HS-960

## Roteiro de teste sugerido

### Teste 1 — Bipar etiqueta válida
1. Acesse a aba RETIRADA pelo menu principal
2. Na sub-aba 🏷 BIPAGEM, clique em "SIMULAR BIPAGEM" e digite um ID válido (ex: `R0000001`)
3. Deve aparecer no histórico com peso/material/horário

### Teste 2 — Bloqueio de re-bipagem
1. Na mesma sessão, bipa o mesmo ID de novo
2. Deve aparecer modal vermelho 🚫 com: *"Etiqueta R0000001 já foi retirada em DD/MM HH:MM"*

### Teste 3 — Aditivo
1. Sub-aba 📦 SACOS 25KG → escolha PIG → Verde → Karina → 4 sacos → "ADICIONAR ITEM"
2. Deve entrar no histórico como "PIG Verde · Karina · 100,0 kg (4 × 25)"

### Teste 4 — Finalizar
1. Clique em ✓ FINALIZAR
2. Sistema cria sessão #N tipo='retirada' no banco
3. Se `bling_simular='0'` → cria Pedido de Venda real no Bling com contato Ekoplastic
4. Se `bling_simular='1'` → fica como pendente (modo simulação)

### Teste 5 — Retorno continua funcionando
1. Volte ao menu principal → ENTRADA UNIFICADA → aba RETORNO
2. Bipe a mesma etiqueta R0000001 (que agora está consumida)
3. Deve aceitar normalmente (Retorno não bloqueia consumidas — é caso legítimo)

## Modo simulação x modo real

Atualmente o banco está com `bling_simular='1'` (simulação). Para testes reais no Bling:

```
PowerShell:
Invoke-WebRequest -Uri "http://localhost:3000/config" -Method POST -Body '{"chave":"bling_simular","valor":"0"}' -ContentType "application/json"
```

Ou aguardar a sessão ficar "pendente" e enviar manualmente depois.

## Pontos pendentes (v2)

- Identificação operacional (turno/operador/extrusora) — postponed conforme acordado
- Desfazer item individual no histórico (hoje só cancela sessão inteira)
- Endpoint pra reverter consumo (caso operador queira "des-bipar" sem cancelar sessão)
