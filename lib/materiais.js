// ════════════════════════════════════════════════════════════════════
//  MATÉRIAS-PRIMAS — catálogo, mapas do Bling, sementes e backup diário
// ════════════════════════════════════════════════════════════════════

const fs     = require('fs');
const path   = require('path');

const { BACKUP_DIR, DB_FILE } = require('./config');
const { logI, logW } = require('./log');
const { configGet, configSet, db, dbStmts } = require('./db');

// ──────────────────────────────────────────────────────────────────
//  MATERIAIS DE MP: nome popular, cores válidas e a abreviação da cor
//  dentro da SKU (ex: GBD.CAN.CED → "CAN" é o corLabel de Canela).
//
//  As abreviações viviam fixas no HTML da tela de Recebimento; passaram
//  para cá porque cor nova precisa nascer com a dela. Foram copiadas uma
//  a uma do que já rodava em produção — repare que Preto é "PTO" no grão
//  e "PRE" no pigmento. NÃO uniformizar: a SKU vai para o Bling, e casar
//  o produto errado lá é lançamento errado de estoque.
// ──────────────────────────────────────────────────────────────────
const MP_MATERIAIS_PADRAO = {
  GBD:    { popular: 'Grão Baixa Densidade', cores: ['Colorido','Canela','Preto','Leitoso'],
            corLabel: { 'Colorido':'COL', 'Canela':'CAN', 'Preto':'PTO', 'Leitoso':'LEI' } },
  POLI:   { popular: 'Polinylon',            cores: ['Colorido','Canela','Cristal','Leitoso'],
            corLabel: { 'Colorido':'COL', 'Canela':'CAN', 'Cristal':'CRIS', 'Leitoso':'LEI' } },
  // Resina EVOH (30/09/2026) — substitui o Polinylon da Tallpack nas cores
  // Cristal e Leitoso. Big bag pesado, como o Polinylon. As abreviações da
  // SKU seguem as do Polinylon (CRIS/LEI) de propósito.
  EVOH:   { popular: 'Resina EVOH', nomeEtiqueta: 'RESINA EVOH', cores: ['Cristal','Leitoso'],
            corLabel: { 'Cristal':'CRIS', 'Leitoso':'LEI' } },
  CARBO:  { popular: 'Carbonato',            cores: [], corLabel: {} },
  PIG:    { popular: 'Pigmento',             cores: ['Amarelo','Branco','Preto','Verde'],
            corLabel: { 'Amarelo':'AMA', 'Branco':'BRA', 'Preto':'PRE', 'Verde':'VER' } },
  DESSEC: { popular: 'Dessecante',           cores: [], corLabel: {} },
  // Auxiliar de fluxo (28/09/2026). Sem cor, em sacos de 25 kg, como os
  // demais aditivos: entra por número de sacos e sai por número de sacos.
  AUXFLUX:{ popular: 'Auxiliar de Fluxo',    cores: [], corLabel: {} },
};

// Troca de produto: chave antiga → chave nova. Ver aplicarSubstituicao().
// VAZIO desde 30/09/2026 (noite): a troca Polinylon Tallpack → Resina EVOH
// foi DESFEITA a pedido do Frederico — as etiquetas voltam a ser lidas como
// Polinylon. O mecanismo continua no código e só age se alguém cadastrar
// uma troca em mp_substituicoes.
const MP_SUBSTITUICOES_PADRAO = {};

// Nomes de cor que o sistema sabe RECONHECER num produto do Bling, mesmo
// que ainda não estejam cadastrados em nenhum material. Sem esta lista,
// uma cor inédita não é reconhecida e o produto entra sem cor nenhuma —
// foi o que aconteceu com o AMARELO do grão em 01/09/2026.
// O valor é a grafia que a fábrica usa; a chave é como vem escrito.
const MP_CORES_CONHECIDAS = {
  AMARELO: 'Amarelo', AMARELA: 'Amarelo', AZUL: 'Azul', BEGE: 'Bege',
  BRANCO: 'Branco', BRANCA: 'Branco', CANELA: 'Canela', CINZA: 'Cinza',
  COLORIDO: 'Colorido', COLORIDA: 'Colorido', CRISTAL: 'Cristal',
  FUME: 'Fumê', LARANJA: 'Laranja', LEITOSO: 'Leitoso', LEITOSA: 'Leitoso',
  MARROM: 'Marrom', NATURAL: 'Natural', PRETO: 'Preto', PRETA: 'Preto',
  ROSA: 'Rosa', ROXO: 'Roxo', TRANSPARENTE: 'Cristal',
  VERDE: 'Verde', VERMELHO: 'Vermelho', VERMELHA: 'Vermelho',
};

// Abreviação de 3 letras usada na SKU quando a cor ainda não tem uma
// cadastrada. É só um ponto de partida: quem confirma o cadastro pode
// trocar, e é isso que vai para o Bling.
function corLabelPadrao(cor) {
  return String(cor || '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]/g, '').substring(0, 3).toUpperCase();
}

// ─── Seed de configs Bling: mapa fornecedor + mapa produtos + ID Ekoplastic ───
// Só insere se a chave NÃO existir (não sobrescreve customização do usuário).
// Os mapas refletem o cadastro Bling fornecido em 21/05/2026.
function seedConfigsBling() {
  const mapaFornecedoresPadrao = {
    "Cedro":          "17830214554",
    "Ecorafia":       "18244556280",
    "Cristal Master": "17812997897",
    "COLLOR-X":       "17847796681",
    "Cromex":         "18292263741",
    "INNOVACOLOR":    "18296773374",
    "Ecolog":         "17804795779",
    "FG":             "18033742774",
    "Forcoplast":     "17812971362",
    "Gold Green":     "18264757168",
    "Karina":         "18033750501",
    "Piquiri":        "17822764082",
    "Redeplast":      "17808256474",
    "Tallpack":       "17807369878",
    "Tupaciguara":    "17880604037",
    "Valgroup":       "17927393383",
    "WT dos Santos":  "18159304251",
    "PARABOR":        "18422042805",   // Compatibilizante PA/PE (30/09/2026)
    "W R":            "18199057846",
    "Ycaro":          "17817641812"
  };
  // Chave composta: "material_key:cor:fornecedor"
  // cor pode ser vazia (CARBO/DESSEC não têm cor)
  const mapaProdutosPadrao = {
    // POLI
    "POLI:Canela:Ecolog":         "16606216410",
    "POLI:Canela:Tallpack":       "16586065283",
    "POLI:Canela:Valgroup":       "16597086241",
    "POLI:Canela:Ycaro":          "16586065261",
    "POLI:Colorido:Ecolog":       "16606216412",
    "POLI:Colorido:Tallpack":     "16586065319",
    "POLI:Colorido:Valgroup":     "16597086243",
    "POLI:Colorido:Ycaro":        "16586065301",
    "POLI:Cristal:Ecolog":        "16606216405",
    "POLI:Cristal:Tallpack":      "16586065201",
    "POLI:Cristal:Valgroup":      "16597086236",
    "POLI:Cristal:Ycaro":         "16586065182",
    "POLI:Leitoso:Ecolog":        "16606216408",
    "POLI:Leitoso:Tallpack":      "16586065240",
    "POLI:Leitoso:Valgroup":      "16597086237",
    "POLI:Leitoso:Ycaro":         "16586065221",
    // GBD
    "GBD:Canela:Cedro":           "16571358002",
    "GBD:Canela:Ecolog":          "16595820510",
    "GBD:Canela:Forcoplast":      "16616506407",
    "GBD:Canela:Piquiri":         "16595228461",
    "GBD:Canela:Redeplast":       "16595228462",
    "GBD:Canela:Tupaciguara":     "16595228460",
    "GBD:Canela:WT dos Santos":   "16654163409",
    "GBD:Colorido:Cedro":         "16595228452",
    "GBD:Colorido:Ecolog":        "16595820507",
    "GBD:Colorido:Forcoplast":    "16616506399",
    "GBD:Colorido:Piquiri":       "16571356220",
    "GBD:Colorido:Redeplast":     "16595228453",
    "GBD:Colorido:Tupaciguara":   "16595228451",
    "GBD:Colorido:WT dos Santos": "16654163401",
    "GBD:Leitoso:Cedro":          "16595228457",
    "GBD:Leitoso:Ecolog":         "16595820509",
    "GBD:Leitoso:Forcoplast":     "16616506404",
    "GBD:Leitoso:Piquiri":        "16595228458",
    "GBD:Leitoso:Redeplast":      "16595228459",
    "GBD:Leitoso:Tupaciguara":    "16571357989",
    "GBD:Preto:Cedro":            "16595228454",
    "GBD:Preto:Ecolog":           "16595820508",
    "GBD:Preto:Forcoplast":       "16616506402",
    "GBD:Preto:Piquiri":          "16595228455",
    "GBD:Preto:Redeplast":        "16595228456",
    "GBD:Preto:Tupaciguara":      "16571357971",
    // Ecorafia — as 4 cores são variações que compartilham o id-pai 16571355856;
    // a SKU distingue a variação (resolvida no envio via mapa_sku_variacao_mp).
    "GBD:Colorido:Ecorafia":      "16571355856",
    "GBD:Preto:Ecorafia":         "16571355856",
    "GBD:Leitoso:Ecorafia":       "16571355856",
    "GBD:Canela:Ecorafia":        "16571355856",
    // Gold Green — as 4 cores também são variações sob o id-pai 16571355856
    // (a SKU distingue a variação, resolvida no envio via mapa_sku_variacao_mp).
    "GBD:Colorido:Gold Green":    "16571355856",
    "GBD:Preto:Gold Green":       "16571355856",
    "GBD:Leitoso:Gold Green":     "16571355856",
    "GBD:Canela:Gold Green":      "16571355856",
    // CARBO (cor null)
    "CARBO::Cristal Master":      "16620491392",
    "CARBO::FG":                  "16620491394",
    "CARBO::Karina":              "16620491398",
    "CARBO::Secmil":              "16620598333",
    "CARBO::W R":                 "16663405098",
    // DESSEC (cor null)
    "DESSEC::COLLOR-X":           "16571944289",
    "DESSEC::Cromex":             "16684154422",
    "DESSEC::INNOVACOLOR":        "16571944289",
    "DESSEC::Cristal Master":     "16620488764",
    "DESSEC::FG":                 "16620488765",
    "DESSEC::Karina":             "16620488768",
    "DESSEC::Secmil":             "16620601030",
    // AUXFLUX (cor null) — cadastrado no Bling em 28/09/2026
    "AUXFLUX::Cristal Master":    "16711697477",
    // RESINA EVOH (30/09/2026) — substitui o Polinylon Tallpack Cristal/Leitoso.
    // As duas cores são variações do mesmo produto-pai; a SKU distingue a
    // variação (resolvida no envio via mapa_sku_variacao_mp), como no Ecorafia.
    // Mapear a EVOH é o que LIGA a troca (ver aplicarSubstituicao).
    "EVOH:Cristal:Tallpack":      "16711891720",
    "EVOH:Leitoso:Tallpack":      "16711891720",
    // PIG
    "PIG:Amarelo:Cristal Master": "16571351818",
    "PIG:Amarelo:FG":             "16620454453",
    "PIG:Amarelo:Karina":         "16620454456",
    "PIG:Branco:Cristal Master":  "16571351806",
    "PIG:Branco:FG":              "16620454449",
    "PIG:Branco:Karina":          "16620454451",
    "PIG:Preto:Cristal Master":   "16571351828",
    "PIG:Preto:FG":               "16620454460",
    "PIG:Preto:Karina":           "16620454461",
    "PIG:Verde:Cristal Master":   "16571351840",
    "PIG:Verde:FG":               "16620454464",
    "PIG:Verde:Karina":           "16620454465",
  };
  const ID_EKOPLASTIC_PADRAO = "17804838271";
  // Mapa de SKU de variação (MP): chave "material:cor:fornecedor" → SKU limpo da
  // variação no Bling. Só para produtos cujas cores compartilham o id-pai (a SKU
  // distingue a variação). Hoje: Ecorafia.
  const mapaSkuVariacaoMpPadrao = {
    "GBD:Colorido:Ecorafia": "GBD.COL.ECORAFIA",
    "GBD:Preto:Ecorafia":    "GBD.PTO.ECORAFIA",
    "GBD:Leitoso:Ecorafia":  "GBD.LEI.ECORAFIA",
    "GBD:Canela:Ecorafia":   "GBD.CAN.ECORAFIA",
    "GBD:Colorido:Gold Green": "GBD.COL.GOLDGREEN",
    "GBD:Preto:Gold Green":    "GBD.PTO.GOLDGREEN",
    "GBD:Leitoso:Gold Green":  "GBD.LEI.GOLDGREEN",
    "GBD:Canela:Gold Green":   "GBD.CAN.GOLDGREEN",
    "DESSEC::COLLOR-X":        "DESSEC.COLLOR-X",
    "DESSEC::Cromex":          "DESSEC.CROMEX",
    "DESSEC::INNOVACOLOR":     "DESSEC.INNOVACOLOR",
    // O auxiliar de fluxo é variação de fornecedor no Bling. A SKU vai
    // junto do id porque a regra automática de SKU corta o fornecedor em
    // 6 letras ("CRISTA") e o cadastro lá é AUXFLUX.CRISTAL — mandar a
    // SKU faz o envio resolver a variação certa, com o id como reserva.
    "AUXFLUX::Cristal Master": "AUXFLUX.CRISTAL",
    // Resina EVOH: SKUs das variações no Bling (informadas em 30/09/2026).
    "EVOH:Cristal:Tallpack":   "EVOH.CRISTAL.TALL",
    "EVOH:Leitoso:Tallpack":   "EVOH.LEI.TALL",
  };
  let inseridas = 0;
  if (!dbStmts.configGet.get('mapa_fornecedor_bling')) {
    dbStmts.configSet.run('mapa_fornecedor_bling', JSON.stringify(mapaFornecedoresPadrao));
    inseridas++;
  } else {
    // Mescla fornecedores NOVOS do padrão que ainda não estão no banco (não
    // sobrescreve os já gravados) — para fornecedores adicionados em novas
    // versões valerem mesmo em bancos antigos.
    try {
      const atual = JSON.parse(dbStmts.configGet.get('mapa_fornecedor_bling').valor || '{}');
      let novos = 0;
      for (const k in mapaFornecedoresPadrao) { if (!(k in atual)) { atual[k] = mapaFornecedoresPadrao[k]; novos++; } }
      if (novos > 0) { dbStmts.configSet.run('mapa_fornecedor_bling', JSON.stringify(atual)); logI('db', `Mapa de fornecedores Bling: ${novos} fornecedor(es) novo(s) mesclado(s)`); }
    } catch (e) { logW('db', 'Falha ao mesclar mapa de fornecedores Bling', { erro: e && e.message }); }
  }
  if (!dbStmts.configGet.get('mapa_produto_bling')) {
    dbStmts.configSet.run('mapa_produto_bling', JSON.stringify(mapaProdutosPadrao));
    inseridas++;
  } else {
    // Mescla produtos NOVOS do padrão que ainda não estão no banco (não sobrescreve
    // os já gravados). Assim, materiais adicionados em novas versões passam a valer
    // mesmo em bancos antigos, sem precisar recriar o etiquetas.db.
    try {
      const atual = JSON.parse(dbStmts.configGet.get('mapa_produto_bling').valor || '{}');
      let novos = 0;
      for (const k in mapaProdutosPadrao) {
        if (!(k in atual)) { atual[k] = mapaProdutosPadrao[k]; novos++; }
      }
      if (novos > 0) {
        dbStmts.configSet.run('mapa_produto_bling', JSON.stringify(atual));
        logI('db', `Mapa de produtos Bling: ${novos} produto(s) novo(s) mesclado(s) ao banco existente`);
      }
    } catch (e) { logW('db', 'Falha ao mesclar mapa de produtos Bling', { erro: e && e.message }); }
  }
  if (!dbStmts.configGet.get('id_ekoplastic_bling')) {
    dbStmts.configSet.run('id_ekoplastic_bling', ID_EKOPLASTIC_PADRAO);
    inseridas++;
  }
  if (!dbStmts.configGet.get('mapa_sku_variacao_mp')) {
    dbStmts.configSet.run('mapa_sku_variacao_mp', JSON.stringify(mapaSkuVariacaoMpPadrao));
    inseridas++;
  } else {
    try {
      const atual = JSON.parse(dbStmts.configGet.get('mapa_sku_variacao_mp').valor || '{}');
      let novos = 0;
      for (const k in mapaSkuVariacaoMpPadrao) { if (!(k in atual)) { atual[k] = mapaSkuVariacaoMpPadrao[k]; novos++; } }
      if (novos > 0) { dbStmts.configSet.run('mapa_sku_variacao_mp', JSON.stringify(atual)); logI('db', `Mapa de SKU de variação MP: ${novos} novo(s) mesclado(s)`); }
    } catch (e) { logW('db', 'Falha ao mesclar mapa de SKU de variação MP', { erro: e && e.message }); }
  }
  if (!dbStmts.configGet.get('bling_simular')) {
    dbStmts.configSet.run('bling_simular', '1');           // simulação por padrão
    inseridas++;
  }
  // Troca de produto (Polinylon Tallpack → Resina EVOH). Gravada UMA vez:
  // se alguém esvaziar, a próxima atualização não a recoloca. Ela só passa
  // a valer quando a EVOH estiver mapeada no Bling — ver aplicarSubstituicao.
  if (!dbStmts.configGet.get('mp_substituicoes')) {
    dbStmts.configSet.run('mp_substituicoes', JSON.stringify(MP_SUBSTITUICOES_PADRAO));
    inseridas++;
  }

  // ── CATÁLOGO MP (Etapa 1): fornecedores por material + códigos gravimétricos ──
  // Fonte única no banco. A tela de recebimento lê via GET /catalogo-mp
  // (com fallback embutido no cliente). O cadastro pela tela vem nas etapas seguintes.
  const mpFornecedoresPadrao = {"GBD": ["Cedro", "Ecorafia", "Ecolog", "Forcoplast", "Gold Green", "Piquiri", "Redeplast", "Tupaciguara", "WT dos Santos"], "POLI": ["Ecolog", "Tallpack", "Valgroup", "Ycaro"], "EVOH": ["Tallpack"], "CARBO": ["Cristal Master", "FG", "Karina", "SecMil", "W R"], "PIG": ["Cristal Master", "FG", "Karina"], "DESSEC": ["COLLOR-X", "Cromex", "INNOVACOLOR", "Cristal Master", "FG", "Karina", "SecMil"], "AUXFLUX": ["Cristal Master"]};
  const mpCodigosGravPadrao = [{"matKey": "PIG", "cor": "Amarelo", "forn": null, "codigo": "P1"}, {"matKey": "PIG", "cor": "Verde", "forn": null, "codigo": "P2"}, {"matKey": "PIG", "cor": "Preto", "forn": null, "codigo": "P3"}, {"matKey": "PIG", "cor": "Branco", "forn": null, "codigo": "P4"}, {"matKey": "CARBO", "cor": null, "forn": "Cristal Master", "codigo": "C1"}, {"matKey": "CARBO", "cor": null, "forn": "FG", "codigo": "C2"}, {"matKey": "CARBO", "cor": null, "forn": "Karina", "codigo": "C3"}, {"matKey": "CARBO", "cor": null, "forn": "W R", "codigo": "C4"}, {"matKey": "DESSEC", "cor": null, "forn": "Cristal Master", "codigo": "D1"}, {"matKey": "DESSEC", "cor": null, "forn": "COLLOR-X", "codigo": "D3"}, {"matKey": "DESSEC", "cor": null, "forn": "Cromex", "codigo": "D4"}, {"matKey": "DESSEC", "cor": null, "forn": "INNOVACOLOR", "codigo": "D5"}, {"matKey": "GBD", "cor": "Canela", "forn": "Cedro", "codigo": "CAN1"}, {"matKey": "GBD", "cor": "Canela", "forn": "Tupaciguara", "codigo": "CAN2"}, {"matKey": "GBD", "cor": "Canela", "forn": "WT dos Santos", "codigo": "CAN3"}, {"matKey": "GBD", "cor": "Canela", "forn": "Piquiri", "codigo": "CAN4"}, {"matKey": "GBD", "cor": "Colorido", "forn": "Cedro", "codigo": "COL1"}, {"matKey": "GBD", "cor": "Colorido", "forn": "Forcoplast", "codigo": "COL2"}, {"matKey": "GBD", "cor": "Colorido", "forn": "Piquiri", "codigo": "COL3"}, {"matKey": "GBD", "cor": "Colorido", "forn": "Tupaciguara", "codigo": "COL4"}, {"matKey": "GBD", "cor": "Colorido", "forn": "WT dos Santos", "codigo": "COL5"}, {"matKey": "GBD", "cor": "Preto", "forn": "Cedro", "codigo": "PT1"}, {"matKey": "GBD", "cor": "Preto", "forn": "Forcoplast", "codigo": "PT2"}, {"matKey": "GBD", "cor": "Preto", "forn": "Tupaciguara", "codigo": "PT3"}, {"matKey": "GBD", "cor": "Preto", "forn": "Piquiri", "codigo": "PT4"}, {"matKey": "GBD", "cor": "Colorido", "forn": "Ecorafia", "codigo": "COL6"}, {"matKey": "GBD", "cor": "Canela", "forn": "Ecorafia", "codigo": "CAN4"}, {"matKey": "GBD", "cor": "Leitoso", "forn": "Ecorafia", "codigo": "LEI1"}, {"matKey": "GBD", "cor": "Colorido", "forn": "Gold Green", "codigo": "COL7"}, {"matKey": "GBD", "cor": "Preto", "forn": "Gold Green", "codigo": "PT5"}, {"matKey": "GBD", "cor": "Leitoso", "forn": "Gold Green", "codigo": "LEI2"}, {"matKey": "GBD", "cor": "Canela", "forn": "Gold Green", "codigo": "CAN5"}, {"matKey": "POLI", "cor": "Canela", "forn": "Ycaro", "codigo": "NCAN1"}, {"matKey": "POLI", "cor": "Canela", "forn": "Ecolog", "codigo": "NCAN2"}, {"matKey": "POLI", "cor": "Colorido", "forn": "Ecolog", "codigo": "NCOL1"}, {"matKey": "POLI", "cor": "Colorido", "forn": "Ycaro", "codigo": "NCOL2"}, {"matKey": "POLI", "cor": "Colorido", "forn": "Tallpack", "codigo": "NCOL3"}, {"matKey": "POLI", "cor": "Cristal", "forn": "Ycaro", "codigo": "NCRIS1"}, {"matKey": "POLI", "cor": "Leitoso", "forn": "Ecolog", "codigo": "NLEI1"}, {"matKey": "POLI", "cor": "Leitoso", "forn": "Tallpack", "codigo": "NLEI2"}, {"matKey": "POLI", "cor": "Leitoso", "forn": "Valgroup", "codigo": "NLEI3"}, {"matKey": "POLI", "cor": "Leitoso", "forn": "Ycaro", "codigo": "NLEI4"}, {"matKey": "AUXFLUX", "cor": null, "forn": "Cristal Master", "codigo": "A1"}];
  // ── POR QUE ESTES TRÊS PRECISAM MESCLAR ──────────────────────────
  //  Até 28/09/2026 os três catálogos de MP só eram gravados quando a
  //  chave NÃO existia. Faz sentido para não apagar o que o usuário
  //  cadastrou pela tela — mas tinha um efeito que ninguém via: numa
  //  estação que já rodou, as três chaves existem, então um material
  //  NOVO no código nunca chegava lá. Instalava a atualização, o
  //  material estava no server.js, e continuava sem aparecer na tela.
  //
  //  Agora é o mesmo tratamento que o mapa de produtos Bling já tinha:
  //  acrescenta o que é novo, NÃO toca no que já está gravado. Material
  //  removido do código também fica onde está — tirar do catálogo é
  //  decisão de quem cadastrou, não efeito colateral de uma atualização.
  // ─────────────────────────────────────────────────────────────────
  const mesclarObjeto = (chave, padrao, oQue) => {
    const atual = dbStmts.configGet.get(chave);
    if (!atual) { dbStmts.configSet.run(chave, JSON.stringify(padrao)); inseridas++; return; }
    try {
      const tem = JSON.parse(atual.valor || '{}');
      let novos = 0;
      for (const k in padrao) if (!(k in tem)) { tem[k] = padrao[k]; novos++; }
      if (novos > 0) {
        dbStmts.configSet.run(chave, JSON.stringify(tem));
        logI('db', `${oQue}: ${novos} novo(s) mesclado(s) ao banco existente`);
      }
    } catch (e) { logW('db', `Falha ao mesclar ${chave}`, { erro: e && e.message }); }
  };
  mesclarObjeto('mp_fornecedores', mpFornecedoresPadrao, 'Fornecedores por material');
  // Estrutura dos materiais (nome popular + cores válidas). Usada pela tela de
  // Manutenção para montar as opções de cadastro do código gravimétrico.
  mesclarObjeto('mp_materiais', MP_MATERIAIS_PADRAO, 'Materiais de MP');

  // Os códigos gravimétricos são uma LISTA, não um objeto: a identidade de
  // uma linha é material+cor+fornecedor. Comparar por essa identidade evita
  // duplicar um código que o usuário já cadastrou com outra grafia de caixa.
  {
    const atual = dbStmts.configGet.get('mp_codigos_gravimetricos');
    if (!atual) {
      dbStmts.configSet.run('mp_codigos_gravimetricos', JSON.stringify(mpCodigosGravPadrao));
      inseridas++;
    } else {
      try {
        const tem = JSON.parse(atual.valor || '[]');
        const id = c => `${String(c.matKey||'').toUpperCase()}|${String(c.cor||'').toUpperCase()}|${String(c.forn||'').toUpperCase()}`;
        const jaTem = new Set(tem.map(id));
        let novos = 0;
        for (const c of mpCodigosGravPadrao) if (!jaTem.has(id(c))) { tem.push(c); novos++; }
        if (novos > 0) {
          dbStmts.configSet.run('mp_codigos_gravimetricos', JSON.stringify(tem));
          logI('db', `Códigos gravimétricos: ${novos} novo(s) mesclado(s) ao banco existente`);
        }
      } catch (e) { logW('db', 'Falha ao mesclar códigos gravimétricos', { erro: e && e.message }); }
    }
  }

  // ── EXTRUSÃO: mapa de bobinas (cor|tipo|largura → ID Bling + SKU) ──
  // Cadastro vigente a partir de 24/05/2026 (24 produtos, todas combinações)
  const mapaBobinasPadrao = {
    // AMARELA · LEVE
    "AMARELA|LEVE|1,60":      { id: "16653916155", sku: "BOB.AM.LEV.1,60" },
    "AMARELA|LEVE|1,68":      { id: "16653916156", sku: "BOB.AM.LEV.1,68" },
    "AMARELA|LEVE|1,75":      { id: "16653916157", sku: "BOB.AM.LEV.1,75" },
    // AMARELA · REFORÇADA
    "AMARELA|REFORCADA|1,20": { id: "16653914905", sku: "BOB.AM.REF.1,20" },
    "AMARELA|REFORCADA|1,60": { id: "16653916160", sku: "BOB.AM.REF.1,60" },
    "AMARELA|REFORCADA|80":   { id: "16653916163", sku: "BOB.AM.REF.80"   },
    // BRANCA · LEVE
    "BRANCA|LEVE|1,60":       { id: "16653916147", sku: "BOB.BC.LEV.1,60" },
    "BRANCA|LEVE|1,68":       { id: "16653916148", sku: "BOB.BC.LEV.1,68" },
    "BRANCA|LEVE|1,75":       { id: "16653916149", sku: "BOB.BC.LEV.1,75" },
    // BRANCA · REFORÇADA
    "BRANCA|REFORCADA|1,20":  { id: "16653914903", sku: "BOB.BC.REF.1,20" },
    "BRANCA|REFORCADA|1,60":  { id: "16653916151", sku: "BOB.BC.REF.1,60" },
    "BRANCA|REFORCADA|80":    { id: "16653916154", sku: "BOB.BC.REF.80"   },
    // COLORIDA · LEVE
    "COLORIDA|LEVE|1,60":     { id: "16653916138", sku: "BOB.COL.LEV.1,60" },
    "COLORIDA|LEVE|1,68":     { id: "16653916140", sku: "BOB.COL.LEV.1,68" },
    "COLORIDA|LEVE|1,75":     { id: "16653916141", sku: "BOB.COL.LEV.1,75" },
    // COLORIDA · REFORÇADA
    "COLORIDA|REFORCADA|1,20":{ id: "16653914901", sku: "BOB.COL.REF.1,20" },
    "COLORIDA|REFORCADA|1,60":{ id: "16653916143", sku: "BOB.COL.REF.1,60" },
    "COLORIDA|REFORCADA|80":  { id: "16653916146", sku: "BOB.COL.REF.80"   },
    // PRETA · LEVE
    // NOTA: o ID 16653916165 estava cadastrado no Bling como "BOB.PT.LEV.1,20"
    //       em 24/05/2026. Aguarda correção pelo cliente pra "BOB.PT.LEV.1,60".
    //       Mapeamento aqui já reflete o correto pós-ajuste.
    "PRETA|LEVE|1,60":        { id: "16653916165", sku: "BOB.PT.LEV.1,60" },
    "PRETA|LEVE|1,68":        { id: "16653916166", sku: "BOB.PT.LEV.1,68" },
    "PRETA|LEVE|1,75":        { id: "16653916167", sku: "BOB.PT.LEV.1,75" },
    // PRETA · REFORÇADA
    "PRETA|REFORCADA|1,20":   { id: "16653914907", sku: "BOB.PT.REF.1,20" },
    "PRETA|REFORCADA|1,60":   { id: "16653916169", sku: "BOB.PT.REF.1,60" },
    "PRETA|REFORCADA|80":     { id: "16653916174", sku: "BOB.PT.REF.80"   },
  };

  // ── EXTRUSÃO: turnos → pseudo-fornecedor Bling ──
  // Cada turno é tratado como "fornecedor" no Bling pra rastrear a produção.
  const mapaTurnosPadrao = {
    "EXT-A1": { fornecedorId: "18007239571", label: "Extrusão Turno A-1", periodo: "diurno",  paridade: "par"   },
    "EXT-C1": { fornecedorId: "18007241951", label: "Extrusão Turno C-1", periodo: "noturno", paridade: "par"   },
    "EXT-A2": { fornecedorId: "18007242562", label: "Extrusão Turno A-2", periodo: "diurno",  paridade: "impar" },
    "EXT-C2": { fornecedorId: "18007243073", label: "Extrusão Turno C-2", periodo: "noturno", paridade: "impar" },
  };

  // ── RETIRADA DE BOBINAS: turno → contato (cliente) do pedido de venda ──
  // Cada turno é um "cliente" no Bling; a baixa da bobina sai como venda para ele.
  const mapaTurnosBobinaPadrao = {
    "A":     { contatoId: "17802279349", label: "Turno A" },
    "C":     { contatoId: "17803577652", label: "Turno C" },
    "EXTRA": { contatoId: "18180509587", label: "Turno Extra" },
  };
  if (!dbStmts.configGet.get('mapa_turno_bobina')) {
    dbStmts.configSet.run('mapa_turno_bobina', JSON.stringify(mapaTurnosBobinaPadrao));
    inseridas++;
  }

  if (!dbStmts.configGet.get('mapa_bobina_bling')) {
    dbStmts.configSet.run('mapa_bobina_bling', JSON.stringify(mapaBobinasPadrao));
    inseridas++;
  }
  if (!dbStmts.configGet.get('mapa_turno_extrusao')) {
    dbStmts.configSet.run('mapa_turno_extrusao', JSON.stringify(mapaTurnosPadrao));
    inseridas++;
  }
  // Modo de envio Bling pra extrusão. Default 'lote' (mesmo modelo da MP:
  // finalizar turno envia todas as bobinas como UM pedido de compra).
  // Alternativa 'individual' — cada bipagem dispara um pedido. Útil pra
  // acompanhar em tempo real, mas gera N pedidos por turno.
  if (!dbStmts.configGet.get('bling_extrusao_modo')) {
    dbStmts.configSet.run('bling_extrusao_modo', 'lote');
    inseridas++;
  }

  if (inseridas > 0) logI('db', `Seed de configs Bling: ${inseridas} chave(s) populada(s) (mapas com ${Object.keys(mapaFornecedoresPadrao).length} fornecedores MP, ${Object.keys(mapaProdutosPadrao).length} produtos MP, ${Object.keys(mapaBobinasPadrao).length} bobinas, ${Object.keys(mapaTurnosPadrao).length} turnos)`);
}

// ─── Backup diário simples ───
function backupDiario() {
  const d = new Date();
  const tag = `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
  const dest = path.join(BACKUP_DIR, `etiquetas-${tag}.db`);
  if (fs.existsSync(dest)) return;
  try {
    // VACUUM INTO cria backup limpo, sem precisar de wal_checkpoint manual
    // Path precisa estar entre aspas simples no SQL e escapar aspas no nome se houver
    const destSql = dest.replace(/'/g, "''");
    db.exec(`VACUUM INTO '${destSql}'`);
    logI('db', `Backup diário salvo: ${path.basename(dest)}`);
    // Mantém apenas os últimos 7 backups
    const backups = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('etiquetas-') && f.endsWith('.db'))
      .sort();
    while (backups.length > 7) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, backups.shift())); } catch(e) {}
    }
  } catch(e) { logW('db', 'Backup falhou', { erro: e.message }); }
}
backupDiario();
setInterval(backupDiario, 6 * 60 * 60 * 1000);

// Agora que dbStmts existe, popula configs default do Bling (se ainda não existirem)
seedConfigsBling();
// Normaliza o nome do fornecedor ECORAFIA → Ecorafia (Title Case, padrão dos
// demais) nas CHAVES já gravadas em bancos que instalaram o v95. Idempotente:
// em bancos novos (já "Ecorafia") não faz nada. Os SKUs (valores, ex
// "GBD.COL.ECORAFIA") não mudam — são os códigos cadastrados no Bling.
(function migrarNomeEcorafia() {
  const renom = (chaveConfig) => {
    try {
      const row = dbStmts.configGet.get(chaveConfig);
      if (!row) return;
      const obj = JSON.parse(row.valor || '{}');
      let mudou = false;
      for (const k of Object.keys(obj)) {
        if (!k.includes('ECORAFIA')) continue;      // só chaves, o valor SKU fica intacto
        const nk = k.split('ECORAFIA').join('Ecorafia');
        if (nk === k) continue;
        if (!(nk in obj)) obj[nk] = obj[k];          // preserva o valor (id ou SKU)
        delete obj[k];                                // remove a chave antiga (garrafais)
        mudou = true;
      }
      if (mudou) { dbStmts.configSet.run(chaveConfig, JSON.stringify(obj)); logI('db', `Nome ECORAFIA→Ecorafia normalizado em ${chaveConfig}`); }
    } catch(e) { logW('db', `Falha ao normalizar nome ECORAFIA em ${chaveConfig}`, { erro: e && e.message }); }
  };
  renom('mapa_fornecedor_bling');
  renom('mapa_produto_bling');
  renom('mapa_sku_variacao_mp');
})();

// ──────────────────────────────────────────────────────────────────
// Patches incrementais de mapas (idempotente, roda em todo boot).
//
// Adiciona entradas novas que vão sendo cadastradas ao longo do tempo
// sem mexer em IDs já existentes (preserva edições manuais).
// Cada bloco abaixo é independente e seguro pra rodar várias vezes.
// ──────────────────────────────────────────────────────────────────
function aplicarPatchsMapas() {
  // ── Fornecedores MP ──
  // Lista canônica de fornecedores: nome final → ID Bling.
  const novosForn = {
    'WT dos Santos': '18159304251',
    'W R':           '18199057846',
    'COLLOR-X':      '17847796681',
    'Cromex':        '18292263741',
    'INNOVACOLOR':   '18296773374',
    // Próximos fornecedores cadastrados, adicionar aqui:
  };
  // Aliases obsoletos a remover (renomeações). Ao trocar a capitalização
  // ou nome de um fornecedor, listar o nome antigo aqui pra ser apagado
  // de qualquer banco que já o tenha gravado.
  const aliasesAntigosForn = ['WT DOS SANTOS'];

  try {
    const atual = JSON.parse(configGet('mapa_fornecedor_bling', '{}'));
    let mudou = false;
    for (const [nome, id] of Object.entries(novosForn)) {
      if (!atual[nome]) {
        atual[nome] = id;
        mudou = true;
        logI('db', `Patch: fornecedor MP "${nome}" adicionado ao mapa (id=${id})`);
      }
    }
    for (const alias of aliasesAntigosForn) {
      if (atual[alias]) {
        delete atual[alias];
        mudou = true;
        logI('db', `Patch: fornecedor MP alias antigo "${alias}" removido (renomeado)`);
      }
    }
    if (mudou) configSet('mapa_fornecedor_bling', JSON.stringify(atual));
  } catch(e) {
    logW('db', `Falha aplicando patch de fornecedores: ${e.message}`);
  }

  // ── Produtos MP ──
  // Chaves no formato "material:cor:fornecedor" → ID Bling
  const novosProd = {
    'GBD:Canela:WT dos Santos':   '16654163409',
    'GBD:Colorido:WT dos Santos': '16654163401',
    'DESSEC::COLLOR-X':            '16571944289',
    'DESSEC::Cromex':              '16684154422',
    'DESSEC::INNOVACOLOR':         '16571944289',
  };
  const aliasesAntigosProd = [
    // Se um produto foi cadastrado com nome antigo, listar aqui pra remover
    // Ex: 'GBD:Canela:WT DOS SANTOS'
    'GBD:Canela:WT DOS SANTOS',
    'GBD:Colorido:WT DOS SANTOS',
  ];

  try {
    const atual = JSON.parse(configGet('mapa_produto_bling', '{}'));
    let mudou = false;
    for (const [chave, id] of Object.entries(novosProd)) {
      if (!atual[chave]) {
        atual[chave] = id;
        mudou = true;
        logI('db', `Patch: produto "${chave}" adicionado ao mapa (id=${id})`);
      }
    }
    for (const alias of aliasesAntigosProd) {
      if (atual[alias]) {
        delete atual[alias];
        mudou = true;
        logI('db', `Patch: produto alias antigo "${alias}" removido (renomeado)`);
      }
    }
    if (mudou) configSet('mapa_produto_bling', JSON.stringify(atual));
  } catch(e) {
    logW('db', `Falha aplicando patch de produtos: ${e.message}`);
  }
}
aplicarPatchsMapas();

// ──────────────────────────────────────────────────────────────────
// Patches do catálogo MP (mp_fornecedores e mp_codigos_gravimetricos).
// Diferente dos mapas do Bling, esses configs NÃO têm merge no seed
// (o seed só grava se ainda não existirem). Como no banco de produção
// eles já existem, fornecedores/códigos novos precisam entrar por aqui
// — idempotente, roda em todo boot. Enquanto o cadastro de fornecedor
// pela tela não existe, é aqui que um fornecedor novo é garantido.
// ──────────────────────────────────────────────────────────────────
function aplicarPatchsCatalogoMP() {
  // Fornecedores a garantir na lista de cada material (aparecem na tela).
  const fornPorMaterial = {
    DESSEC: ['COLLOR-X', 'Cromex', 'INNOVACOLOR'],
  };
  // Códigos gravimétricos a garantir (não sobrescrevem se já houver a combinação).
  const codigos = [
    { matKey: 'DESSEC', cor: null, forn: 'COLLOR-X', codigo: 'D3' },
    { matKey: 'DESSEC', cor: null, forn: 'Cromex', codigo: 'D4' },
    { matKey: 'DESSEC', cor: null, forn: 'INNOVACOLOR', codigo: 'D5' },
  ];

  try {
    const forn = JSON.parse(configGet('mp_fornecedores', '{}'));
    let mudou = false;
    for (const [mat, lista] of Object.entries(fornPorMaterial)) {
      if (!Array.isArray(forn[mat])) forn[mat] = [];
      for (const nome of lista) {
        if (!forn[mat].includes(nome)) { forn[mat].push(nome); mudou = true; logI('db', `Patch catálogo: fornecedor "${nome}" adicionado em ${mat}`); }
      }
    }
    if (mudou) configSet('mp_fornecedores', JSON.stringify(forn));
  } catch (e) { logW('db', 'Falha no patch de fornecedores MP', { erro: e && e.message }); }

  // Nome popular dos materiais que devem ser corrigidos no banco existente.
  const nomesPopulares = { GBD: 'Grão Baixa Densidade' };
  try {
    const mats = JSON.parse(configGet('mp_materiais', '{}'));
    let mudouMat = false;
    for (const [k, nome] of Object.entries(nomesPopulares)) {
      if (mats[k] && mats[k].popular !== nome) {
        logI('db', `Patch catálogo: material ${k} renomeado para "${nome}"`);
        mats[k].popular = nome; mudouMat = true;
      }
    }
    // Bancos que já existem não têm corLabel (a abreviação da SKU vivia no
    // HTML). Semeia a partir do padrão, sem sobrescrever o que já estiver lá.
    for (const [k, def] of Object.entries(MP_MATERIAIS_PADRAO)) {
      if (!mats[k]) continue;
      if (!mats[k].corLabel || typeof mats[k].corLabel !== 'object') { mats[k].corLabel = {}; mudouMat = true; }
      for (const [cor, lab] of Object.entries(def.corLabel || {})) {
        if (!mats[k].corLabel[cor]) { mats[k].corLabel[cor] = lab; mudouMat = true; }
      }
      if (mudouMat) logI('db', `Patch catálogo: abreviações de cor do material ${k} gravadas no banco`);
    }
    if (mudouMat) configSet('mp_materiais', JSON.stringify(mats));
  } catch (e) { logW('db', 'Falha no patch de nomes de material', { erro: e && e.message }); }

  try {
    const lista = JSON.parse(configGet('mp_codigos_gravimetricos', '[]'));
    let mudou = false;
    for (const nc of codigos) {
      const existe = lista.some(c => c.matKey === nc.matKey && (c.cor || null) === (nc.cor || null) && (c.forn || null) === (nc.forn || null));
      if (!existe) { lista.push(nc); mudou = true; logI('db', `Patch catálogo: código ${nc.codigo} para ${nc.matKey}/${nc.cor || '-'}/${nc.forn || 'todos'}`); }
    }
    if (mudou) configSet('mp_codigos_gravimetricos', JSON.stringify(lista));
  } catch (e) { logW('db', 'Falha no patch de códigos MP', { erro: e && e.message }); }
}
aplicarPatchsCatalogoMP();

// Material de kg indicado: { passo, max } ou null. Um item = um saco de até
// kgMax kg (Purga: até 25 kg). Usado para recusar o que passar do teto.
function kgIndicadoDe(matKey) {
  try {
    const m = (lerCatalogoMP().materiais || {})[matKey];
    if (!m || m.kgIndicado !== true) return null;
    const passo = Number(m.kgPorSaco) > 0 ? Number(m.kgPorSaco) : 5;
    return { passo, max: Number(m.kgMax) > 0 ? Number(m.kgMax) : passo * 5 };
  } catch (e) { return null; }
}

// ──────────────────────────────────────────────────────────────────
// Catálogo de MP (fornecedores por material, códigos gravimétricos e
// estrutura dos materiais). Fonte única no banco; a tela de Recebimento
// lê via GET /catalogo-mp e a Manutenção cadastra via POST.
// ──────────────────────────────────────────────────────────────────
function lerCatalogoMP() {
  const ler = (chave, vazio) => {
    try { const r = dbStmts.configGet.get(chave); return r ? JSON.parse(r.valor || vazio) : JSON.parse(vazio); }
    catch(e) { logW('db', `Catálogo MP: falha lendo ${chave}`, { erro: e && e.message }); return JSON.parse(vazio); }
  };
  return {
    fornecedores: ler('mp_fornecedores', '{}'),
    codigos:      ler('mp_codigos_gravimetricos', '[]'),
    materiais:    ler('mp_materiais', '{}'),
  };
}

logI('db', `SQLite inicializado em ${DB_FILE}`);

module.exports = { corLabelPadrao, kgIndicadoDe, lerCatalogoMP, MP_CORES_CONHECIDAS,
  MP_MATERIAIS_PADRAO, };
