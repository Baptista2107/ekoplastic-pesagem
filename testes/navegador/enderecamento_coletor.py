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
    if p == "/enderecamento/historico": return J({"ok": True, "movimentos": []})
    if p.startswith("/enderecamento/posicao/"):
        c = p.rsplit("/", 1)[1]; q = next((x for x in POS if x["codigo"] == c), None)
        return J({"ok": bool(q), "posicao": q, "atual": None, "erro": None if q else "não existe"})
    if p.startswith("/enderecamento/gaiola/"):
        g = p.rsplit("/", 1)[1]
        if g.startswith("R"): return J({"ok": True, "gaiola": None, "atual": None, "bag": {"status": "bipada", "material_nome": "CANELA BD", "cor": "CANELA", "peso": 1000, "fornecedor": "ECORAFIA", "lote": "120926"}})
        return J({"ok": True, "gaiola": {"formato": "50x60", "fardos": 40, "kg": 1000}, "atual": None})
    if route.request.method == "POST":
        POSTS.append((p, route.request.post_data)); return J({"ok": True, "gaiola_id": "X", "posicao": "Y"})
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
        # digitar devagar na busca do mapa não vira bipe
        pg.evaluate("irAba('mapa')"); pg.click("#busca")
        for ch in "01-01-001": pg.keyboard.press(ch); pg.wait_for_timeout(20)
        pg.keyboard.press("Enter"); pg.wait_for_timeout(200)
        ok(pg.evaluate("document.getElementById('pg-mapa').classList.contains('on')"), "Enter na busca não troca de aba")
        # tecla de gente (lenta) fora de campo não vira leitura
        pg.click("h1, .rua-tit, #resumo"); pg.evaluate("irAba('acao'); limparTudo()")
        for ch in "01-01-002": pg.keyboard.press(ch); pg.wait_for_timeout(1200)
        pg.keyboard.press("Enter"); pg.wait_for_timeout(200)
        ok("01-01-002" not in pg.inner_text("#v-end"), "digitação lenta fora de campo não vira bipe")
        ok(not erros, f"sem erro de JS ({erros[:2]})")
        pg.evaluate("irAba('mapa')"); pg.wait_for_timeout(200)
        pg.screenshot(path=str(OUT / f"{nome}-mapa.png"), full_page=False)
        ctx.close()
    nav.close()
print("FALHAS:", len(falhas)); sys.exit(1 if falhas else 0)
