"""Teste de navegador: alerta de pedido de retirada no coletor TC60 (25/11/2026).

Gustavo, 25/11: "deixa um alerta de pedido de retirada no coletor da melhor
forma possível, pode fazer o coletor vibrar e colocar alerta na tela e um botão
de ver pedido direto na tela de retirada".

Sobe o server.js de verdade (banco temporário, portas 14130/14131/14132) e
responde GET /retirada/pedidos com pedidos de mentira (o Mini PC de teste não
fala com a VPS). Abre cada tela do hub como o app 2.2 abre: user-agent
"… EkoColetor/2.2", EkoApp.alertar() contando as vibrações, e o mesmo
<script src="/alerta-pedidos.js"> que o app põe ao fim do carregamento.

  1. Em cada uma das 7 telas do hub (e no hub): a faixa aparece no alto, por
     cima, inteira na largura de 360 px, texto ≥ 16 px com contraste ≥ 7:1,
     VER PEDIDO e ✕ com ≥ 56 px, ocupando no máximo 40 % da tela de 648 px.
  2. Vibra uma vez só pelo mesmo pedido, também trocando de tela.
  3. VER PEDIDO abre a tela de Retirada; lá não há faixa.
  4. ✕ some com a faixa e ela não volta para o mesmo pedido; pedido novo volta.
  5. Pedido novo com a tela de Retirada aberta: vibra, sem faixa.
  6. Pedidos desligados no Mini PC: nada.
  7. Monitor do Mini PC (sem "EkoColetor"): nem pergunta pelos pedidos.

    cd ~/bling-claude && timeout 300 venv/bin/python -I <repo pesagem>/testes/navegador/alerta_pedidos_tc60.py <repo pesagem> [pasta-prints]

Sai 1 se falhar. Não entra no rodar-todos.js (o Mini PC não tem navegador de teste)."""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

REPO = Path(sys.argv[1])
PRINTS = Path(sys.argv[2]) if len(sys.argv) > 2 else None
if PRINTS: PRINTS.mkdir(parents=True, exist_ok=True)
UA_APP = "Mozilla/5.0 (Linux; Android 14; TC60) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 EkoColetor/2.2"
UA_MONITOR = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36"
LARG, ALT, ALT_UTIL = 360, 690, 648
TELAS = ["/hub-mp.html", "/mp-recebimento-retorno.html?aba=recebimento", "/mp-recebimento-retorno.html?aba=retorno",
         "/outras-pesagens.html", "/enderecamento.html", "/inventario.html", "/produto-acabado.html"]
RETIRADA = "/mp-retirada.html"
falhas = []

def ok(cond, msg, det=""):
    print(("  ✓ " if cond else "  ✗ ") + msg + ("" if cond or not det else f"  [{det}]"))
    if not cond: falhas.append(msg)

def req(base, rota, corpo=None):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    r = urllib.request.Request(base + rota, data=dados, headers={"Content-Type": "application/json"} if dados else {})
    with urllib.request.urlopen(r, timeout=10) as x: return json.loads(x.read())

def pedido(id_, **k):
    p = {"id": id_, "status": "aberto", "cancelado_em": None, "autor_nome": "Willian", "unidade": "bag", "bags_pedidos": 2,
         "material_nome": "COLORIDO BAIXA DENSIDADE", "fornecedor": "Piquiri", "lote_fmt": ""}
    p.update(k); return p

# O app: EkoApp.alertar() contado e, no fim do carregamento, o MESMO arquivo
# que MainActivity.injetarAlertaPedidos() roda (assets/injetar-alerta.js).
INJETAR = """
window.__vibrou = 0;
window.EkoApp = { versao: () => '2.2', alertar: () => { window.__vibrou++; } };
window.addEventListener('load', () => { %s });
""" % (REPO / "android/app/src/main/assets/injetar-alerta.js").read_text()

MEDIR = r"""() => {
  const f = document.getElementById('eko-alerta-pedido');
  if (!f) return null;
  const cs = getComputedStyle(f), b = f.getBoundingClientRect();
  const rgba = s => { const m = s.match(/rgba?\(([^)]+)\)/); if (!m) return [0,0,0,0];
    const p = m[1].split(/[ ,\/]+/).filter(Boolean).map(Number); return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1]; };
  const lum = c => { const g = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * g(c[0]) + 0.7152 * g(c[1]) + 0.0722 * g(c[2]); };
  const fundo = e => { for (let x = e; x; x = x.parentElement) { const c = rgba(getComputedStyle(x).backgroundColor); if (c[3] > 0.99) return c; } return [255,255,255,1]; };
  const pequenos = [], baixos = [], fora = [];
  for (const e of [f, ...f.querySelectorAll('*')]) {
    const r = e.getBoundingClientRect();
    if (r.right > innerWidth + 0.5 || r.left < -0.5) fora.push(e.className + ' ' + Math.round(r.left) + '..' + Math.round(r.right));
    if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const c = getComputedStyle(e);
    if (parseFloat(c.fontSize) < 15.99) pequenos.push(e.className + ' ' + c.fontSize);
    const l1 = lum(rgba(c.color)), l2 = lum(fundo(e)), cr = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    if (/[A-Za-z0-9]/.test(e.textContent) && cr < 7) baixos.push(e.className + ' ' + cr.toFixed(1));
  }
  // Em cima de tudo: o elemento no meio do VER PEDIDO é o próprio botão.
  const ver = f.querySelector('.eap-ver'), fe = f.querySelector('.eap-fechar');
  const rv = ver.getBoundingClientRect(), rf = fe.getBoundingClientRect();
  const topo = document.elementFromPoint(rv.left + rv.width / 2, rv.top + rv.height / 2);
  return { pos: cs.position, top: b.top, h: b.height, w: b.width, z: cs.zIndex,
           tit: f.querySelector('.eap-tit').textContent, lin: f.querySelector('.eap-lin').textContent,
           ver: { txt: ver.textContent, h: rv.height, w: rv.width }, fe: { h: rf.height, w: rf.width },
           porCima: topo === ver || ver.contains(topo), pequenos, baixos, fora };
}"""

def main():
    porta = 14130
    tmp = Path(tempfile.mkdtemp(prefix="eko_alerta_tc60_"))
    base = f"http://127.0.0.1:{porta}"
    env = {**os.environ, "EKO_PORT": str(porta), "EKO_PORT_CB": "14131", "EKO_PORT_HTTPS": "14132",
           "EKO_DB_FILE": str(tmp / "t.db"), "EKO_LOG_DIR": str(tmp / "logs"), "TZ": "America/Sao_Paulo",
           "EKO_PRINT_SIMULAR": "1", "EKO_FECHAR_TELA_SIMULAR": "1"}
    srv = subprocess.Popen(["node", str(REPO / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(75):
            try:
                if req(base, "/healthcheck").get("ok"): break
            except Exception: pass
            time.sleep(0.2)
        req(base, "/config", {"vps_sacoleiras_url": "http://127.0.0.1:9/api/sacoleiras/agora"})
        with sync_playwright() as pw:
            br = _navegador(pw)
            resposta = {"ok": True, "modo": "teste", "pedidos": [pedido("RM-1")]}
            perguntas = []
            def responder(rota):
                perguntas.append(rota.request.url)
                rota.fulfill(status=200, content_type="application/json", body=json.dumps(resposta))
            erros = []
            def contexto(ua=UA_APP, app=True):
                ctx = br.new_context(viewport={"width": LARG, "height": ALT_UTIL}, user_agent=ua, device_scale_factor=2,
                                     has_touch=ua == UA_APP)   # sem is_mobile: a WebView do app não usa "viewport largo"
                if app: ctx.add_init_script(INJETAR)
                ctx.route("**/retirada/pedidos*", responder)
                pg = ctx.new_page(); pg.set_default_timeout(15000)
                pg.on("pageerror", lambda e: erros.append(str(e)))
                return ctx, pg
            def faixa(pg, esperar=True):
                if esperar:
                    try: pg.wait_for_selector("#eko-alerta-pedido", timeout=6000)
                    except Exception: pass
                else: pg.wait_for_timeout(1500)
                return pg.evaluate(MEDIR)

            print(f"\n[1] Faixa em cada tela do hub ({LARG}×{ALT_UTIL}), contexto novo em cada (pedido nunca visto)")
            for tela in TELAS:
                ctx, pg = contexto()
                pg.goto(base + tela, wait_until="load")
                r = faixa(pg)
                n = tela.split("/")[-1]
                ok(r is not None, f"{n}: faixa aparece")
                if r:
                    ok(r["pos"] == "fixed" and abs(r["top"]) < 0.5 and abs(r["w"] - LARG) < 1, f"{n}: no alto, largura toda", json.dumps(r)[:200])
                    ok(r["h"] <= 0.40 * ALT_UTIL, f"{n}: ocupa ≤ 40 % da tela", round(r["h"]))
                    ok(r["ver"]["h"] >= 56 and r["fe"]["h"] >= 56 and r["fe"]["w"] >= 56, f"{n}: VER PEDIDO e ✕ com ≥ 56 px",
                       f'{r["ver"]} {r["fe"]}')
                    ok(not r["pequenos"], f"{n}: texto ≥ 16 px", r["pequenos"])
                    ok(not r["baixos"], f"{n}: contraste ≥ 7:1", r["baixos"])
                    ok(not r["fora"], f"{n}: nada passa da borda", r["fora"])
                    ok(r["porCima"], f"{n}: a faixa fica por cima da tela")
                    ok(r["tit"] == "📦 PEDIDO DE RETIRADA (Willian)" and r["lin"].startswith("2 bags · COLORIDO BAIXA DENSIDADE")
                       and r["ver"]["txt"] == "VER PEDIDO", f"{n}: texto do pedido", f'{r["tit"]} | {r["lin"]}')
                ok(pg.evaluate("window.__vibrou") == 1, f"{n}: vibrou uma vez", pg.evaluate("window.__vibrou"))
                if PRINTS and tela in ("/hub-mp.html", "/outras-pesagens.html", "/inventario.html"):
                    pg.screenshot(path=str(PRINTS / f"alerta-{n.split('.')[0]}.png"))
                ctx.close()

            print("\n[2-4] Mesmo aparelho: troca de tela, VER PEDIDO, ✕")
            ctx, pg = contexto()
            pg.goto(base + "/hub-mp.html", wait_until="load"); faixa(pg)
            pg.goto(base + "/inventario.html", wait_until="load"); r = faixa(pg)
            ok(r is not None and pg.evaluate("window.__vibrou") == 0, "outra tela: a faixa continua e não vibra de novo",
               pg.evaluate("window.__vibrou"))
            # Peso digitado na tela: VER PEDIDO pergunta antes de sair (revisor 25/11).
            pg.evaluate("""() => { const c = document.createElement('input'); c.id = 'peso-teste'; c.value = '512,3';
                                     c.style.cssText = 'position:fixed;bottom:0;left:0'; document.body.appendChild(c); }""")
            perguntou = []
            pg.once("dialog", lambda d: (perguntou.append(d.message), d.dismiss()))
            pg.click("#eko-alerta-pedido .eap-ver"); pg.wait_for_timeout(500)
            ok(perguntou and "se perde" in perguntou[0] and pg.url.endswith("/inventario.html")
               and faixa(pg, esperar=False) is not None, "com peso digitado: pergunta e, no Cancelar, fica na tela com a faixa", perguntou)
            pg.once("dialog", lambda d: d.accept())
            pg.click("#eko-alerta-pedido .eap-ver"); pg.wait_for_load_state("load")
            ok(pg.url.endswith(RETIRADA), "VER PEDIDO abre a tela de Retirada", pg.url)
            ok(faixa(pg, esperar=False) is None, "na Retirada não há faixa")
            pg.goto(base + "/hub-mp.html", wait_until="load")
            ok(faixa(pg, esperar=False) is None, "de volta ao hub: o pedido visto não volta na faixa")
            resposta["pedidos"] = [pedido("RM-1"), pedido("RM-2", unidade="kg", kg_pedidos=25, bags_pedidos=None,
                                                          material_nome="DESSECANTE", fornecedor="Cristal Master")]
            pg.reload(wait_until="load"); r = faixa(pg)
            ok(r is not None and r["lin"].startswith("25 kg · DESSECANTE") and pg.evaluate("window.__vibrou") == 1,
               "pedido novo: faixa só com ele e vibra", r and r["lin"])
            pg.click("#eko-alerta-pedido .eap-fechar")
            ok(faixa(pg, esperar=False) is None, "✕ some com a faixa")
            pg.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); pg.wait_for_timeout(1500)
            ok(faixa(pg, esperar=False) is None, "✕: o giro seguinte não traz a faixa de volta")
            pg.reload(wait_until="load")
            ok(faixa(pg, esperar=False) is None and pg.evaluate("window.__vibrou") == 0, "✕: não volta nem vibra ao recarregar")

            print("\n[5] Pedido novo com a Retirada aberta")
            pg.goto(base + RETIRADA, wait_until="load"); pg.wait_for_timeout(1500)
            resposta["pedidos"].append(pedido("RM-3"))
            pg.evaluate("document.dispatchEvent(new Event('visibilitychange'))"); pg.wait_for_timeout(1500)
            ok(pg.evaluate("window.__vibrou") == 1 and faixa(pg, esperar=False) is None, "vibra, sem faixa",
               pg.evaluate("window.__vibrou"))
            ctx.close()

            print("\n[6] Pedidos desligados no Mini PC")
            resposta.clear(); resposta.update({"desligado": True, "modo": None, "pedidos": []})
            ctx, pg = contexto(); pg.goto(base + "/hub-mp.html", wait_until="load")
            ok(faixa(pg, esperar=False) is None and pg.evaluate("window.__vibrou") == 0, "sem faixa e sem vibrar")
            ctx.close()

            print("\n[7] Monitor do Mini PC")
            resposta.clear(); resposta.update({"ok": True, "modo": "teste", "pedidos": [pedido("RM-9")]})
            perguntas.clear()
            ctx, pg = contexto(UA_MONITOR, app=False); pg.set_viewport_size({"width": 1366, "height": 768})
            pg.goto(base + "/hub-mp.html", wait_until="load")
            ok(faixa(pg, esperar=False) is None and not perguntas, "sem faixa e sem perguntar pelos pedidos", perguntas)
            ctx.close()

            ok(not erros, "nenhum erro de JavaScript nas telas", "; ".join(erros[:5]))
            br.close()
    finally:
        srv.terminate()
        try: srv.wait(timeout=10)
        except Exception: srv.kill()
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'OK' if not falhas else str(len(falhas)) + ' FALHA(S)'}")
    sys.exit(1 if falhas else 0)

main()
