"""Teste de navegador: tela PRODUTO ACABADO no coletor TC60 (25/11/2026).

Gustavo: "não tá legal de ver no android do TC60" / "todas as telas merecem
atenção uma a uma". O TC60 tem 720x1440 px com dpr 2: a WebView do app
"Ekoplastic MP" mostra ~360 x 690 px CSS. O Bruno usa com uma mão, às vezes
de luva.

Sobe o server.js de verdade com banco temporário (impressão simulada) e abre o
PA como o app abre (360 x 690, user-agent "… EkoColetor/2.0"). Em cada estado
(turno e data, escolha, lista longa, confirmação do envio, aviso de cor,
etiqueta de gaiola) confere:

  1. nada passa da borda: sem rolagem para o lado e todo elemento visível
     entre 0 e 360 px;
  2. todo controle tocável (o que está na frente: a janela aberta, ou a tela
     se não houver janela) tem pelo menos 56 x 56 px;
  3. todo texto visível tem pelo menos 16 px;
  4. o principal de cada estado aparece sem rolar (os três "Iniciar", o
     "Adicionar", o "Confirmar e enviar", o "Imprimir etiqueta"...).

Também: o aviso (toast) logo depois do Iniciar não tapa a máquina; nada fica
por cima do principal (barra presa, crachá); com o servidor fora, o nome da
tela não encavala no selo OFFLINE; e a 320 px continua cabendo.

E no monitor do Mini PC (1366 x 768) a tela tem de ficar igual: mede a
posição, o tamanho e a fonte de cada elemento com o bloco do coletor e sem
ele (folha `#pa-coletor` desligada e a div `.pa-acao` desfeita) e exige que
sejam idênticos. Isso prova que o bloco e a div não mexem no monitor; não
compara com versões antigas do arquivo (em 25/11 isso foi conferido uma vez,
fora deste teste, contra 7e5097a: idêntico em 5 estados).

O teclado da senha vem do acesso-colaborador.js (compartilhado por todas as
telas) e fica fora das medidas de fonte.

Não entra no rodar-todos.js (o Mini PC não tem navegador de teste).

    cd ~/bling-claude && timeout 300 venv/bin/python -I <repo>/testes/navegador/pa_tc60.py <repo> [porta]

Sai 1 se falhar."""
import json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

REPO = Path(sys.argv[1])
PORTA = int(sys.argv[2]) if len(sys.argv) > 2 else 14160
BASE = f"http://127.0.0.1:{PORTA}"
PIN = "5823"
UA_APP = "Mozilla/5.0 (Linux; Android 14; TC60) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 EkoColetor/2.0"
W, H = 360, 690
TOQUE, FONTE = 56, 16
falhas = []

def ok(cond, msg, det=""):
    print(("  ✓ " if cond else "  ✗ ") + msg + ("" if cond or not det else f"  [{det}]"))
    if not cond: falhas.append(msg)

def req(rota, corpo=None):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    r = urllib.request.Request(BASE + rota, data=dados, headers={"Content-Type": "application/json"} if dados else {})
    with urllib.request.urlopen(r, timeout=10) as x: return json.loads(x.read())

def senha(pg):
    """Espera o teclado da senha (a VPS pode estar lenta), digita e espera
    ele sumir. Sai False se a tela não liberou."""
    try: pg.wait_for_selector("#eko-acesso", state="visible", timeout=8000)
    except Exception: return not pg.locator("#eko-acesso").is_visible()
    for ch in PIN: pg.locator("#eko-kb button", has_text=ch).first.click()
    pg.locator("#eko-kb button.ok").click()
    try: pg.wait_for_selector("#eko-acesso", state="detached", timeout=8000)
    except Exception: return False
    pg.wait_for_timeout(800)
    return True

# Mede o que está NA FRENTE: a janela aberta, ou a tela sem as janelas.
MEDIR = """([toque, fonte, principais]) => {
  const vw = document.documentElement.clientWidth, vh = window.innerHeight;
  const janela = document.querySelector('.modal-overlay.on');
  const visivel = e => { const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
    const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  // A escolha de turno cobre a tela inteira (o celular.css deixa a tela de
  // lançamento montada por baixo): na frente ficam ela e o cabeçalho.
  const turno = document.querySelector('#overlay-turno.on');
  const daFrente = e => !e.closest('#eko-acesso') && !e.closest('#toast-area')
    && (janela ? janela.contains(e) : !e.closest('.modal-overlay'))
    && (janela || !turno || turno.contains(e) || !!e.closest('header'));
  const nome = e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.className && typeof e.className === 'string'
    ? '.' + e.className.trim().split(/\\s+/).join('.') : '')) + ' "' + (e.textContent || '').trim().slice(0, 18) + '"';
  const fora = [], pequenos = [], miudos = [], escondidos = [];
  for (const e of document.querySelectorAll('body *')) {
    if (e.id === '__ekoScan' || !visivel(e)) continue;
    const b = e.getBoundingClientRect();
    if (!e.closest('#eko-acesso') && (b.left < -1 || b.right > vw + 1)) fora.push(nome(e) + ' ' + Math.round(b.left) + '..' + Math.round(b.right));
    if (!daFrente(e)) continue;
    const tocavel = e.matches('button, input, select, a[href], [onclick], .maq-btn, .fmt-btn, .cor-btn');
    if (tocavel && !e.disabled && (b.height < toque - 0.5 || b.width < toque - 0.5))
      pequenos.push(nome(e) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
    if (tocavel && e.scrollWidth > e.clientWidth + 1) fora.push(nome(e) + ' texto cortado');
    const temTexto = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    const px = parseFloat(getComputedStyle(e).fontSize);
    if (temTexto && px < fonte - 0.01) miudos.push(nome(e) + ' ' + px + 'px');
  }
  for (const s of principais) {
    const e = document.querySelector(s);
    const b = e && e.getBoundingClientRect();
    if (!e || !visivel(e) || b.top < 0 || b.bottom > vh + 0.5 || b.left < 0 || b.right > vw + 0.5) {
      escondidos.push(s + (b ? ' ' + Math.round(b.top) + '..' + Math.round(b.bottom) : ' (não existe)')); continue; }
    // Visível não basta: nada pode estar por cima (barra presa, crachá, aviso).
    const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
    if (hit && !e.contains(hit) && !hit.contains(e)) escondidos.push(s + ' coberto por ' + nome(hit));
    for (const t of document.querySelectorAll('#toast-area .toast')) {
      const r = t.getBoundingClientRect();
      if (r.width && r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top)
        escondidos.push(s + ' coberto pelo aviso "' + t.textContent.slice(0, 24) + '"');
    }
  }
  return { sw: document.documentElement.scrollWidth, vw, fora, pequenos, miudos, escondidos };
}"""

def medir(pg, nome, principais=(), largura=W):
    pg.evaluate("window.scrollTo(0, 0); document.querySelectorAll('.modal').forEach(m => m.scrollTop = 0)")
    pg.wait_for_timeout(150)
    r = pg.evaluate(MEDIR, [TOQUE, FONTE, list(principais)])
    ok(r["sw"] <= largura and not r["fora"], f"{nome}: nada passa da borda de {largura} px", f"scrollWidth={r['sw']} " + "; ".join(r["fora"][:5]))
    ok(not r["pequenos"], f"{nome}: controles com {TOQUE} px ou mais", f"{len(r['pequenos'])}: " + "; ".join(r["pequenos"][:6]))
    ok(not r["miudos"], f"{nome}: texto com {FONTE} px ou mais", f"{len(r['miudos'])}: " + "; ".join(r["miudos"][:6]))
    if principais:
        ok(not r["escondidos"], f"{nome}: o principal aparece sem rolar ({', '.join(principais)})", "; ".join(r["escondidos"]))

# Posição/tamanho/fonte de cada elemento (fora os avisos que vêm e vão).
FOTO = """() => [...document.querySelectorAll('body *')].filter(e => !e.closest('#toast-area') && !e.classList.contains('pa-acao'))
  .map(e => { const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
    return [e.tagName, e.id, Math.round(b.x * 10), Math.round(b.y * 10), Math.round(b.width * 10), Math.round(b.height * 10),
            cs.fontSize, cs.display, cs.position].join('|'); })"""
SEM_COLETOR = """() => { const s = document.getElementById('pa-coletor'); if (s) s.sheet.disabled = true;
  for (const w of [...document.querySelectorAll('.pa-acao')]) w.replaceWith(...w.childNodes);
  return !!s; }"""

def igual_no_monitor(pg, nome):
    pg.wait_for_timeout(300)
    com = pg.evaluate(FOTO)
    tinha = pg.evaluate(SEM_COLETOR); pg.wait_for_timeout(150)
    sem = pg.evaluate(FOTO)
    dif = [f"{a}  ≠  {b}" for a, b in zip(com, sem) if a != b]
    ok(len(com) == len(sem) and not dif, f"1366 · {nome}: igual com e sem o bloco do coletor"
       + ("" if tinha else " (bloco ausente)"), f"{len(dif)} diferenças: " + "; ".join(dif[:3]))

def main():
    tmp = Path(tempfile.mkdtemp(prefix="eko_pa_tc60_"))
    env = {**os.environ, "EKO_PORT": str(PORTA), "EKO_PORT_CB": str(PORTA + 1), "EKO_PORT_HTTPS": str(PORTA + 2),
           "EKO_DB_FILE": str(tmp / "t.db"), "EKO_LOG_DIR": str(tmp / "logs"), "TZ": "America/Sao_Paulo",
           "EKO_PRINT_SIMULAR": "1", "EKO_FECHAR_TELA_SIMULAR": "1"}
    srv = subprocess.Popen(["node", str(REPO / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(75):
            try:
                if req("/healthcheck").get("ok"): break
            except Exception: pass
            time.sleep(0.2)
        # Nada deste banco de teste vai para a VPS de verdade.
        req("/config", {"vps_sacoleiras_url": "http://127.0.0.1:9/api/sacoleiras/agora"})
        req("/colaboradores/salvar", {"nome": "TESTE PA TC60", "pin": PIN, "telas": ["pa"]})
        erros = []
        with sync_playwright() as pw:
            br = _navegador(pw)

            print(f"\n[1] Coletor TC60 ({W} x {H}, app)")
            ctx = br.new_context(viewport={"width": W, "height": H}, device_scale_factor=2, user_agent=UA_APP,
                                 locale="pt-BR", has_touch=True, is_mobile=True)
            pg = ctx.new_page(); pg.set_default_timeout(6000); pg.set_default_navigation_timeout(30000)
            pg.on("pageerror", lambda e: erros.append(str(e)))
            pg.goto(BASE + "/produto-acabado.html"); ok(senha(pg), "senha aceita"); pg.wait_for_timeout(500)
            medir(pg, "turno e data", ["#turno-A .turno-iniciar", "#turno-C .turno-iniciar", "#turno-EXTRA .turno-iniciar", "#data-EXTRA"])
            pg.locator("#turno-A .turno-iniciar").click(); pg.wait_for_selector("#main.on", timeout=15000)
            # Logo depois do Iniciar o aviso "✓ TURNO A · …" está na tela: não pode tapar o passo 1,
            # e o toque atravessa o aviso (a 🏠 por baixo dele continua respondendo).
            try: pg.wait_for_selector("#toast-area .toast", timeout=5000); com_aviso = True
            except Exception: com_aviso = False
            ok(com_aviso, "aviso do Iniciar na tela durante a medida")
            medir(pg, "lançamento vazio", ["#maq-P1", "#maq-P2", "#fmt-30x40", "#btn-add", "#preview"])
            atravessa = pg.evaluate("""() => { const b = document.querySelector('header .btn-icon[title^="Voltar"]').getBoundingClientRect();
                const h = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2); return h && h.closest('button') ? h.closest('button').title : String(h && h.className); }""")
            ok(atravessa.startswith("Voltar"), "com o aviso na tela, o toque na 🏠 chega ao botão", atravessa)
            # Sem servidor: o selo OFFLINE aparece SEM mexer no resto. Com Wi-Fi oscilando o
            # selo vai e volta a cada 5 s; se o cabeçalho mudasse de altura, a máquina e os
            # formatos pulariam debaixo do dedo.
            geo = """() => { const h = document.querySelector('header').getBoundingClientRect(),
                m = document.getElementById('maq-P1').getBoundingClientRect(),
                s = document.getElementById('srv-status').getBoundingClientRect(),
                d = document.querySelector('header .header-right').getBoundingClientRect();
                return { cab: Math.round(h.height), maq: Math.round(m.top), selo: [Math.round(s.left), Math.round(s.right), Math.round(s.top), Math.round(s.bottom)],
                         seloNosBotoes: s.width > 0 && s.right > d.left + 0.5 && s.left < d.right }; }"""
            antes = pg.evaluate(geo)
            pg.route("**/healthcheck", lambda r: r.fulfill(status=500, body="{}"))
            pg.evaluate("pingServidor()"); pg.wait_for_selector("#srv-status.off", state="visible")
            fora = pg.evaluate(geo)
            ok(fora["cab"] == antes["cab"] and fora["maq"] == antes["maq"], "OFFLINE: cabeçalho e máquina não mudam de lugar",
               f"online {antes} · offline {fora}")
            ok(not fora["seloNosBotoes"] and fora["selo"][2] >= 0 and fora["selo"][3] <= antes["cab"] + 1,
               "OFFLINE: selo dentro do cabeçalho, sem cobrir ⇄ 🗺 🏠", json.dumps(fora))
            # O aviso passageiro (até 5 s) fica por cima do cabeçalho de propósito, para não
            # tapar a máquina; o selo OFFLINE é medido depois que ele some.
            try: pg.wait_for_function("!document.querySelector('#toast-area .toast')", timeout=10000)
            except Exception: pass
            medir(pg, "OFFLINE", ["#srv-status", "#maq-P1", "#btn-add"])
            pg.unroute("**/healthcheck"); pg.evaluate("pingServidor()"); pg.wait_for_selector("#srv-status.on", state="attached")
            pg.wait_for_timeout(300)
            pg.locator("#maq-P1").click(); pg.locator("#fmt-50x60").click(); pg.locator("#cor-BC").click()
            pg.locator("#quick-grid .quick-btn", has_text="50").first.click(); pg.wait_for_timeout(200)
            ok(pg.locator("#btn-add").is_enabled(), "escolha completa libera o Adicionar")
            medir(pg, "escolha feita", ["#btn-add", "#preview"])
            pg.locator("#btn-add").click()
            try: pg.wait_for_function("state.itens.length === 1", timeout=10000)
            except Exception: pass
            ok(pg.evaluate("state.itens.length") == 1, "Adicionar lança o item (fluxo igual)")
            # Cor nunca lançada nessa máquina+formato → aviso de cor.
            pg.locator("#maq-P1").click(); pg.locator("#fmt-50x60").click(); pg.locator("#cor-PT").click()
            pg.locator(".step-btn", has_text="+").first.click(); pg.locator("#btn-add").click(); pg.wait_for_timeout(1000)
            ok(pg.locator("#modal-cor-incomum.on").count() == 1, "aviso de cor incomum abre")
            medir(pg, "aviso de cor", ["#modal-cor-incomum .btn-modal.secundario", "#modal-cor-incomum .btn-modal.primary"])
            pg.locator("#modal-cor-incomum .btn-modal.primary").click(); pg.wait_for_timeout(1500)
            # Lista longa: 12 itens a mais, lançados pelo servidor, e a tela retoma.
            sid = pg.evaluate("state.sessaoId")
            for m, f, c, n in [("P1","60x80","AM",3),("P2","30x40","REC",12),("P2","42x53","BC",7),("P1","80x100","REC",200),
                               ("P2","33x46","PT",5),("P1","40x50","AM",9),("P2","35x45","BC",4),("P1","50x60","BC",11),
                               ("P2","30x45","AM",6),("P1","60x80","PT",8),("P2","40x50","REC",2),("P1","80x100","BC",1)]:
                req("/produto-acabado/item", {"sessao_id": sid, "corKey": c, "formato": f, "fardos": n, "maquina": m})
            pg.reload(); senha(pg)
            try: pg.wait_for_function("state.itens.length === 14", timeout=10000)
            except Exception: pass
            ok(pg.evaluate("state.itens.length") == 14, "lista longa: 14 itens retomados", pg.evaluate("state.itens.length"))
            medir(pg, "lista longa", ["#btn-add"])
            pg.locator("#btn-fim").click(); pg.wait_for_timeout(500)
            medir(pg, "confirmar envio (14 itens)", ["#modal-confirmar-envio .btn-modal.secundario", "#modal-confirmar-envio .btn-modal.primary"])
            pg.locator("#modal-confirmar-envio .btn-modal.primary").click()
            try: pg.wait_for_selector("#overlay-turno.on", timeout=15000)
            except Exception: pass
            ok(pg.locator("#overlay-turno.on").count() == 1 and not req("/sessoes/abertas?tipo=produto-acabado")["sessoes"],
               "Confirmar finaliza e volta ao turno (fluxo igual)")
            pg.locator("#turno-C .turno-iniciar").click(); pg.wait_for_timeout(1000)
            pg.evaluate("abrirGaiola()"); pg.wait_for_timeout(600)
            pg.locator("#g-fmt-50x60").click(); pg.locator("#g-cor-grid .cor-btn").first.click()
            pg.locator("#g-quick-grid .quick-btn").first.click(); pg.locator("#g-tipo-grid .quick-btn").first.click()
            pg.locator("#g-btn-imprimir").click(); pg.wait_for_timeout(1800)
            ok(pg.locator("#g-hoje .g-item").count() == 1, "gaiola impressa aparece em 'Gaiolas de hoje'")
            medir(pg, "etiqueta de gaiola", ["#modal-gaiola .btn-modal.secundario", "#g-btn-imprimir"])
            ok(not erros, "sem erro de JavaScript", "; ".join(erros)[:300])
            ctx.close()

            print("\n[1b] Celular pequeno (320 x 640): continua cabendo")
            ctx = br.new_context(viewport={"width": 320, "height": 640}, device_scale_factor=2, user_agent=UA_APP,
                                 locale="pt-BR", has_touch=True, is_mobile=True)
            pg = ctx.new_page(); pg.set_default_timeout(6000); pg.set_default_navigation_timeout(30000)
            # "SERVIDOR…" (antes do 1º ping responder) é o selo mais largo: segura o ping.
            presos = []
            pg.route("**/healthcheck", lambda r: presos.append(r))
            pg.goto(BASE + "/produto-acabado.html"); ok(senha(pg), "320: senha aceita"); pg.wait_for_timeout(800)
            if pg.locator("#overlay-turno.on").count() == 0: pg.evaluate("trocarTurno()")
            ok("SERVIDOR" in pg.locator("#srv-status").inner_text(), "320: selo SERVIDOR… na tela", pg.locator("#srv-status").inner_text())
            medir(pg, "320 · turno e data com SERVIDOR…", ["#srv-status", "#overlay-turno h2", "#turno-A .turno-iniciar"], largura=320)
            pg.unroute("**/healthcheck")
            for r in presos:     # solta os pings presos (os que a página já largou dão erro: ignora)
                try: r.fulfill(status=200, content_type="application/json", body='{"ok":true}')
                except Exception: pass
            pg.locator("#turno-A .turno-iniciar").click(); pg.wait_for_selector("#main.on")
            pg.locator("#maq-P1").click(); pg.locator("#fmt-80x100").click(); pg.locator("#cor-REC").click()
            medir(pg, "320 · lançamento", ["#maq-P1", "#btn-add"], largura=320)
            ctx.close()

            print("\n[2] Monitor do Mini PC (1366 x 768): nada muda")
            ctx = br.new_context(viewport={"width": 1366, "height": 768}, locale="pt-BR")
            # No Mini PC a tela roda dentro do menu; aqui sem a trava que a reabre por lá.
            ctx.route("**/seguranca-saida.js", lambda r: r.fulfill(status=200, content_type="text/javascript", body=""))
            pg = ctx.new_page(); pg.set_default_timeout(6000); pg.set_default_navigation_timeout(30000)
            erros_monitor = []
            pg.on("pageerror", lambda e: erros_monitor.append(str(e)))
            def abrir():
                pg.goto(BASE + "/produto-acabado.html"); ok(senha(pg), "1366: senha aceita"); pg.wait_for_timeout(1500)
            abrir(); igual_no_monitor(pg, "turno e data")
            abrir(); pg.locator("#turno-A .turno-iniciar").click(); pg.wait_for_timeout(1000)
            for cor in ("BC", "AM"):
                pg.locator("#maq-P2").click(); pg.locator("#fmt-30x40").click(); pg.locator("#cor-" + cor).click()
                pg.locator("#quick-grid .quick-btn").first.click(); pg.locator("#btn-add").click(); pg.wait_for_timeout(900)
                if pg.locator("#modal-cor-incomum.on").count(): pg.locator("#modal-cor-incomum .btn-modal.primary").click(); pg.wait_for_timeout(900)
            pg.locator("#maq-P1").click(); pg.locator("#fmt-60x80").click(); pg.locator("#cor-PT").click()
            igual_no_monitor(pg, "lançamento com lista")
            abrir(); pg.locator("#btn-fim").click(); pg.wait_for_timeout(400); igual_no_monitor(pg, "confirmar envio")
            abrir(); pg.evaluate("abrirGaiola()"); pg.wait_for_timeout(800)
            pg.locator("#g-fmt-40x50").click(); pg.locator("#g-cor-grid .cor-btn").nth(2).click()
            igual_no_monitor(pg, "etiqueta de gaiola")
            ok(not erros_monitor, "1366: sem erro de JavaScript", "; ".join(erros_monitor)[:300])
            ctx.close()
            br.close()
    finally:
        srv.kill(); srv.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'FALHOU: ' + str(len(falhas)) if falhas else 'OK'}")
    sys.exit(1 if falhas else 0)

main()
