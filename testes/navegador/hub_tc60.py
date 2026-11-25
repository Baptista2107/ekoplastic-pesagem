"""Teste de navegador: o hub "Ekoplastic MP" na tela do coletor TC60 (25/11/2026).

Gustavo, 25/11, depois de instalar no TC60 do Bruno: "não tá legal de ver no
android do TC60" e "todas as telas merecem atenção uma a uma".

O TC60 tem tela de 720×1440 px com dpr 2: a WebView do app (sem "viewport
largo") fica com ~360×690 px de CSS. O Bruno usa no almoxarifado, com uma mão,
às vezes de luva, e o galpão é claro.

Sobe o server.js de verdade (banco temporário, portas 14110/14111/14112) e abre
o hub como o app abre (user-agent "… EkoColetor/2.0"), em 5 estados:
carregando (o Mini PC ainda não respondeu), conectado, "em andamento" (sessões
abertas de verdade no banco de teste), sem servidor (a consulta falha) e
"em andamento" + sem servidor (o mais alto: faixa vermelha e etiquetas acesas).

690 px é a tela sem as barras do Android; com a barra de status e a de
navegação de 3 botões sobra ~648 px (revisor, 25/11). Em cada estado, a 360 px
de largura e 690 e 648 px de altura, confere:

  1. Sem rolagem para o lado e nada passando da borda direita.
  2. Os 5 botões e o status inteiros dentro da tela, SEM rolar.
  3. Cada botão com ≥ 56 px de altura e ≥ 8 px de folga entre um e outro.
  4. Nada do botão (ícone, nome, subtítulo, "em andamento") sai dele.
  5. Todo texto com ≥ 16 px.
  6. A página inteira, rodapé junto, cabe sem rolar.
  7. Contraste do texto com o fundo ≥ 7:1 (galpão claro, tela com reflexo),
     também com o botão apertado.

A 560 px (tela baixa, fonte maior) a página pode rolar, mas valem 1, 3, 4 e 5.
Por fim, a 1366×768 (monitor do Mini PC): sem rolagem nenhuma, 5 botões
inteiros com a altura mínima, texto ≥ 16 px.

    cd ~/bling-claude && timeout 300 venv/bin/python -I <repo pesagem>/testes/navegador/hub_tc60.py <repo pesagem> [pasta-prints] [prefixo]

Fotos a 690 px (se pedir a pasta): <prefixo>-carregando.png, -conectado.png,
-em-andamento.png, -sem-servidor.png, -em-andamento-sem-servidor.png e
-1366.png. Sai 1 se falhar.
Não entra no rodar-todos.js (o Mini PC não tem navegador de teste)."""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from datetime import date
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

REPO = Path(sys.argv[1])
PRINTS = Path(sys.argv[2]) if len(sys.argv) > 2 else None
PREFIXO = sys.argv[3] if len(sys.argv) > 3 else "hub"
if PRINTS: PRINTS.mkdir(parents=True, exist_ok=True)
UA_APP = "Mozilla/5.0 (Linux; Android 14; TC60) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 EkoColetor/2.0"
LARG, ALT = 360, 690
ALTURAS_SEM_ROLAR = (690, 648)   # sem barras / com barra de status + navegação
ALT_BAIXA = 560                  # aqui pode rolar, mas nada vaza
BOTAO_MIN, FOLGA_MIN, FONTE_MIN, CONTRASTE_MIN = 56, 8, 16, 7.0
falhas = []

def ok(cond, msg, det=""):
    print(("  ✓ " if cond else "  ✗ ") + msg + ("" if cond or not det else f"  [{det}]"))
    if not cond: falhas.append(msg)

def req(base, rota, corpo=None):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    r = urllib.request.Request(base + rota, data=dados, headers={"Content-Type": "application/json"} if dados else {})
    with urllib.request.urlopen(r, timeout=10) as x: return json.loads(x.read())

# Mede a página inteira numa passada só (tudo em px de CSS).
MEDIR = r"""() => {
  const w = document.documentElement.clientWidth, h = document.documentElement.clientHeight;
  const visivel = e => { const cs = getComputedStyle(e); const b = e.getBoundingClientRect();
    return cs.display !== 'none' && cs.visibility !== 'hidden' && +cs.opacity > 0 && b.width > 0 && b.height > 0; };
  const nome = e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + ([...e.classList].length ? '.' + [...e.classList].join('.') : ''));
  const rgba = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return [0,0,0,0];
    const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lum = c => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  // Fundo efetivo: compõe as cores de fundo de baixo (html) para cima (o elemento).
  const fundo = e => { const pilha = []; for (let x = e; x; x = x.parentElement) pilha.push(rgba(getComputedStyle(x).backgroundColor));
    let c = [255, 255, 255]; for (const b of pilha.reverse()) { const a = b[3]; c = [0,1,2].map(i => b[i] * a + c[i] * (1 - a)); } return c; };
  const fora = [], pequenos = [], baixos = [];
  for (const e of document.querySelectorAll('body *')) {
    if (!visivel(e) || e.tagName === 'SCRIPT' || e.tagName === 'STYLE') continue;
    const b = e.getBoundingClientRect();
    if (b.right > w + 1 || b.left < -1) fora.push(nome(e) + ' ' + Math.round(b.left) + '..' + Math.round(b.right));
    const temTexto = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!temTexto) continue;
    const cs = getComputedStyle(e), px = parseFloat(cs.fontSize);
    if (px < 16 - 0.01) pequenos.push(nome(e) + ' ' + px + 'px "' + e.textContent.trim().slice(0, 30) + '"');
    const tx = rgba(cs.color), bg = fundo(e), a = tx[3];
    const txc = [0,1,2].map(i => tx[i] * a + bg[i] * (1 - a));
    const l1 = lum(txc), l2 = lum(bg), cr = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    // Só o que é letra: emoji (ícone) não depende da cor do texto.
    if (/[A-Za-zÀ-ú0-9]/.test(e.textContent) && cr < %CONTRASTE%) baixos.push(nome(e) + ' ' + cr.toFixed(1) + ':1');
  }
  // O que está dentro do botão não pode passar da borda dele (o padding pode).
  const vaza = [];
  const botoes = [...document.querySelectorAll('#hub-telas a.tela')].map(a => { const b = a.getBoundingClientRect();
    const dentro = { top: b.top + a.clientTop, left: b.left + a.clientLeft,
                     bottom: b.top + a.clientTop + a.clientHeight, right: b.left + a.clientLeft + a.clientWidth };
    for (const f of a.querySelectorAll('*')) { if (!visivel(f)) continue; const c = f.getBoundingClientRect();
      if (c.top < dentro.top - 0.5 || c.bottom > dentro.bottom + 0.5 || c.left < dentro.left - 0.5 || c.right > dentro.right + 0.5)
        vaza.push(a.id + ' ' + nome(f) + ' ' + Math.round(c.top - dentro.top) + '/' + Math.round(dentro.bottom - c.bottom)); }
    return { id: a.id, top: b.top, bottom: b.bottom, left: b.left, right: b.right, h: b.height }; });
  const st = document.getElementById('hub-status'), sb = st && st.getBoundingClientRect();
  return { w, h, sw: document.documentElement.scrollWidth, sh: document.documentElement.scrollHeight,
           fora: fora.slice(0, 8), nFora: fora.length, pequenos: pequenos.slice(0, 8), nPequenos: pequenos.length,
           baixos: baixos.slice(0, 8), nBaixos: baixos.length, botoes, vaza: vaza.slice(0, 8), nVaza: vaza.length,
           status: st ? { cls: st.className, txt: st.textContent, top: sb.top, bottom: sb.bottom, left: sb.left, right: sb.right } : null };
}""".replace("%CONTRASTE%", str(CONTRASTE_MIN))

def medir(pg, estado, alt, sem_rolar):
    """Uma altura de tela. sem_rolar=False (tela baixa): a página pode rolar."""
    pg.set_viewport_size({"width": LARG, "height": alt}); pg.wait_for_timeout(150)
    r = pg.evaluate(MEDIR)
    e = f"{estado} {alt}"
    ok(r["sw"] <= LARG and r["nFora"] == 0, f"{e}: sem rolagem para o lado, nada além da borda", json.dumps({"sw": r["sw"], "fora": r["fora"]}, ensure_ascii=False))
    bt = r["botoes"]
    ok(len(bt) == 5, f"{e}: 5 botões", len(bt))
    ok(bt and min(b["h"] for b in bt) >= BOTAO_MIN, f"{e}: botões com ≥ {BOTAO_MIN} px de altura", [round(b["h"]) for b in bt])
    folgas = [round(bt[i + 1]["top"] - bt[i]["bottom"]) for i in range(len(bt) - 1)]
    ok(folgas and min(folgas) >= FOLGA_MIN, f"{e}: ≥ {FOLGA_MIN} px entre um botão e outro", folgas)
    ok(r["nVaza"] == 0, f"{e}: nada sai de dentro do botão", "; ".join(r["vaza"]))
    ok(r["nPequenos"] == 0, f"{e}: todo texto com ≥ {FONTE_MIN} px", "; ".join(r["pequenos"]))
    ok(r["nBaixos"] == 0, f"{e}: contraste do texto ≥ {CONTRASTE_MIN:g}:1", "; ".join(r["baixos"]))
    if sem_rolar:
        fora = [b["id"] for b in bt if b["top"] < 0 or b["bottom"] > alt + 0.5 or b["left"] < 0 or b["right"] > LARG + 0.5]
        ok(not fora, f"{e}: os 5 botões inteiros na tela sem rolar", json.dumps([(b["id"], round(b["bottom"])) for b in bt]))
        ok(r["sh"] <= alt, f"{e}: a página inteira (rodapé junto) cabe sem rolar", r["sh"])
        s = r["status"]
        ok(s and s["top"] >= 0 and s["bottom"] <= alt and s["left"] >= 0 and s["right"] <= LARG, f"{e}: status inteiro na tela", json.dumps(s, ensure_ascii=False))
    return r

def conferir(pg, estado):
    for alt in ALTURAS_SEM_ROLAR: medir(pg, estado, alt, True)
    medir(pg, estado, ALT_BAIXA, False)
    pg.set_viewport_size({"width": LARG, "height": ALT}); pg.wait_for_timeout(150)
    if PRINTS: pg.screenshot(path=str(PRINTS / f"{PREFIXO}-{estado}.png"), full_page=True)

def apertado(pg):
    """Contraste com o dedo em cima (:active): segura cada botão e mede. Solta
    fora dele, então não navega (o clique cai no ancestral comum)."""
    baixos = []
    for i in range(pg.locator("#hub-telas a.tela").count()):
        b = pg.locator("#hub-telas a.tela").nth(i).bounding_box()
        pg.mouse.move(b["x"] + b["width"] / 2, b["y"] + b["height"] / 2); pg.mouse.down()
        r = pg.evaluate(MEDIR); baixos += r["baixos"]
        pg.mouse.move(2, 2); pg.mouse.up()
    ok(not baixos, f"botão apertado: contraste ≥ {CONTRASTE_MIN:g}:1", "; ".join(baixos[:8]))
    ok(pg.url.endswith("/hub-mp.html"), "segurar e soltar fora não abre a tela", pg.url)

def main():
    porta = 14110
    tmp = Path(tempfile.mkdtemp(prefix="eko_hub_tc60_"))
    base = f"http://127.0.0.1:{porta}"
    env = {**os.environ, "EKO_PORT": str(porta), "EKO_PORT_CB": "14111", "EKO_PORT_HTTPS": "14112",
           "EKO_DB_FILE": str(tmp / "t.db"), "EKO_LOG_DIR": str(tmp / "logs"), "TZ": "America/Sao_Paulo",
           "EKO_PRINT_SIMULAR": "1", "EKO_FECHAR_TELA_SIMULAR": "1"}
    srv = subprocess.Popen(["node", str(REPO / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(75):
            try:
                if req(base, "/healthcheck").get("ok"): break
            except Exception: pass
            time.sleep(0.2)
        # Nada deste banco de teste vai para a VPS de verdade.
        req(base, "/config", {"vps_sacoleiras_url": "http://127.0.0.1:9/api/sacoleiras/agora"})
        with sync_playwright() as pw:
            br = _navegador(pw)
            erros = []
            def coletor():
                ctx = br.new_context(viewport={"width": LARG, "height": ALT}, user_agent=UA_APP, device_scale_factor=2,
                                     is_mobile=True, has_touch=True)
                # A ponte do app (EkoApp) põe "app v2.0" no rodapé: a linha
                # mais comprida do hub tem de caber também.
                ctx.add_init_script("window.EkoApp = { versao: () => '2.0' };")
                # Folga larga: com outros testes de navegador na VPS a página
                # já levou > 6 s para carregar (falha de vez em quando, 25/11).
                pg = ctx.new_page(); pg.set_default_timeout(15000)
                pg.on("pageerror", lambda e: erros.append(str(e)))
                return ctx, pg

            print(f"\n[1] Carregando (o Mini PC ainda não respondeu) — {LARG}×{ALT}")
            ctx, pg = coletor()
            presos = []
            pg.route("**/sessoes/abertas*", lambda rota: presos.append(rota))   # segura a resposta
            pg.goto(base + "/hub-mp.html"); pg.wait_for_timeout(700)
            ok("status on" != pg.locator("#hub-status").get_attribute("class"), "carregando: ainda não diz conectado")
            conferir(pg, "carregando")
            for rt in presos:
                try: rt.abort()
                except Exception: pass
            ctx.close()

            print(f"\n[2] Conectado, nada em andamento")
            ctx, pg = coletor()
            pg.goto(base + "/hub-mp.html"); pg.wait_for_selector("#hub-status.on")
            ok(pg.locator("#hub-status.on").count() == 1, "conectado: status on", pg.locator("#hub-status").inner_text())
            conferir(pg, "conectado")
            apertado(pg)
            ctx.close()

            print(f"\n[3] Em andamento (sessões abertas de verdade no banco de teste)")
            hoje = date.today().isoformat()
            for tipo in ("recebimento", "retirada", "produto-acabado"):
                req(base, "/sessoes", {"tipo": tipo, "operador": "TESTE TC60", "turno_codigo": "A", "data_lancamento": hoje})
            ctx, pg = coletor()
            pg.goto(base + "/hub-mp.html"); pg.wait_for_selector("#hub-status.on")
            pg.wait_for_selector("#hub-aberta-pa:not(:empty)")
            acesos = [i for i in ("entrada", "retirada", "pa") if pg.locator(f"#hub-aberta-{i}").inner_text().strip()]
            ok(acesos == ["entrada", "retirada", "pa"], "em andamento: Entrada, Retirada e PA acesos", acesos)
            conferir(pg, "em-andamento")
            apertado(pg)

            print(f"\n[3b] Em andamento e o Mini PC cai (faixa vermelha + etiquetas acesas)")
            pg.route("**/sessoes/abertas*", lambda rota: rota.abort("connectionrefused"))
            pg.evaluate("EkoHub.atualizar(document)"); pg.wait_for_selector("#hub-status.off")
            conferir(pg, "em-andamento-sem-servidor")
            ctx.close()

            print(f"\n[4] Sem servidor (a consulta ao Mini PC falha)")
            ctx, pg = coletor()
            pg.route("**/sessoes/abertas*", lambda rota: rota.abort("connectionrefused"))
            pg.goto(base + "/hub-mp.html"); pg.wait_for_selector("#hub-status.off")
            ok(pg.locator("#hub-status.off").count() == 1, "sem servidor: status off", pg.locator("#hub-status").inner_text())
            conferir(pg, "sem-servidor")
            ctx.close()

            print("\n[5] Monitor do Mini PC (1366×768)")
            ctx = br.new_context(viewport={"width": 1366, "height": 768}); pg = ctx.new_page(); pg.set_default_timeout(15000)
            pg.on("pageerror", lambda e: erros.append(str(e)))
            pg.goto(base + "/hub-mp.html"); pg.wait_for_selector("#hub-status.on")
            r = pg.evaluate(MEDIR)
            ok(r["sw"] <= 1366 and r["nFora"] == 0, "1366: sem rolagem para o lado", json.dumps(r["fora"]))
            ok(r["sh"] <= 768, "1366: cabe em 768 px sem rolar", r["sh"])
            ok(r["nPequenos"] == 0 and r["nVaza"] == 0, "1366: texto ≥ 16 px e nada sai do botão", "; ".join(r["pequenos"] + r["vaza"]))
            bt = r["botoes"]
            ok(len(bt) == 5 and all(b["left"] >= 0 and b["right"] <= 1366 and b["h"] >= BOTAO_MIN for b in bt),
               "1366: 5 botões inteiros e com altura mínima", json.dumps(bt))
            if PRINTS: pg.screenshot(path=str(PRINTS / f"{PREFIXO}-1366.png"), full_page=True)
            ctx.close()

            ok(not erros, "sem erro de JavaScript", "; ".join(erros)[:400])
            br.close()
    finally:
        srv.kill(); srv.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'FALHOU: ' + str(len(falhas)) if falhas else 'OK'}")
    sys.exit(1 if falhas else 0)

main()
