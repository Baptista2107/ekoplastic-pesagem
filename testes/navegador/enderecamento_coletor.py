"""Teste de navegador da tela de Endereçamento no coletor e no celular (12/11/2026).

Roda na VPS (precisa do Playwright e do Chromium de lá), com a API do Mini PC
FALSA (rotas interceptadas): não grava nada. Não entra no rodar-todos.js (o
Mini PC não tem navegador de teste).

    cd ~/bling-claude && venv/bin/python <repo pesagem>/testes/navegador/enderecamento_coletor.py \
        <repo pesagem>/public /tmp/prints

Confere, em 360 (TC60), 360, 390, 414 e 1280 px: cabeçalho numa linha com a 🏠,
só MAPA e ENDEREÇAR, COLOCAR/RETIRAR de ponta a ponta, bipe do leitor
"teclado" em qualquer aba (endereço, gaiola EKOPA|…), big bag pelo caminho do
app (onLeu), câmera nunca ligada, Enter na busca e digitação lenta não viram
bipe. Na tela de antes (067b5b7) falha em 6 itens já no primeiro tamanho.
16/11/2026: ➕/➖ do histórico mostram o que entrou/saiu e o toque abre a
ficha; COLOCAR/RETIRAR confirmam com a descrição — na tela de 91b01b8 são
7 falhas por tamanho (35).
Sai 1 se falhar."""
import json, sys, time, urllib.parse
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

PUB = Path(sys.argv[1]); OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
HTML = (PUB / "enderecamento.html").read_text(encoding="utf-8")
CSS = (PUB / "celular.css").read_text(encoding="utf-8")
POS = [{"codigo": f"0{r}-0{n}-{p:03d}", "rua": r, "nivel": n, "posicao": p, "ocupada": False,
        "bloqueada": False, "tipo_gaiola": "PEQUENA"} for r in (1, 2) for n in (1, 2, 3) for p in range(1, 39)]
ACESSO = "window.EkoAcesso={exigir:(t,f)=>{window.EKO_RESPONSAVEL='TESTE';f('TESTE');}};"
POSTS = []
falhas = []
# 16/11/2026 (Gustavo): o que entrou/saiu aparece no histórico e na confirmação.
OC_BAG = {"id": 7, "posicao": "01-02-012", "gaiola_id": "T0000101", "tipo_item": "bag", "material_key": "GBD",
          "material_nome": "BAIXA DENSIDADE", "cor": "Preto", "fornecedor": "Piquiri", "lote": "S/L", "kg": 834.5,
          "entrada": "2026-11-16T17:10:00Z", "operador_e": "BRUNO", "saida": None, "operador_s": None, "motivo_saida": None}
OC_GAI = {"id": 6, "posicao": "01-01-020", "gaiola_id": "G0000124", "tipo_item": "gaiola", "formato": "50x60", "cor": "BC",
          "fardos": 40, "kg": 1000, "tipo_gaiola": "PEQUENA", "entrada": "2026-11-16T16:00:00Z", "operador_e": "ADNILSON",
          "saida": "2026-11-16T17:00:00Z", "operador_s": "BRUNO", "motivo_saida": "carregamento"}
HIST = [dict(OC_BAG, saida="2026-11-16T17:20:00Z", operador_s="BRUNO"), OC_GAI]

def ok(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond: falhas.append(msg)

def rota(route):
    u = urllib.parse.urlparse(route.request.url); p = urllib.parse.unquote(u.path)
    J = lambda d: route.fulfill(status=200, content_type="application/json", body=json.dumps(d))
    if p in ("/", "/enderecamento.html"): return route.fulfill(status=200, content_type="text/html", body=HTML)
    if p == "/celular.css": return route.fulfill(status=200, content_type="text/css", body=CSS)
    if p == "/acesso-colaborador.js": return route.fulfill(status=200, content_type="application/javascript", body=ACESSO)
    if p == "/vendor/html5-qrcode.min.js": return route.fulfill(status=200, content_type="application/javascript", body="")
    if p == "/enderecamento/mapa": return J({"ok": True, "posicoes": POS, "resumo": {"ocupadas": 0, "livres": 228, "bloqueadas": 0, "fardos": 0, "kg": 0}, "layout": {"ruas": {"1": 38, "2": 38}}})
    if p == "/enderecamento/historico": return J({"ok": True, "movimentos": HIST})
    if p.startswith("/enderecamento/posicao/"):
        c = p.rsplit("/", 1)[1]; q = next((x for x in POS if x["codigo"] == c), None)
        return J({"ok": bool(q), "posicao": q, "atual": OC_BAG if c == "01-02-012" else None, "erro": None if q else "não existe"})
    if p.startswith("/enderecamento/gaiola/"):
        g = p.rsplit("/", 1)[1]
        if g.startswith("T"): return J({"ok": True, "gaiola": None, "atual": None, "bag": {"status": "bipada", "material_nome": "BAIXA DENSIDADE", "cor": "Preto", "peso": 834.5, "fornecedor": "Piquiri", "lote": "S/L"}})
        if g.startswith("R"): return J({"ok": True, "gaiola": None, "atual": None, "bag": {"status": "bipada", "material_nome": "CANELA BD", "cor": "CANELA", "peso": 1000, "fornecedor": "ECORAFIA", "lote": "120926"}})
        return J({"ok": True, "gaiola": {"formato": "50x60", "fardos": 40, "kg": 1000}, "atual": None})
    if route.request.method == "POST":
        POSTS.append((p, route.request.post_data))
        if p == "/enderecamento/liberar":
            return J({"ok": True, "liberado": True, "gaiola_id": OC_BAG["gaiola_id"], "posicao": OC_BAG["posicao"],
                      "ocupacao": dict(OC_BAG, saida="2026-11-16T17:20:00Z", operador_s="TESTE")})
        if p == "/enderecamento/ocupar":
            return J({"ok": True, "posicao": "01-01-020", "ocupacao": dict(OC_GAI, saida=None, operador_s=None, motivo_saida=None)})
        return J({"ok": True, "gaiola_id": "X", "posicao": "Y"})
    return route.fulfill(status=404, body="")

def bipar(pg, txt):          # leitor "teclado": rajada de teclas + Enter
    pg.keyboard.type(txt)
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(250)

with sync_playwright() as p:
    nav = _navegador(p)
    for nome, w, h in (("coletor-TC60", 360, 640), ("android-360", 360, 780), ("iphone-390", 390, 844), ("iphone-414", 414, 896), ("minipc-1280", 1280, 800)):
        print(f"== {nome} ({w}px)")
        ctx = nav.new_context(viewport={"width": w, "height": h}, is_mobile=w < 900, has_touch=w < 900, device_scale_factor=2)
        pg = ctx.new_page(); erros = []
        pg.on("pageerror", lambda e: erros.append(str(e)))
        pg.route("**/*", rota)
        pg.goto("http://eko.teste/enderecamento.html"); pg.wait_for_timeout(500)
        if w >= 900: pg.evaluate("irAba('mapa')"); pg.wait_for_timeout(200)
        m = pg.evaluate("""() => { const hd=document.querySelector('header'); const r=b=>b.getBoundingClientRect();
            const bs=[...hd.querySelectorAll('.btn-ic')].map(b=>r(b).top); const lg=r(hd.querySelector('.logo'));
            return {alt:r(hd).height, tops:bs, logoTop:lg.top, sw:document.documentElement.scrollWidth, iw:innerWidth,
                    abas:[...document.querySelectorAll('.aba')].map(a=>a.textContent.trim()),
                    sep:!!document.getElementById('pg-sep')||!!document.getElementById('pg-sob')}; }""")
        ok(m["alt"] <= 64, f"cabeçalho numa linha ({m['alt']:.0f}px)")
        ok(max(m["tops"]) - min(m["tops"]) < 2, "🏠 e os outros botões na mesma linha")
        ok(m["sw"] <= m["iw"], f"sem estouro lateral ({m['sw']} ≤ {m['iw']})")
        ok(m["abas"] == ["🗺 MAPA", "📟 ENDEREÇAR"] and not m["sep"], f"só MAPA e ENDEREÇAR ({m['abas']})")
        # bipe estando no MAPA → vai para ENDEREÇAR
        pg.evaluate("irAba('mapa')"); pg.wait_for_timeout(150)
        bipar(pg, "01-02-007")
        ok(pg.evaluate("document.getElementById('pg-acao').classList.contains('on')"), "bipe no MAPA leva para ENDEREÇAR")
        ok(pg.inner_text("#v-end") == "01-02-007", f"endereço reconhecido ({pg.inner_text('#v-end')})")
        md = pg.evaluate("""() => { const a=document.getElementById('md-entrada').getBoundingClientRect(),
            b=document.getElementById('md-saida').getBoundingClientRect(), c=document.getElementById('pg-acao').getBoundingClientRect();
            return {usado:(b.right-a.left)/(c.width), alt:a.height}; }""")
        ok(md["usado"] > 0.9, f"COLOCAR/RETIRAR ocupam a largura ({md['usado']*100:.0f}%)")
        ok(not pg.evaluate("camLigada"), "câmera desligada (ninguém ligou)")
        bipar(pg, "EKOPA|G0000123|50x60|BC|40|1000|PEQUENA")
        ok(pg.inner_text("#v-gai") == "G0000123", f"gaiola reconhecida ({pg.inner_text('#v-gai')} | msg={pg.inner_text('#msg')[:90]} | buf={pg.evaluate('BIPE.buf')!r})")
        ok(pg.is_enabled("#btn-confirmar"), "CONFIRMAR liberado com os dois")
        pg.screenshot(path=str(OUT / f"{nome}-gaiola.png"), full_page=False)
        # big bag no lugar da gaiola, pelo caminho do app (onLeu direto)
        pg.evaluate("limparSlot('gai')"); pg.evaluate("onLeu('R0001234')"); pg.wait_for_timeout(250)
        ok(pg.inner_text("#v-gai") == "R0001234" and "BIG BAG" in pg.inner_text("#e-gai"), f"big bag reconhecido ({pg.inner_text('#e-gai')})")
        pg.screenshot(path=str(OUT / f"{nome}-bag.png"), full_page=False)
        # bag de RETORNO (T…) pelo leitor "teclado" — 16/11/2026, o Bruno bipou T0000101 e não foi lido
        pg.evaluate("limparSlot('gai')"); bipar(pg, "T0000101"); pg.wait_for_timeout(300)
        ok(pg.inner_text("#v-gai") == "T0000101" and "BIG BAG" in pg.inner_text("#e-gai") and "Piquiri" in pg.inner_text("#e-gai"),
           f"bag de retorno T0000101 reconhecido pelo leitor ({pg.inner_text('#e-gai')} | msg={pg.inner_text('#msg')[:90]})")
        # busca do mapa: texto comum + Enter continua busca; etiqueta bipada vira leitura
        pg.evaluate("irAba('mapa')"); pg.click("#busca")
        pg.keyboard.type("50x60"); pg.keyboard.press("Enter"); pg.wait_for_timeout(200)
        ok(pg.evaluate("document.getElementById('pg-mapa').classList.contains('on')"), "Enter com '50x60' na busca não troca de aba")
        pg.fill("#busca", ""); pg.click("#busca"); bipar(pg, "01-02-009")
        ok(pg.inner_text("#v-end") == "01-02-009" and pg.input_value("#busca") == "", "bipe com a busca em foco vira leitura e limpa a busca")
        # senha (PIN) na tela: teclas não viram leitura, nada do PIN no aviso
        pg.evaluate("irAba('mapa'); limparTudo(); const d=document.createElement('div'); d.id='eko-acesso'; document.body.appendChild(d)")
        pg.keyboard.type("1234"); pg.keyboard.press("Enter"); pg.wait_for_timeout(200)
        pg.evaluate("onLeu('01-01-003')"); pg.wait_for_timeout(200)
        ok("1234" not in pg.inner_text("#msg") and pg.evaluate("ABA") == "mapa" and pg.inner_text("#v-end") != "01-01-003",
           "com a senha aberta, PIN e leitura do app são ignorados")
        pg.evaluate("document.getElementById('eko-acesso').remove()")
        # dentro do app: o teclado não entrega (quem entrega é o app), mesmo com foco num botão
        pg.evaluate("window.__ekoApp=1; irAba('acao'); limparTudo(); document.getElementById('md-entrada').focus()")
        bipar(pg, "01-01-004")
        ok(pg.inner_text("#v-end") != "01-01-004", "no app, o teclado não dá leitura em dobro")
        pg.evaluate("delete window.__ekoApp")
        # sobra do teclado sem Enter não gruda na leitura seguinte
        pg.evaluate("limparTudo()"); pg.keyboard.type("R0001234"); pg.evaluate("onLeu('01-01-005')"); pg.wait_for_timeout(200)
        ok(pg.evaluate("BIPE.buf") == "" and pg.inner_text("#v-end") == "01-01-005", "leitura entregue zera a sobra do teclado")
        # tecla de gente (lenta) fora de campo não vira leitura
        pg.evaluate("document.activeElement && document.activeElement.blur(); irAba('acao'); limparTudo()")
        for ch in "01-01-002": pg.keyboard.press(ch); pg.wait_for_timeout(1200)
        pg.keyboard.press("Enter"); pg.wait_for_timeout(200)
        ok("01-01-002" not in pg.inner_text("#v-end"), "digitação lenta fora de campo não vira bipe")
        # 16/11/2026 (Gustavo): ➕/➖ do histórico mostram O QUE entrou/saiu; toque abre a ficha.
        pg.evaluate("irAba('acao'); irModo('entrada'); limparTudo(); if (typeof HIST_ABERTO !== 'undefined') HIST_ABERTO.clear()")
        pg.evaluate("carregarHistorico()"); pg.wait_for_timeout(300)
        ht = pg.inner_text("#hist")
        ok("BAIXA DENSIDADE Preto · Piquiri · 834,5 kg" in ht, f"➖ do bag mostra material, cor, fornecedor e kg ({ht[:120]!r})")
        ok("50x60 BC · 40 fardos · 1.000 kg" in ht, "gaiola mostra formato, cor, fardos e kg")
        it = pg.locator("#hist .hist-item").nth(0); det = it.locator(".hist-det")
        ok(not det.is_visible(), "a ficha começa fechada")
        (it.tap() if w < 900 else it.click()); pg.wait_for_timeout(150)
        ft = det.inner_text() if det.is_visible() else ""
        ok(det.is_visible() and "S/L" in ft and "por BRUNO" in ft and "Saiu" in ft and "01-02-012" in ft,
           f"tocar abre a ficha: lote, endereço, quem e quando ({ft[:140]!r})")
        alt = it.evaluate("e => e.getBoundingClientRect().height")
        ok(alt >= 48, f"linha do histórico com toque grande ({alt:.0f}px)")
        sw = pg.evaluate("document.documentElement.scrollWidth")
        ok(sw <= w, f"ficha aberta sem estouro lateral ({sw} ≤ {w})")
        if nome == "coletor-TC60":
            it.scroll_into_view_if_needed(); pg.screenshot(path=str(OUT / f"{nome}-historico-ficha.png"), full_page=False)
        (it.tap() if w < 900 else it.click()); pg.wait_for_timeout(150)
        ok(not det.is_visible(), "tocar de novo fecha")
        # confirmação de COLOCAR traz a descrição
        pg.evaluate("for (const k of Object.keys(ultimaLeitura)) delete ultimaLeitura[k]")
        pg.evaluate("onLeu('01-01-020')"); pg.wait_for_timeout(250)
        pg.evaluate("onLeu('EKOPA|G0000124|50x60|BC|40|1000|PEQUENA')"); pg.wait_for_timeout(300)
        pg.click("#btn-confirmar"); pg.wait_for_timeout(300)
        mt = pg.inner_text("#msg")
        ok("guardada" in mt and "40 fardos" in mt and "1.000 kg" in mt, f"COLOCAR confirma com a descrição ({mt[:120]!r})")
        ve = pg.inner_text("#v-end")
        ok("01-01-020" not in ve, f"quadros limpos logo depois de confirmar (bipe rápido não herda o endereço ocupado) ({ve!r})")
        # RETIRAR: antes de confirmar e depois, a descrição do que sai
        pg.wait_for_timeout(2400)
        # passado o "limpa a tela" de 2,2 s, a descrição continua para ler (16/11)
        mt2 = pg.inner_text("#msg")
        ok("40 fardos" in mt2, f"descrição do COLOCAR continua na tela depois de 2,4 s ({mt2[:80]!r})")
        # a próxima leitura boa apaga o "✓ guardada" (senão parece que o par novo já foi gravado)
        pg.evaluate("for (const k of Object.keys(ultimaLeitura)) delete ultimaLeitura[k]")
        pg.evaluate("onLeu('01-01-021')"); pg.wait_for_timeout(300)
        mt3 = pg.inner_text("#msg")
        ok("guardada" not in mt3, f"próxima leitura apaga o ✓ guardada ({mt3[:60]!r})")
        ok("01-01-021" in pg.inner_text("#v-end"), "a leitura que apagou o ✓ é a do endereço livre (não um erro)")
        # bipe DURANTE o confirmar (servidor lento): a resposta não apaga a leitura nova
        pg.evaluate("""(() => { const f = window.fetch; window.__fetchOrig = f;
          window.fetch = (u, o) => String(u).includes('/enderecamento/ocupar')
            ? new Promise(r => setTimeout(() => r(f(u, o)), 800)) : f(u, o); })()""")
        pg.evaluate("for (const k of Object.keys(ultimaLeitura)) delete ultimaLeitura[k]")
        pg.evaluate("onLeu('EKOPA|G0000125|50x60|BC|40|1000|PEQUENA')"); pg.wait_for_timeout(300)
        pg.click("#btn-confirmar"); pg.wait_for_timeout(150)
        pg.evaluate("onLeu('01-01-022')"); pg.wait_for_timeout(1500)
        ve2 = pg.inner_text("#v-end")
        ok("01-01-022" in ve2, f"bipe durante o confirmar fica no quadro ({ve2!r})")
        pg.evaluate("window.fetch = window.__fetchOrig")
        pg.evaluate("irModo('saida'); for (const k of Object.keys(ultimaLeitura)) delete ultimaLeitura[k]")
        pg.evaluate("onLeu('01-02-012')"); pg.wait_for_timeout(300)
        mt = pg.inner_text("#msg")
        ok("Vai retirar" in mt and "Piquiri" in mt and "834,5 kg" in mt, f"RETIRAR mostra o que vai sair antes de confirmar ({mt[:120]!r})")
        pg.click("#btn-confirmar"); pg.wait_for_timeout(300)
        mt = pg.inner_text("#msg")
        ok("retirada de" in mt and "BAIXA DENSIDADE Preto" in mt and "Piquiri" in mt, f"RETIRAR confirma com a descrição ({mt[:120]!r})")
        pg.evaluate("irModo('entrada')")
        ok(not erros, f"sem erro de JS ({erros[:2]})")
        pg.evaluate("irAba('mapa')"); pg.wait_for_timeout(200)
        pg.screenshot(path=str(OUT / f"{nome}-mapa.png"), full_page=False)
        ctx.close()
    nav.close()
print("FALHAS:", len(falhas)); sys.exit(1 if falhas else 0)
