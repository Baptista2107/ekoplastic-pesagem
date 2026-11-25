"""Teste de navegador do hub "Ekoplastic MP" no coletor (25/11/2026).

Gustavo: "pro coletor do Bruno vou precisar de um hub de aplicativos onde ele
consegue fazer entrada e retirada, mapeamento e inventário" (+ PA no mesmo dia).

Sobe o server.js de verdade com banco temporário (impressão simulada) e abre as
telas como o app abre: 360 px de largura sem "viewport largo" (o padrão da
WebView do Android) e o user-agent "… EkoColetor/2.0". Confere:

  1. Hub: 5 botões grandes, sem rolagem para o lado, cada um abre a sua tela.
  2. As 5 telas cabem em 360 px depois da senha (nada passa da borda direita).
  3. Produto Acabado fica aberto no app (no navegador ele pula para o menu).
  4. Entrada: o peso vem do MINI PC (/balanca/raw do próprio servidor, não do
     localhost do coletor) e a etiqueta sai pela impressora do Mini PC
     (POST /print/etiqueta no servidor). A etiqueta impressa é bipada na
     Retirada pelo caminho do app (onLeu) e sai do estoque.
  5. O assets/voltar.js do app fecha as janelas de verdade de cada tela.
  6. Monitor do Mini PC (1366 px): Entrada e Retirada continuam em colunas.
  7. MEDIÇÃO (não reprova): o defeito de 18/11 do PA — sessão vazia aberta
     em outro aparelho é cancelada quando o coletor entra no PA pelo hub?

Não entra no rodar-todos.js (o Mini PC não tem navegador de teste).

    cd ~/bling-claude && timeout 300 venv/bin/python -I <repo pesagem>/testes/navegador/hub_coletor.py <repo pesagem> [pasta-prints]

Sai 1 se falhar."""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from datetime import date
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

REPO = Path(sys.argv[1])
PRINTS = Path(sys.argv[2]) if len(sys.argv) > 2 else None
if PRINTS: PRINTS.mkdir(parents=True, exist_ok=True)
PIN = "5823"
UA_APP = "Mozilla/5.0 (Linux; Android 14; TC60) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 EkoColetor/2.0"
VOLTAR = (REPO / "android/app/src/main/assets/voltar.js").read_text(encoding="utf-8")
falhas = []
medicoes = []

def ok(cond, msg, det=""):
    print(("  ✓ " if cond else "  ✗ ") + msg + ("" if cond or not det else f"  [{det}]"))
    if not cond: falhas.append(msg)

def req(base, rota, corpo=None):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    r = urllib.request.Request(base + rota, data=dados, headers={"Content-Type": "application/json"} if dados else {})
    with urllib.request.urlopen(r, timeout=10) as x: return json.loads(x.read())

def senha(pg):
    pg.wait_for_timeout(800)
    if pg.locator("#eko-acesso").count() and pg.locator("#eko-acesso").is_visible():
        for ch in PIN: pg.locator("#eko-kb button", has_text=ch).first.click()
        pg.locator("#eko-kb button.ok").click(); pg.wait_for_timeout(1500)
    return not (pg.locator("#eko-acesso").count() and pg.locator("#eko-acesso").is_visible())

def cabe(pg, nome):
    """Nada passa da borda direita de 360 px (o body corta o excesso, então
    olha cada elemento visível, não só o scrollWidth)."""
    r = pg.evaluate("""() => { const w = document.documentElement.clientWidth; const fora = [];
        for (const e of document.querySelectorAll('body *')) {
          if (e.id === '__ekoScan') continue;
          const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          const b = e.getBoundingClientRect(); if (!b.width || !b.height) continue;
          if (e.closest('[style*="position:fixed"],[style*="position: fixed"]') && b.left < -50) continue;
          if (b.right > w + 1) fora.push((e.id ? '#' + e.id : e.tagName.toLowerCase() + '.' + [...e.classList].join('.')) + ' ' + Math.round(b.right));
        }
        return { sw: document.documentElement.scrollWidth, w, fora: fora.slice(0, 6), n: fora.length }; }""")
    ok(r["sw"] <= 360 and r["n"] == 0, f"{nome}: cabe em 360 px", json.dumps(r))
    if PRINTS: pg.screenshot(path=str(PRINTS / f"{nome}.png"), full_page=True)

def voltar(pg):
    return pg.evaluate(VOLTAR)

def main():
    porta = 13986
    tmp = Path(tempfile.mkdtemp(prefix="eko_hub_"))
    base = f"http://127.0.0.1:{porta}"
    env = {**os.environ, "EKO_PORT": str(porta), "EKO_PORT_CB": str(porta + 1000), "EKO_PORT_HTTPS": str(porta + 2000),
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
        req(base, "/colaboradores/salvar", {"nome": "TESTE HUB", "pin": PIN, "telas": ["mp", "pa"]})

        bal = {"peso": 0.0}
        pedidos_bal, impressoes = [], []
        with sync_playwright() as pw:
            br = _navegador(pw)
            def coletor():
                ctx = br.new_context(viewport={"width": 360, "height": 740}, user_agent=UA_APP, device_scale_factor=1)
                pg = ctx.new_page(); pg.set_default_timeout(6000)
                pg.on("dialog", lambda d: d.accept())
                pg.route("**/balanca/raw", lambda rota: (pedidos_bal.append(rota.request.url), rota.fulfill(
                    status=200, content_type="application/json",
                    body=json.dumps({"portaAberta": True, "porta": "COM3", "peso": bal["peso"], "ultimoByteTs": int(time.time() * 1000)}))))
                pg.on("request", lambda r: impressoes.append(r.url) if r.method == "POST" and r.url.endswith("/print/etiqueta") else None)
                return ctx, pg
            erros = []

            # ── 1. Hub ─────────────────────────────────────────────────
            print("\n[1] Hub")
            ctx, pg = coletor(); pg.on("pageerror", lambda e: erros.append("hub: " + str(e)))
            pg.goto(base + "/hub-mp.html"); pg.wait_for_timeout(1200)
            botoes = pg.locator("#hub-telas a.tela")
            ok(botoes.count() == 5, "5 botões", botoes.count())
            nomes = [botoes.nth(i).locator("b").inner_text() for i in range(botoes.count())]
            ok(nomes == ["Entrada", "Retirada", "Mapeamento", "Inventário", "Produto Acabado"], "nomes na ordem", nomes)
            alturas = [botoes.nth(i).bounding_box()["height"] for i in range(botoes.count())]
            ok(min(alturas) >= 72, "botões grandes (≥ 72 px de altura)", alturas)
            ok(pg.locator("#hub-status.on").count() == 1, "status: Mini PC conectado", pg.locator("#hub-status").inner_text())
            cabe(pg, "hub")
            destinos = {"Entrada": "/mp-recebimento-retorno.html", "Retirada": "/mp-retirada.html", "Mapeamento": "/enderecamento.html",
                        "Inventário": "/inventario.html", "Produto Acabado": "/produto-acabado.html"}
            for nome, caminho in destinos.items():
                pg.goto(base + "/hub-mp.html"); pg.wait_for_timeout(500)
                pg.locator("#hub-telas a.tela", has_text=nome).click(); pg.wait_for_timeout(1800)
                ok(pg.url.split("?")[0].endswith(caminho), f"{nome} abre {caminho}", pg.url)
            ctx.close()

            # ── 2/3. As telas no coletor ──────────────────────────────
            print("\n[2] As 5 telas em 360 px (depois da senha)")
            ctx, pg = coletor(); pg.on("pageerror", lambda e: erros.append(pg.url + ": " + str(e)))
            for nome, caminho in [("entrada", "/mp-recebimento-retorno.html?aba=recebimento"), ("retirada", "/mp-retirada.html"),
                                  ("mapeamento", "/enderecamento.html"), ("inventario", "/inventario.html"),
                                  ("pa", "/produto-acabado.html")]:
                pg.goto(base + caminho); pg.wait_for_timeout(1200)
                ok(senha(pg), f"{nome}: senha aceita")
                if nome == "pa":
                    ok(pg.url.split("?")[0].endswith("/produto-acabado.html"), "PA: fica aberto no app (não pula para o menu)", pg.url)
                    ok(pg.locator("#eko-btn-sair").count() == 0, "PA: sem o 🔒 de sair do sistema no app")
                cabe(pg, nome)
            pg.goto(base + "/mp-recebimento-retorno.html?aba=recebimento"); pg.wait_for_timeout(1500); senha(pg)
            for sel in ("#btn-imprimir", "#peso-bruto"):
                b = pg.locator(sel).bounding_box()
                ok(b and b["x"] >= 0 and b["x"] + b["width"] <= 360, f"entrada: {sel} inteiro na tela", b)
            ok(pg.locator(".abas-modo").is_visible(), "entrada: aba RETORNO DE PRODUÇÃO à mão")
            pg.goto(base + "/mp-retirada.html"); pg.wait_for_timeout(1500); senha(pg)
            ok(not pg.locator(".layout > .menu").is_visible(), "retirada: menu lateral escondido (a 🏠 faz o mesmo)")
            ctx.close()

            # ── 4. Entrada → impressão → Retirada pelo leitor do app ──
            print("\n[4] Entrada pesa na balança do Mini PC e imprime lá; Retirada lê pelo app")
            ctx, pg = coletor(); pg.on("pageerror", lambda e: erros.append("entrada: " + str(e)))
            pg.goto(base + "/mp-recebimento-retorno.html?aba=recebimento"); pg.wait_for_timeout(1200); senha(pg)
            pg.locator("#grid-mat .opt", has_text="Grão Baixa").click(); pg.wait_for_timeout(300)
            pg.locator("#grid-forn .opt").first.click(); pg.wait_for_timeout(300)
            if pg.locator("#grid-cor .opt").count(): pg.locator("#grid-cor .opt").first.click(); pg.wait_for_timeout(300)
            pg.locator("#bloco-peso button.btn-bal", has_text="Conectar").click(); pg.wait_for_timeout(600)
            bal["peso"] = 812.4
            pg.wait_for_timeout(3500)
            ok(pg.locator("#peso-bruto").input_value() == "812.4", "o peso da balança aparece no coletor", pg.locator("#peso-bruto").input_value())
            ok(pedidos_bal and all(u.startswith(base + "/balanca/raw") for u in pedidos_bal),
               "a balança é lida no servidor do Mini PC (mesmo endereço da tela)", (pedidos_bal or ["nenhum"])[0])
            n = len(impressoes)
            pg.wait_for_function("""() => { const b = document.getElementById('btn-imprimir');
                                     if (b.disabled) return false; b.click(); return true; }""", timeout=10000)
            pg.wait_for_timeout(2500)
            ok(len(impressoes) > n and impressoes[-1].startswith(base + "/print/etiqueta"),
               "IMPRIMIR vai ao servidor do Mini PC (POST /print/etiqueta)", impressoes[-1:] or "nada")
            sess = [s for s in req(base, "/sessoes/abertas?tipo=recebimento")["sessoes"]]
            etqs = sess[0]["etiquetas"] if sess else []
            ok(len(etqs) == 1 and abs(float(etqs[0].get("peso") or 0) - 812.4) < 1e-6, "etiqueta gravada com 812,4 kg",
               json.dumps(etqs)[:200])
            etq = etqs[0]["id"] if etqs else "R0000001"
            # A etiqueta que saiu da impressora é bipada na própria Entrada —
            # pelo leitor do app (onLeu), como no TC60.
            ok(pg.evaluate("typeof onLeu") == "function", "entrada tem onLeu (o app entrega o código por ela)")
            bal["peso"] = 0.0; pg.wait_for_timeout(1200)
            pg.evaluate(f"onLeu({json.dumps(etq)})"); pg.wait_for_timeout(2000)
            st = [e.get("status") for s in req(base, "/sessoes/abertas?tipo=recebimento")["sessoes"] for e in s["etiquetas"]]
            ok(st == ["bipada"], f"bipe {etq} pelo app confirmou a etiqueta na Entrada", st)
            # Fecha o recebimento para o bag ir ao estoque (como o Bruno faria).
            try: req(base, f"/sessoes/{sess[0]['id']}/finalizar", {})
            except Exception as e: ok(False, "finalizar o recebimento", str(e))
            ctx.close()

            ctx, pg = coletor(); pg.on("pageerror", lambda e: erros.append("retirada: " + str(e)))
            pg.goto(base + "/mp-retirada.html"); pg.wait_for_timeout(1200); senha(pg)
            ok(pg.evaluate("typeof onLeu") == "function", "retirada tem onLeu (o app entrega o código por ela)")
            pg.evaluate(f"onLeu({json.dumps(etq)})"); pg.wait_for_timeout(2500)
            if pg.locator("#modal-fora.ativo").count():          # pedido do painel: escolhe o motivo de teste
                pg.locator("#modal-fora button", has_text="Outro").first.click()
            ret = [s for s in req(base, "/sessoes/abertas?tipo=retirada")["sessoes"]]
            ids = [e["id"] for s in ret for e in (s.get("etiquetas") or [])]
            orig = req(base, "/etiquetas/" + etq)
            orig = orig.get("etiqueta", orig)
            ok(len(ids) == 1 and orig.get("status") == "consumida",
               f"bipe {etq} pelo app saiu na retirada ({etq} consumida, item {ids})", json.dumps(orig)[:200])

            # ── 5. Voltar do Android nas janelas reais ─────────────────
            print("\n[5] Voltar do Android (assets/voltar.js) nas telas de verdade")
            pg.evaluate("abrirKeypad && abrirKeypad('digitar')") if pg.evaluate("typeof abrirKeypad") == "function" else \
                pg.locator("button", has_text="Digitar").first.click()
            pg.wait_for_timeout(300)
            aberto = pg.locator("#keypad-modal.ativo").count() == 1
            r = voltar(pg); pg.wait_for_timeout(300)
            ok(aberto and r == "fechou" and pg.locator("#keypad-modal.ativo").count() == 0, "retirada: fecha o teclado da tela", r)
            ok(voltar(pg) == "hub", "retirada sem janela: pede o hub")
            ctx.close()

            ctx, pg = coletor()
            pg.goto(base + "/produto-acabado.html"); pg.wait_for_timeout(1200); senha(pg)
            pg.evaluate("abrirGaiola()"); pg.wait_for_timeout(300)
            r = voltar(pg); pg.wait_for_timeout(300)
            ok(r == "fechou" and pg.locator("#modal-gaiola.on").count() == 0, "PA: fecha a janela da gaiola", r)
            pg.goto(base + "/inventario.html"); pg.wait_for_timeout(1500)
            pg.locator("button, .opcao, div", has_text="MATÉRIA-PRIMA").last.click(); pg.wait_for_timeout(800)
            vis = pg.locator("#btn-voltar").is_visible()
            r = voltar(pg); pg.wait_for_timeout(600)
            ok(vis and r == "fechou", "inventário: Voltar volta um passo dentro da tela", f"{vis} {r}")
            pg.goto(base + "/mp-recebimento-retorno.html?aba=recebimento"); pg.wait_for_timeout(800)
            pg.evaluate("sessionStorage.clear()"); pg.reload(); pg.wait_for_timeout(1000)
            ok(pg.locator("#eko-acesso").is_visible() and voltar(pg) == "hub", "teclado da senha na frente: Voltar pede o hub")
            ctx.close()

            # ── 6. Monitor do Mini PC ──────────────────────────────────
            print("\n[6] Monitor do Mini PC (1366 px) sem mudança")
            ctx = br.new_context(viewport={"width": 1366, "height": 768}); pg = ctx.new_page()
            pg.goto(base + "/mp-recebimento-retorno.html?aba=recebimento&embed=1"); pg.wait_for_timeout(1000); senha(pg)
            b = pg.locator(".coluna-direita").bounding_box()
            ok(b and b["x"] > 900 and abs(b["width"] - 340) < 2, "entrada: coluna da etiqueta à direita, 340 px", b)
            pg.goto(base + "/mp-retirada.html"); pg.wait_for_timeout(1000); senha(pg)
            ok(pg.locator(".layout > .menu").is_visible(), "retirada (fora do quadro): menu lateral continua")
            b = pg.locator(".historico-side").bounding_box()
            ok(b and b["x"] > 900, "retirada: histórico à direita", b)
            ctx.close()

            # ── 7. MEDIÇÃO: defeito de 18/11 do PA ─────────────────────
            print("\n[7] MEDIÇÃO — sessão vazia de PA aberta em outro aparelho")
            hoje = date.today().isoformat()
            def abrir_pa(op):
                return req(base, "/sessoes", {"tipo": "produto-acabado", "turno_codigo": "A", "fornecedor": "TURNO A - SACOLEIRAS EKOPLASTIC",
                                              "data_lancamento": hoje, "operador": op})["sessao_id"]
            def aberta(sid):
                return any(s["id"] == sid for s in req(base, "/sessoes/abertas?tipo=produto-acabado")["sessoes"])
            sid = abrir_pa("OUTRA PESSOA (Mini PC)")
            ctx, pg = coletor()
            pg.goto(base + "/hub-mp.html"); pg.wait_for_timeout(600)
            pg.locator("#hub-telas a.tela", has_text="Produto Acabado").click(); pg.wait_for_timeout(1500)
            antes = aberta(sid)
            senha(pg); pg.wait_for_timeout(1500)
            depois = aberta(sid)
            medicoes.append(f"sessão vazia #{sid} do outro aparelho: com o teclado da senha na tela → {'aberta' if antes else 'CANCELADA'}; "
                            f"depois da senha no coletor → {'aberta' if depois else 'CANCELADA'}")
            ctx.close()
            # E com 1 item lançado no outro aparelho?
            sid2 = abrir_pa("OUTRA PESSOA (Mini PC)")
            req(base, "/produto-acabado/item", {"sessao_id": sid2, "corKey": "BC", "formato": "50x60", "fardos": 2, "maquina": "P1"})
            ctx, pg = coletor()
            pg.goto(base + "/produto-acabado.html"); pg.wait_for_timeout(800); senha(pg); pg.wait_for_timeout(1500)
            retomou = pg.evaluate("state.sessaoId")
            medicoes.append(f"sessão #{sid2} do outro aparelho COM 1 item: continua {'aberta' if aberta(sid2) else 'CANCELADA'}; "
                            f"o coletor {'RETOMOU essa sessão (lança nela)' if retomou == sid2 else 'não retomou'} (state.sessaoId={retomou})")
            ctx.close()
            ok(not erros, "sem erro de JavaScript", "; ".join(erros)[:400])
            br.close()
    finally:
        srv.kill(); srv.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)
    for m in medicoes: print("  MEDIÇÃO: " + m)
    print(f"\n{'FALHOU: ' + str(len(falhas)) if falhas else 'OK'}")
    sys.exit(1 if falhas else 0)

main()
