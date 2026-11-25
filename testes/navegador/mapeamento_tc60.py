"""Mapeamento (enderecamento.html) no coletor TC60 do Bruno (25/11/2026).

Gustavo: "não tá legal de ver no android do TC60" — "todas as telas merecem
atenção uma a uma". O TC60 (Android 14, 720x1440, dpr 2) mostra a página em
~360x690 px de CSS, e a WebView do app não usa "viewport largo". O Bruno usa
com uma mão, às vezes de luva.

Sobe o server.js de verdade com banco temporário (portas 14140/14141/14142,
impressão simulada) e abre a tela como o app abre (360x690, user-agent
"… EkoColetor/2.0"). Em cada estado — senha, ENDEREÇAR vazio, endereço bipado,
endereço ocupado (aviso), big bag bipado, confirmado, etiqueta errada,
RETIRAR, MAPA, rua cheia, detalhe de um vão, ficha do histórico — confere:

  1. sem rolagem para o lado e nada passando da borda (nem dentro de caixa
     que rola de lado: vão escondido à direita é vão cortado), nem texto
     vazando do botão ou encolhido com reticências;
  2. todo controle visível dentro da tela e com pelo menos 56 px (botão e vão:
     56x56; campo, quadro e linha do histórico: 56 de altura);
  3. todo texto com pelo menos 16 px;
  4. no ENDEREÇAR, os dois quadros (o que bipar e onde) e o CONFIRMAR à vista
     sem rolar.
  5. Câmera de reserva ligada nasce à vista; sem a fonte do Google (sem
     internet) o nome do cabeçalho não vira reticências.
  6. Monitor do Mini PC (1366) e a faixa do celular.css acima de 600 px (768
     e 601): posição, tamanho e fonte de todo elemento e a foto da tela
     (pixel a pixel, tolerando 8/255 de serrilhado) iguais aos da tela de referência (--ref, padrão 7e5097a,
     a de antes desta mudança; só o enderecamento.html é trocado), no MAPA e
     no ENDEREÇAR.

A tela da senha e o crachá vêm do acesso-colaborador.js (arquivo de todas as
telas): ali só se cobra o item 1; fonte e tamanho são medidos e impressos,
sem reprovar.

Não entra no rodar-todos.js (o Mini PC não tem navegador de teste).

    cd ~/bling-claude && timeout 300 venv/bin/python -I <repo>/testes/navegador/mapeamento_tc60.py <repo> [pasta-fotos] [prefixo] [--ref=<commit>]

Sai 1 se falhar."""
import io, json, os, shutil, signal, socket, subprocess, sys, tempfile, time, urllib.request
from PIL import Image, ImageChops
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

args = [a for a in sys.argv[1:] if not a.startswith("--")]
REF = next((a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--ref=")), "7e5097a")
REPO = Path(args[0])
FOTOS = Path(args[1]) if len(args) > 1 else None
PREFIXO = args[2] if len(args) > 2 else "tc60"
if FOTOS: FOTOS.mkdir(parents=True, exist_ok=True)
PIN = "5823"
UA_APP = "Mozilla/5.0 (Linux; Android 14; TC60) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 EkoColetor/2.0"
W, H = 360, 690
TOQUE, FONTE = 56, 16
falhas, medicoes = [], []

def ok(cond, msg, det=""):
    print(("  ✓ " if cond else "  ✗ ") + msg + ("" if cond or not det else f"  [{det}]"))
    if not cond: falhas.append(msg)

def req(base, rota, corpo=None):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    r = urllib.request.Request(base + rota, data=dados, headers={"Content-Type": "application/json"} if dados else {})
    with urllib.request.urlopen(r, timeout=10) as x: return json.loads(x.read())

# Mede a tela inteira (não só o que está à vista): o que é cortado na borda,
# controle pequeno e texto miúdo. COMPARTILHADO = vem do acesso-colaborador.js.
MEDIR = """([W, TOQUE, FONTE]) => {
  const COMPARTILHADO = '#eko-acesso, #eko-resp-tag, .eko-resp-tag, #eko-btn-sair, [id^="eko-outro"], [id^="eko-confirma"]';
  const vis = e => e.checkVisibility ? e.checkVisibility({checkOpacity: false, checkVisibilityCSS: true}) : !!e.offsetParent;
  const nome = e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].join('.') : ''))
                    + (e.textContent ? ' "' + e.textContent.trim().slice(0, 18) + '"' : '');
  const cortado = [], pequeno = [], miudo = [], compart = [];
  const ehControle = e => e.matches('button, input, select, textarea, .vao, .slot, .hist-item, [onclick], [role=button]');
  for (const e of document.querySelectorAll('body *')) {
    if (e.id === '__ekoScan' || e.closest('#reader')) continue;
    if (!vis(e)) continue;
    const b = e.getBoundingClientRect(); if (b.width < 1 || b.height < 1) continue;
    const doAcesso = !!e.closest(COMPARTILHADO);
    if (b.right > W + 1 || b.left < -1) cortado.push(nome(e) + ' ' + Math.round(b.left) + '..' + Math.round(b.right));
    // Texto que não cabe na própria caixa (botão com a palavra vazando,
    // título com reticências) também é cortado.
    else if (!doAcesso && (ehControle(e) || getComputedStyle(e).textOverflow === 'ellipsis') && e.scrollWidth > e.clientWidth + 1
             && getComputedStyle(e).overflowX !== 'auto')
      cortado.push(nome(e) + ' texto ' + e.scrollWidth + '>' + e.clientWidth);
    if (ehControle(e) && !(e.matches('.hist-item *, .slot *'))) {
      const quadrado = e.matches('button, .vao');
      const curto = quadrado ? Math.min(b.width, b.height) < TOQUE - 0.5 : b.height < TOQUE - 0.5;
      if (curto) (doAcesso ? compart : pequeno).push(nome(e) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
    }
    const temTexto = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (temTexto) {
      const fs = parseFloat(getComputedStyle(e).fontSize);
      if (fs < FONTE - 0.05) (doAcesso ? compart : miudo).push(nome(e) + ' ' + fs + 'px');
    }
  }
  return { sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth,
           cortado, pequeno, miudo, compart };
}"""

def medir(pg, estado):
    r = pg.evaluate(MEDIR, [W, TOQUE, FONTE])
    ok(r["sw"] <= W, f"{estado}: sem rolagem para o lado ({r['sw']} ≤ {W})")
    ok(not r["cortado"], f"{estado}: nada passa da borda", f"{len(r['cortado'])}: " + "; ".join(r["cortado"][:4]))
    ok(not r["pequeno"], f"{estado}: controles com ≥ {TOQUE} px", f"{len(r['pequeno'])}: " + "; ".join(r["pequeno"][:5]))
    ok(not r["miudo"], f"{estado}: texto ≥ {FONTE} px", f"{len(r['miudo'])}: " + "; ".join(r["miudo"][:5]))
    if r["compart"]:
        medicoes.append(f"{estado} (acesso-colaborador.js, compartilhado): {len(r['compart'])} abaixo do mínimo — "
                        + "; ".join(r["compart"][:6]))
    return r

def a_vista(pg, estado, seletores):
    """Os seletores existem, estão visíveis e aparecem inteiros na tela sem rolar."""
    pg.evaluate("window.scrollTo(0, 0)"); pg.wait_for_timeout(150)
    fora = pg.evaluate("""([sels, H]) => sels.map(s => { const e = document.querySelector(s);
        if (!e || !(e.checkVisibility ? e.checkVisibility() : e.offsetParent)) return s + ' não aparece';
        const b = e.getBoundingClientRect(); return (b.top >= 0 && b.bottom <= H + 0.5) ? null : s + ' ' + Math.round(b.top) + '..' + Math.round(b.bottom);
      }).filter(Boolean)""", [seletores, H])
    ok(not fora, f"{estado}: {', '.join(seletores)} à vista sem rolar", "; ".join(fora))

def parar_rolagem(pg):
    """Espera o scrollIntoView suave terminar (scrollY parado)."""
    pg.wait_for_function("""() => new Promise(r => { let y = scrollY, n = 0;
        const t = setInterval(() => { if (scrollY === y) { if (++n >= 4) { clearInterval(t); r(true); } } else { y = scrollY; n = 0; } }, 100); })""")

def foto(pg, estado, inteira=False):
    if FOTOS:
        pg.screenshot(path=str(FOTOS / f"{PREFIXO}-{estado}.png"), full_page=False)
        if inteira: pg.screenshot(path=str(FOTOS / f"{PREFIXO}-{estado}-inteira.png"), full_page=True)

def senha(pg):
    pg.wait_for_timeout(800)
    if pg.locator("#eko-acesso").count() and pg.locator("#eko-acesso").is_visible():
        for ch in PIN: pg.locator("#eko-kb button", has_text=ch).first.click()
        pg.locator("#eko-kb button.ok").click(); pg.wait_for_timeout(1500)
    return not (pg.locator("#eko-acesso").count() and pg.locator("#eko-acesso").is_visible())

ASSINATURA = """() => [...document.querySelectorAll('body *')].filter(e => !e.closest('#reader')).map(e => {
    const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return [e.tagName + (e.id ? '#' + e.id : '') + '.' + [...e.classList].join('.'),
            Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height),
            cs.fontSize, cs.display, cs.padding, cs.minHeight, cs.flexWrap, cs.gridTemplateColumns].join('|'); })"""

def pixels_diferentes(png1, png2):
    """Pixels que mudam de verdade. O Chromium às vezes pinta a mesma tela com
    1 nível de cor de diferença no contorno do texto (medido: 37 pixels, 1/255,
    com a máquina carregada); isso não é mudança e não conta."""
    a, b = (Image.open(io.BytesIO(x)).convert("RGB") for x in (png1, png2))
    if a.size != b.size: return -1
    h = ImageChops.difference(a, b).convert("L").histogram()
    return sum(h[9:])

def main():
    porta = 14140
    tmp = Path(tempfile.mkdtemp(prefix="eko_map_tc60_"))
    base = f"http://127.0.0.1:{porta}"
    env = {**os.environ, "EKO_PORT": str(porta), "EKO_PORT_CB": "14141", "EKO_PORT_HTTPS": "14142",
           "EKO_DB_FILE": str(tmp / "t.db"), "EKO_LOG_DIR": str(tmp / "logs"), "TZ": "America/Sao_Paulo",
           "EKO_PRINT_SIMULAR": "1", "EKO_FECHAR_TELA_SIMULAR": "1"}
    html_ref = subprocess.run(["git", "-C", str(REPO), "show", f"{REF}:public/enderecamento.html"],
                              capture_output=True, text=True, check=True).stdout
    for pt in (14140, 14141, 14142):          # porta ocupada = outro servidor (outro banco, outro código)
        with socket.socket() as so:
            if so.connect_ex(("127.0.0.1", pt)) == 0: sys.exit(f"porta {pt} já ocupada: outro teste rodando?")
    # timeout/kill manda SIGTERM: vira saída normal para o finally derrubar o server.js.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    srv = subprocess.Popen(["node", str(REPO / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        subiu = False
        for _ in range(150):
            try:
                if req(base, "/healthcheck").get("ok"): subiu = True; break
            except Exception: pass
            time.sleep(0.2)
        if not subiu or srv.poll() is not None: sys.exit("o server.js de teste não subiu")
        # Nada deste banco de teste vai para a VPS de verdade.
        req(base, "/config", {"vps_sacoleiras_url": "http://127.0.0.1:9/api/sacoleiras/agora"})
        req(base, "/colaboradores/salvar", {"nome": "TESTE TC60", "pin": PIN, "telas": ["pa"]})
        # Um big bag de MP no estoque (R…, status bipada), como a Entrada deixaria.
        sid = req(base, "/sessoes", {"tipo": "recebimento", "fornecedor": "PIQUIRI", "operador": "TESTE"})["sessao_id"]
        et = req(base, "/print/etiqueta", {"tipo": "recebimento", "sessao_id": sid, "fornecedor": "PIQUIRI", "peso": 834.5,
                                           "codigo": "GBD", "sku": "GBD", "lote": "S/L", "materialKey": "GBD",
                                           "materialNomeEt": "BAIXA DENSIDADE", "cor": "Preto"})
        bag = et.get("id") or et.get("etiqueta", {}).get("id")
        req(base, f"/etiquetas/{bag}/bipar", {})
        # Rua 02 inteira ocupada (o caso "rua cheia") e 01-01-012 com gaiola (aviso de ocupado).
        mapa = req(base, "/enderecamento/mapa")
        n = 0
        for p in mapa["posicoes"]:
            if p["rua"] == 2 and not p["bloqueada"]:
                n += 1
                req(base, "/enderecamento/ocupar", {"posicao": p["codigo"], "gaiola_id": f"G{9000 + n:07d}", "formato": "50x60",
                                                    "cor": "BC", "fardos": 40, "kg": 1000, "tipo_gaiola": p["tipo_gaiola"], "operador": "ADNILSON"})
        req(base, "/enderecamento/ocupar", {"posicao": "01-01-012", "gaiola_id": "G0000124", "formato": "40x50",
                                            "cor": "AZ", "fardos": 36, "kg": 900, "operador": "BRUNO"})
        print(f"banco de teste: bag {bag}, rua 02 com {n} gaiolas, 01-01-012 ocupado")

        with sync_playwright() as pw:
            br = _navegador(pw)
            erros = []
            # ── TC60 ───────────────────────────────────────────────────
            print(f"\n[TC60 {W}x{H}, user-agent do app]")
            ctx = br.new_context(viewport={"width": W, "height": H}, user_agent=UA_APP, device_scale_factor=2,
                                 is_mobile=True, has_touch=True)
            pg = ctx.new_page(); pg.set_default_timeout(20000)
            pg.on("pageerror", lambda e: erros.append(str(e)))
            pg.on("dialog", lambda d: d.accept())
            pg.goto(base + "/enderecamento.html"); pg.wait_for_timeout(1200)
            ok(pg.locator("#eko-acesso").is_visible(), "a tela pede a senha")
            foto(pg, "senha"); medir(pg, "senha")
            ok(senha(pg), "senha aceita")
            pg.wait_for_timeout(600)
            ok(pg.evaluate("ABA") == "acao", "no coletor a tela nasce no ENDEREÇAR")
            PRINCIPAL = ["#slot-end", "#slot-gai", "#btn-confirmar"]
            foto(pg, "enderecar-vazio", inteira=True); medir(pg, "ENDEREÇAR vazio"); a_vista(pg, "ENDEREÇAR vazio", PRINCIPAL)

            def ler(cod, espera=700):
                pg.evaluate("for (const k of Object.keys(ultimaLeitura)) delete ultimaLeitura[k]")
                pg.evaluate(f"onLeu({json.dumps(cod)})"); pg.wait_for_timeout(espera)

            ler("01-01-010")
            ok(pg.inner_text("#v-end") == "01-01-010", "endereço bipado aparece no quadro")
            foto(pg, "endereco-bipado"); medir(pg, "endereço bipado"); a_vista(pg, "endereço bipado", PRINCIPAL)
            ler(bag)
            ok(pg.inner_text("#v-gai") == bag and pg.is_enabled("#btn-confirmar"), "big bag bipado, CONFIRMAR liberado")
            foto(pg, "bag-bipado"); medir(pg, "big bag bipado"); a_vista(pg, "big bag bipado", PRINCIPAL)
            pg.locator("#btn-confirmar").tap(); pg.wait_for_timeout(1200)
            ok("guardada" in pg.inner_text("#msg"), "confirmado: ✓ guardada")
            foto(pg, "confirmado"); medir(pg, "confirmado"); a_vista(pg, "confirmado", ["#msg"] + PRINCIPAL)
            ler("01-01-012")
            ok("já tem" in pg.inner_text("#msg"), "endereço ocupado: aviso")
            foto(pg, "endereco-ocupado"); medir(pg, "endereço ocupado"); a_vista(pg, "endereço ocupado", ["#msg"] + PRINCIPAL)
            ler("XYZ-QUALQUER")
            ok("não é etiqueta" in pg.inner_text("#msg"), "etiqueta errada: erro")
            foto(pg, "erro-etiqueta"); medir(pg, "etiqueta errada"); a_vista(pg, "etiqueta errada", ["#msg"] + PRINCIPAL)
            pg.locator("#md-saida").tap(); pg.wait_for_timeout(300)
            ler("01-01-012")
            ok("Vai retirar" in pg.inner_text("#msg"), "RETIRAR: mostra o que vai sair")
            foto(pg, "retirar"); medir(pg, "RETIRAR"); a_vista(pg, "RETIRAR", ["#msg", "#slot-end", "#btn-confirmar"])
            pg.locator("#md-entrada").tap(); pg.wait_for_timeout(300)
            # Câmera de reserva (celular sem leitor): o html5-qrcode põe style no
            # #reader. Ligada, ela tem de nascer à vista, logo abaixo de COLOCAR/RETIRAR.
            pg.evaluate("""() => { const r = document.getElementById('reader'); r.classList.add('on');
                r.style.position = 'relative'; r.style.height = '300px'; scrollTo(0, 0); }""")
            pg.wait_for_timeout(200)
            cam = pg.evaluate("""() => { const r = document.getElementById('reader').getBoundingClientRect(),
                m = document.querySelector('.modos').getBoundingClientRect(), s = document.getElementById('slot-end').getBoundingClientRect();
                return {topo: r.top, modos: m.bottom, quadros: s.top}; }""")
            ok(cam["topo"] >= cam["modos"] and cam["topo"] < H - 200 and cam["quadros"] > cam["topo"],
               "câmera ligada aparece logo abaixo de COLOCAR/RETIRAR, à vista", cam)
            pg.evaluate("() => { const r = document.getElementById('reader'); r.classList.remove('on'); r.removeAttribute('style'); }")
            pg.evaluate("HIST_ABERTO.clear(); carregarHistorico()"); pg.wait_for_timeout(500)
            it = pg.locator("#hist .hist-item").first
            it.scroll_into_view_if_needed(); it.tap(); pg.wait_for_timeout(300)
            ok(it.locator(".hist-det").is_visible(), "histórico: o toque abre a ficha")
            if FOTOS: pg.screenshot(path=str(FOTOS / f"{PREFIXO}-historico-ficha.png"), full_page=False)
            medir(pg, "ficha do histórico")

            pg.locator("#ab-mapa").tap(); pg.wait_for_timeout(900)
            foto(pg, "mapa", inteira=True); medir(pg, "MAPA")
            pg.locator(".chip[data-rua='2']").tap(); pg.wait_for_timeout(400)
            ok("114 de 114 ocupadas" in pg.inner_text("#mapa"), "rua 02 filtrada e cheia (114 de 114)", pg.inner_text("#mapa")[:60])
            foto(pg, "rua-cheia", inteira=True); medir(pg, "rua cheia")
            pg.locator(".vao.ocupada").nth(40).tap(); pg.wait_for_timeout(300); parar_rolagem(pg)
            ok(pg.locator("#detalhe .det").is_visible(), "tocar num vão abre o detalhe")
            d = pg.locator("#detalhe .det").bounding_box()
            cab = pg.locator("header").bounding_box()
            ok(d and d["y"] >= cab["y"] + cab["height"] - 1 and d["y"] < H - 80,
               "o detalhe aparece na tela, abaixo do cabeçalho, depois do toque", f"detalhe {d}, cabeçalho {cab}")
            foto(pg, "mapa-detalhe"); medir(pg, "detalhe do vão")
            ctx.close()

            # Sem internet (o galpão não pode depender dela): a fonte do Google
            # não chega e entra a fonte reserva. O nome não pode virar reticências.
            print("\n[TC60 sem a fonte do Google]")
            ctx = br.new_context(viewport={"width": W, "height": H}, user_agent=UA_APP, device_scale_factor=2,
                                 is_mobile=True, has_touch=True)
            pg = ctx.new_page(); pg.set_default_timeout(20000)
            pg.route("**/fonts.googleapis.com/**", lambda r: r.abort()); pg.route("**/fonts.gstatic.com/**", lambda r: r.abort())
            pg.goto(base + "/enderecamento.html"); senha(pg); pg.wait_for_timeout(600)
            foto(pg, "sem-fonte-google"); medir(pg, "sem a fonte do Google")
            ctx.close()

            # ── Monitor do Mini PC (e a faixa 600-900 px do celular.css) ──
            for largura in (1366, 768, 601):
              print(f"\n[{largura}x768: igual à tela de {REF}]")
              assin = {}
              for qual in ("ref", "atual"):
                # Sem animação (o pulso do leitor) para a foto da tela sair igual pixel a pixel.
                ctx = br.new_context(viewport={"width": largura, "height": 768}, reduced_motion="reduce"); pg = ctx.new_page()
                if qual == "ref":
                    pg.route("**/enderecamento.html", lambda r: r.fulfill(status=200, content_type="text/html; charset=utf-8", body=html_ref))
                pg.goto(base + "/enderecamento.html"); pg.wait_for_timeout(1200); senha(pg); pg.wait_for_timeout(800)
                # O mouse parado em cima de um vão (do toque na senha) o levanta 2 px pelo :hover.
                pg.mouse.move(1, 1); pg.evaluate("irAba('mapa')"); pg.wait_for_timeout(500)
                pg.evaluate("document.fonts.ready.then(() => true)")
                a = {"mapa": pg.evaluate(ASSINATURA), "foto-mapa": pg.screenshot(full_page=True)}
                if FOTOS and qual == "atual": pg.screenshot(path=str(FOTOS / f"{PREFIXO}-{largura}-mapa.png"))
                pg.evaluate("irAba('acao')"); pg.wait_for_timeout(300)
                pg.evaluate("for (const k of Object.keys(ultimaLeitura)) delete ultimaLeitura[k]; onLeu('01-01-011')"); pg.wait_for_timeout(600)
                pg.evaluate("onLeu('EKOPA|G0000555|50x60|BC|40|1000|PEQUENA')"); pg.wait_for_timeout(600)
                a["enderecar"] = pg.evaluate(ASSINATURA); a["foto-enderecar"] = pg.screenshot(full_page=True)
                if FOTOS and qual == "atual": pg.screenshot(path=str(FOTOS / f"{PREFIXO}-{largura}-enderecar.png"))
                assin[qual] = a; ctx.close()
              for aba in ("mapa", "enderecar"):
                r_, a_ = assin["ref"][aba], assin["atual"][aba]
                dif = [f"{x} → {y}" for x, y in zip(r_, a_) if x != y]
                ok(len(r_) == len(a_) and not dif, f"{largura} {aba}: posição, tamanho e fonte iguais ({len(a_)} elementos)",
                   f"{len(r_)} vs {len(a_)}; " + "; ".join(dif[:3]))
                n = pixels_diferentes(assin["ref"]["foto-" + aba], assin["atual"]["foto-" + aba])
                ok(n == 0, f"{largura} {aba}: a foto da tela é a mesma, pixel a pixel", f"{n} pixels diferentes")
            ok(not erros, "sem erro de JavaScript", "; ".join(erros)[:300])
            br.close()
    finally:
        srv.kill(); srv.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)
    for m in medicoes: print("  MEDIÇÃO: " + m)
    print(f"\n{'FALHOU: ' + str(len(falhas)) if falhas else 'OK'}")
    sys.exit(1 if falhas else 0)

main()
