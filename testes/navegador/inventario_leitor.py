"""Teste de navegador: contagem do inventário lê o leitor do coletor SEM tocar em Digitar (24/11/2026).

Gustavo, urgente: "no coletor o Bruno tá fazendo uma contagem de MP, só que ele
tem que clicar toda vez pra digitar pra aí o coletor lê o código de barras; isso
tem que ser automático; também dê a opção de usar a câmera caso seja necessário".

Roda na VPS (Playwright e Chromium de lá), com a API do Mini PC FALSA e onLeu()
trocado por um espião: não grava nada. Não entra no rodar-todos.js.

    cd ~/bling-claude && venv/bin/python <repo pesagem>/testes/navegador/inventario_leitor.py <repo pesagem>/public

Confere, em 360 (TC60) e 1280 px: leitor "teclado" (rajada + Enter) entrega o
big bag e a gaiola EKOPA|… na contagem aberta; nada fora da contagem, nada
dentro do app (quem entrega lá é o app), nada com campo em foco, nada com
digitação lenta; botão da câmera visível. Na tela de antes (6b0e0d3) falha.
Sai 1 se falhar."""
import json, sys, urllib.parse
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

PUB = Path(sys.argv[1])
TIPOS = {".html": "text/html", ".css": "text/css", ".js": "application/javascript"}
falhas = []


def ok(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond:
        falhas.append(msg)


def rota(route):
    p = urllib.parse.unquote(urllib.parse.urlparse(route.request.url).path)
    arq = PUB / p.lstrip("/")
    if p.startswith("/vendor/"):
        return route.fulfill(status=200, content_type="application/javascript", body="")
    if arq.suffix in TIPOS and arq.is_file():
        return route.fulfill(status=200, content_type=TIPOS[arq.suffix], body=arq.read_text(encoding="utf-8"))
    return route.fulfill(status=200, content_type="application/json", body=json.dumps({"ok": True}))


def bipar(pg, txt):          # leitor "teclado": rajada de teclas + Enter
    pg.keyboard.type(txt)
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(150)


def lidos(pg):
    return pg.evaluate("window.__lidos.splice(0)")


with sync_playwright() as p:
    nav = _navegador(p)
    for nome, w, h in (("coletor-TC60", 360, 640), ("minipc-1280", 1280, 800)):
        print(f"== {nome} ({w}px)")
        ctx = nav.new_context(viewport={"width": w, "height": h}, is_mobile=w < 900, has_touch=w < 900)
        pg = ctx.new_page()
        erros = []
        pg.on("pageerror", lambda e: erros.append(str(e)))
        pg.route("**/*", rota)
        pg.goto("http://eko.teste/inventario.html")
        pg.wait_for_timeout(400)
        # espião no lugar do onLeu (a validação de verdade fala com o Mini PC)
        pg.evaluate("window.__onLeuReal=window.onLeu; window.__lidos=[]; window.onLeu=(c)=>{window.__lidos.push(c);}; 0")   # '; 0': evaluate CHAMA função devolvida

        # fora da contagem (escolha MP/PA): o leitor não entrega nada
        bipar(pg, "R0000123")
        ok(lidos(pg) == [], "fora da contagem o bipe não vira leitura")

        # contagem aberta: big bag e gaiola chegam sem tocar em nada
        pg.evaluate("""for (const id of ['tela-tipo','tela-selecao','tela-comparativo'])
                         document.getElementById(id).classList.add('oculto');
                       document.getElementById('tela-leitura').classList.remove('oculto');""")
        pg.evaluate("document.activeElement && document.activeElement.blur()")
        bipar(pg, "R0000123")
        ok(lidos(pg) == ["R0000123"], "contagem aberta: big bag lido sem tocar em Digitar")
        bipar(pg, "EKOPA|12|50x60|BC|40|1000")
        ok(lidos(pg) == ["EKOPA|12|50x60|BC|40|1000"], "gaiola EKOPA|… lida inteira")
        # o botão que ficou com foco não é "clicado" pelo Enter do leitor
        pg.evaluate("document.getElementById('btn-digitar').focus()")
        bipar(pg, "R0000124")
        dlg = pg.evaluate("!!document.querySelector('.modal-fundo, .eko-dialogo, dialog[open]')")
        ok(lidos(pg) == ["R0000124"] and not dlg, "Enter do leitor com botão em foco não abre o Digitar")

        # campo em foco é de quem digita
        pg.evaluate("""(() => { const i = document.createElement('input'); i.id = 'campo-teste';
                         document.getElementById('tela-leitura').prepend(i); i.focus(); })()""")
        bipar(pg, "123")
        ok(lidos(pg) == [], "com campo em foco a tecla é do campo")
        pg.evaluate("document.activeElement.blur()")

        # digitação lenta (>1 s entre teclas) não vira código
        for ch in "R00":
            pg.keyboard.press(ch)
            pg.wait_for_timeout(1100)
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(100)
        ok(lidos(pg) == [], "tecla solta/lenta não vira leitura")

        # dentro do app quem entrega é o app (senão sai em dobro)
        pg.evaluate("window.__ekoApp=1")
        bipar(pg, "R0000125")
        ok(lidos(pg) == [], "dentro do app a página não lê o teclado (sem dobro)")
        pg.evaluate("delete window.__ekoApp")

        # ── revisão do b0d37ed (24/11): o que o revisor mediu quebrando ──
        # janela aberta: o bipe não entra e o Enter dele não confirma a janela.
        # Quem barra é o onLeu de verdade (vale para app e câmera também).
        REAL = "window.__onLeuEspiao = window.onLeu; window.onLeu = window.__onLeuReal; 0"
        ESPIAO = "window.onLeu = window.__onLeuEspiao; 0"
        ABRIR = """window.__r='pendente'; ekoConfirmar({titulo:'Excluir', texto:'Excluir produto?', ok:'Excluir', perigo:true})
                     .then(v => window.__r = v); 0"""
        FECHAR = "document.getElementById('md-cancelar') && document.getElementById('md-cancelar').click(); 0"
        def janela(pg):
            return pg.evaluate("[window.__r, !!document.querySelector('.eko-dlg'), document.getElementById('toast').textContent]")
        pg.evaluate(REAL); pg.evaluate("document.getElementById('toast').textContent=''; 0")
        pg.evaluate(ABRIR); pg.wait_for_timeout(150)
        bipar(pg, "R0000140")
        st = janela(pg)
        ok(st[:2] == ["pendente", True] and "Feche a janela" in st[2], f"janela aberta: bipe não entra nem confirma ({st})")
        # Enter atrasado (o código já fechou pelo relógio): não confirma
        pg.keyboard.type("R0000147"); pg.wait_for_timeout(550); pg.keyboard.press("Enter"); pg.wait_for_timeout(150)
        st = janela(pg)
        ok(st[:2] == ["pendente", True], f"janela aberta: Enter 550 ms depois do código não confirma ({st})")
        pg.evaluate(FECHAR); pg.wait_for_timeout(100)
        # dentro do app (quem chama o onLeu é o app): janela aberta barra também
        pg.evaluate("window.__ekoApp=1; 0"); pg.evaluate(ABRIR); pg.wait_for_timeout(150)
        pg.evaluate("window.__n0 = leituras.length; onLeu('R0000148'); 0"); pg.wait_for_timeout(150)
        st = janela(pg); n = pg.evaluate("leituras.length - window.__n0")
        ok(st[:2] == ["pendente", True] and n == 0, f"app com janela aberta: bipe não entra ({st[:2]}, +{n})")
        pg.evaluate(FECHAR); pg.evaluate("delete window.__ekoApp; 0"); pg.wait_for_timeout(100)
        # janela na tela de SELEÇÃO ("Produto já inventariado → Recomeçar do zero")
        pg.evaluate("""document.getElementById('tela-leitura').classList.add('oculto');
                       document.getElementById('tela-selecao').classList.remove('oculto'); 0""")
        pg.evaluate(ABRIR); pg.wait_for_timeout(150)
        bipar(pg, "R0000149")
        st = janela(pg)
        ok(st[:2] == ["pendente", True], f"janela na tela de seleção: bipe não confirma ({st})")
        pg.evaluate(FECHAR); pg.wait_for_timeout(100)
        pg.evaluate("""(() => { const s = document.getElementById('sel-material');
                         s.innerHTML = '<option value="">—</option><option value="PEBD">PEBD</option><option value="REC">RECICLADO</option>';
                         s.disabled = false; s.value = 'PEBD'; s.focus(); })()""")
        bipar(pg, "R0000150")
        v = pg.evaluate("document.getElementById('sel-material').value")
        ok(v == "PEBD" and lidos(pg) == [], f"lista da tela de seleção não pula de material ({v})")
        pg.evaluate("""document.activeElement.blur(); document.getElementById('tela-selecao').classList.add('oculto');
                       document.getElementById('tela-leitura').classList.remove('oculto'); 0""")
        pg.evaluate(ESPIAO)
        # botão em foco + Enter atrasado: não clica
        pg.evaluate("""(() => { const b = document.createElement('button'); b.id = 'bt-teste'; window.__cliques = 0;
                         b.onclick = () => window.__cliques++; document.getElementById('tela-leitura').prepend(b); b.focus(); })()""")
        pg.keyboard.type("R0000151"); pg.wait_for_timeout(550); pg.keyboard.press("Enter"); pg.wait_for_timeout(150)
        r = [lidos(pg), pg.evaluate("window.__cliques")]
        ok(r == [["R0000151"], 0], f"botão em foco: Enter atrasado do leitor não clica ({r})")
        pg.evaluate("document.getElementById('bt-teste').remove(); 0")

        bipar(pg, "]C1R0000141")
        ok(lidos(pg) == ["R0000141"], "prefixo AIM do leitor (]C1) sai")

        # lista e campo de número em foco: o bipe não mexe neles e entra
        pg.evaluate("""(() => { document.getElementById('painel-sacos').classList.remove('oculto');
                         const s = document.getElementById('sac-produto');
                         s.innerHTML = '<option value="">Selecione…</option><option value="1">RESINA</option><option value="2">TALCO</option>';
                         s.value = '2'; s.focus(); })()""")
        bipar(pg, "R0000142")
        v = pg.evaluate("document.getElementById('sac-produto').value")
        ok(lidos(pg) == ["R0000142"] and v == "2", f"lista em foco: material não muda ({v}) e o bipe entra")
        pg.evaluate("const n = document.getElementById('sac-num'); n.value = '0'; n.focus(); 0")
        bipar(pg, "R0000143")
        v = pg.evaluate("document.getElementById('sac-num').value")
        ok(lidos(pg) == ["R0000143"] and v == "0", f"campo de número em foco: não vira quantidade ({v}) e o bipe entra")
        # "Focus Output": o leitor escreve direto no campo de número em foco
        pg.evaluate("const n = document.getElementById('sac-num'); n.value = '5'; n.focus(); 0")
        pg.keyboard.insert_text("R0000160"); pg.wait_for_timeout(600)
        v = pg.evaluate("document.getElementById('sac-num').value")
        ok(lidos(pg) == ["R0000160"] and v == "5", f"leitor que escreve direto no campo de número: não vira quantidade ({v})")
        # tecla atrasada no meio da leitura (tela ocupada): nada vaza para o campo
        pg.evaluate("const n = document.getElementById('sac-num'); n.value = '5'; n.focus(); 0")
        pg.keyboard.press("R"); pg.wait_for_timeout(150); pg.keyboard.type("0000161"); pg.keyboard.press("Enter"); pg.wait_for_timeout(150)
        v = pg.evaluate("document.getElementById('sac-num').value")
        ok(lidos(pg) == ["R0000161"] and v == "5", f"tecla atrasada no meio do código não vaza para o campo ({v})")
        pg.evaluate("const n = document.getElementById('sac-num'); n.value = ''; n.focus(); 0")
        pg.keyboard.type("12", delay=200)
        v = pg.evaluate("document.getElementById('sac-num').value")
        ok(lidos(pg) == [] and v == "12", f"número digitado à mão continua no campo ({v})")
        pg.evaluate("document.activeElement.blur(); document.getElementById('painel-sacos').classList.add('oculto'); 0")

        # leitor em "Focus Output" (texto direto no campo, sem tecla) e sem Enter
        pg.wait_for_timeout(1600)   # o campo só pega o foco 1 s depois da última tecla
        foco = pg.evaluate("document.activeElement && document.activeElement.id")
        ok(foco == "leitor-campo", f"campo invisível pega o foco sozinho ({foco})")
        pg.keyboard.insert_text("R0000144")
        pg.wait_for_timeout(600)
        ok(lidos(pg) == ["R0000144"], "leitor que escreve direto no campo (sem tecla, sem Enter) entra")
        pg.keyboard.type("R0000145")
        pg.wait_for_timeout(600)
        ok(lidos(pg) == ["R0000145"], "leitor sem Enter no fim entra")
        # gaiola com pausa depois do 5º "|": sai inteira, não em dois pedaços
        pg.keyboard.type("EKOPA|12|50x60|BC|40|"); pg.wait_for_timeout(200); pg.keyboard.type("1000")
        pg.keyboard.press("Enter"); pg.wait_for_timeout(300)
        ok(lidos(pg) == ["EKOPA|12|50x60|BC|40|1000"], "gaiola com pausa antes do kg sai inteira")
        # código de fornecedor sem Enter (EAN): some em 1 s e o foco volta
        pg.evaluate("document.activeElement.blur(); 0")
        pg.keyboard.type("7891234567890"); pg.wait_for_timeout(1800)
        r = [lidos(pg), pg.evaluate("document.activeElement && document.activeElement.id")]
        ok(r == [[], "leitor-campo"], f"EAN sem Enter some e o foco volta ao campo invisível ({r})")
        im = pg.evaluate("document.getElementById('leitor-campo') && document.getElementById('leitor-campo').getAttribute('inputmode')")
        ok(im == "none", "campo invisível não abre o teclado (inputmode=none)")

        # contagem por sacos: o onLeu de verdade barra o bipe
        if pg.evaluate("!document.getElementById('leitor-campo')"):   # tela de antes: campo não existe
            ok(False, "campo invisível existe")
        pg.evaluate("""(() => { window.__onLeuEspiao = window.onLeu; window.onLeu = window.__onLeuReal;
                         TIPO_INV = 'mp'; MODO_MANUAL = true; window.__n0 = leituras.length; })()""")
        pg.evaluate("onLeu('R0000146')")
        pg.wait_for_timeout(200)
        r = pg.evaluate("[leituras.length - window.__n0, document.getElementById('toast').textContent]")
        ok(r[0] == 0 and "sacos" in r[1], f"contagem por sacos: bipe não entra e avisa ({r})")
        pg.evaluate("MODO_MANUAL = false; window.onLeu = window.__onLeuEspiao; 0")

        cam = pg.evaluate("""(() => { const b = document.getElementById('btn-camera');
                              const r = b.getBoundingClientRect(); return getComputedStyle(b).display !== 'none' && r.width > 0; })()""")
        ok(cam, "botão 'Ligar câmera' visível na contagem")
        ok(not erros, f"sem erro de JS ({erros[:2]})")
        ctx.close()
    nav.close()

print("FALHOU: " + str(len(falhas)) if falhas else "OK")
sys.exit(1 if falhas else 0)
