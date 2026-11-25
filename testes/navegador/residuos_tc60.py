"""Outras Pesagens / Resíduos (outras-pesagens.html) no coletor TC60 do Bruno (25/11/2026).

Gustavo pediu Resíduos no hub do app "Ekoplastic MP" para o Bruno
(almoxarifado) pesar pelo CMX Supply TC60: 720×1440 px com dpr 2, ~360×690
CSS (~648 com as barras do Android), uma mão, luva às vezes. O peso vem da
balança do Mini PC e a etiqueta sai na impressora de lá, como na Entrada.

Sobe o server.js de verdade (banco temporário, impressão simulada, balança
simulada pela rota /balanca/peso) e confere, a 360×690 com o UA do app:

  1. Em cada estado (senha, início, apara escolhida, peso chegando e instável, etiqueta
     impressa, janela "bipe antes", lista com 12 pesagens, refugo com erro,
     bobina sem etiqueta, resumo do dia, finalizado):
     · nada passa da largura (sem rolagem para o lado);
     · todo botão/campo/opção visível tem pelo menos 56×56 px;
     · todo texto visível tem pelo menos 16 px (fora a prévia da etiqueta,
       que é o desenho dela).
  2. O principal sem rolar, a 690 e a 648 px de altura, com a página no
     topo: o item que está pesando, o peso (≥ 28 px), o IMPRIMIR e, depois de
     imprimir, a última etiqueta, inteiros na tela e sem nada por cima.
  3. Só no app (user-agent EkoColetor): o leitor entrega pelo onLeu e bipa a
     etiqueta O… da lista, com as travas do leitor-teclado (campo em foco,
     janela aberta); o aviso do app, toast('aviso', msg), sai com o texto; a
     senha tem chave própria (residuos), acaba no FINALIZAR e é pedida de novo
     ao reabrir sem pesagem aberta. No Mini PC: chave 'mp' como antes, nada
     de senha ao finalizar e o leitor USB (teclado) bipando.
  3b. Bobina alta densidade (com e sem as fontes do Google): a sacola fica
     embaixo do botão, nada passa de 360 px, a barra diz "AD VERDE 1,52"
     inteiro e o LÍQUIDO (balança − tubete, o que a etiqueta leva); peso fora
     de 20–1.500 kg: o IMPRIMIR diz o motivo; imprime e bipa pelo onLeu.
  4. Monitor do Mini PC (1366×768, dentro do quadro do menu, como no
     quiosque): a página é aberta de novo SEM o bloco de
     estilo do coletor e sem as linhas novas, e a posição, o tamanho e o
     estilo de cada elemento têm de ser iguais (início, peso, lista).

Não entra no rodar-todos.js (o Mini PC não tem navegador de teste). Portas
14170/14171/14172.

    cd ~/bling-claude && timeout 500 venv/bin/python -I <repo pesagem>/testes/navegador/residuos_tc60.py <repo pesagem> [pasta-prints] [prefixo]

Sai 1 se falhar."""
import json, os, re, shutil, subprocess, sys, tempfile, time, urllib.parse, urllib.request
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

REPO = Path(sys.argv[1])
PRINTS = Path(sys.argv[2]) if len(sys.argv) > 2 else None
PREFIXO = sys.argv[3] if len(sys.argv) > 3 else ""
if PRINTS: PRINTS.mkdir(parents=True, exist_ok=True)
PIN = "5823"
UA_APP = "Mozilla/5.0 (Linux; Android 14; TC60) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 EkoColetor/2.0"
PORTA = 14170
BASE = f"http://127.0.0.1:{PORTA}"
URL = "/outras-pesagens.html"
W, H, H_BAIXA = 360, 690, 648
TOQUE, FONTE = 56, 16
falhas = []


def ok(cond, msg, det=""):
    print(("  ✓ " if cond else "  ✗ ") + msg + ("" if cond or not det else f"  [{det}]"))
    if not cond: falhas.append(msg)


def req(rota, corpo=None):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    r = urllib.request.Request(BASE + rota, data=dados, headers={"Content-Type": "application/json"} if dados else {})
    with urllib.request.urlopen(r, timeout=15) as x: return json.loads(x.read())


# wait_for_function com polling por tempo: no quadro do menu (iframe) o
# requestAnimationFrame do Playwright não roda e a espera nunca termina.
# A senha fica lembrada por um tempo na aba: no reload ela pode não voltar.
def senha(pg):
    pg.wait_for_function("() => document.getElementById('eko-acesso') || /ONLINE/.test((document.getElementById('srv-status') || {}).textContent)", timeout=15000, polling=200)
    if pg.locator("#eko-acesso").count():
        for ch in PIN: pg.locator("#eko-kb button", has_text=ch).first.click()
        pg.locator("#eko-kb button.ok").click()
        pg.wait_for_selector("#eko-acesso", state="detached", timeout=15000)
    pg.wait_for_function("() => /ONLINE/.test(document.getElementById('srv-status').textContent)", timeout=15000, polling=200)


# Toque de verdade (o Playwright recusa o que está fora da tela e não rola).
# Se não der, registra a falha e aperta pelo JS para seguir com as fotos.
def tocar(pg, sel, nome):
    try:
        pg.locator(sel).first.click(timeout=4000)
    except Exception as e:
        ok(False, f"{nome}: dá para tocar em {sel}", str(e).splitlines()[0][:120])
        pg.evaluate("(s) => document.querySelector(s).click()", sel)


# Mede a tela como está. Elemento invisível (display/visibility/opacity) não
# conta. A prévia da etiqueta (#preview-etiqueta) fica fora da regra de fonte:
# é o desenho da etiqueta. Com com_acesso, mede só o teclado da senha.
MEDIR = """([TOQUE, FONTE, comAcesso]) => {
  const w = document.documentElement.clientWidth;
  const vis = e => { for (let x = e; x && x !== document.body; x = x.parentElement) {
      const cs = getComputedStyle(x); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false; }
    const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const nome = e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].join('.') : ''));
  const fora = [], peq = [], fonte = [];
  for (const e of document.querySelectorAll('body *')) {
    if (e.id === '__ekoScan' || !vis(e)) continue;
    if (!!e.closest('#eko-acesso') !== comAcesso) continue;
    const b = e.getBoundingClientRect();
    if (b.right > w + 1 || b.left < -1) fora.push(nome(e) + ' ' + Math.round(b.left) + '..' + Math.round(b.right));
    if (e.matches('button, select, a, .touch-btn, .cor-btn, input:not([type=hidden]):not([type=checkbox]):not([type=radio])')
        && (b.height < TOQUE - 0.5 || b.width < TOQUE - 0.5))
      peq.push(nome(e) + ' ' + Math.round(b.width) + 'x' + Math.round(b.height));
    if (!e.closest('#preview-etiqueta')) for (const n of e.childNodes)
      if (n.nodeType === 3 && n.textContent.trim()) { const fs = parseFloat(getComputedStyle(e).fontSize);
        if (fs < FONTE - 0.01) fonte.push(nome(e) + ' ' + fs + ' "' + n.textContent.trim().slice(0, 20) + '"'); break; }
  }
  // Linha da lista: um pedaço não pode ficar por cima do outro (nº × peso).
  const sobre = [];
  for (const it of document.querySelectorAll('.hist-item')) {
    if (!vis(it)) continue;
    const fs = [...it.children].filter(vis).map(c => [c, c.getBoundingClientRect()]);
    for (let i = 0; i < fs.length; i++) for (let j = i + 1; j < fs.length; j++) {
      const [a, ra] = fs[i], [b, rb] = fs[j];
      const x = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left), y = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (x > 1 && y > 1) sobre.push(nome(a) + '×' + nome(b) + ' "' + it.textContent.trim().replace(/\\s+/g, ' ').slice(0, 24) + '"');
    }
    for (const c of it.querySelectorAll('*')) if (vis(c) && c.clientWidth && c.scrollWidth > c.clientWidth + 1 && getComputedStyle(c).textOverflow !== 'ellipsis')
      sobre.push(nome(c) + ' cortado ' + c.scrollWidth + '>' + c.clientWidth);
  }
  return { sw: document.documentElement.scrollWidth, w, fora: fora.slice(0, 10), nFora: fora.length, sobre: sobre.slice(0, 6), nSobre: sobre.length,
           peq: [...new Set(peq)].slice(0, 14), nPeq: peq.length, fonte: [...new Set(fonte)].slice(0, 14), nFonte: fonte.length };
}"""


def conferir(pg, nome, com_acesso=False):
    pg.wait_for_timeout(250)
    if PRINTS: pg.screenshot(path=str(PRINTS / f"{PREFIXO}{nome}.png"), full_page=True, timeout=40000)
    # Janela aberta: a foto da página inteira não mostra o que cabe na tela.
    # Esta mostra a janela do topo, como o Bruno a vê ao abrir.
    if PRINTS and pg.evaluate("(() => { const o = document.querySelector('.modal-overlay.on'); if (o) o.scrollTop = 0; return !!o; })()"):
        pg.screenshot(path=str(PRINTS / f"{PREFIXO}{nome}-tela.png"))
    m = pg.evaluate(MEDIR, [TOQUE, FONTE, com_acesso])
    ok(m["sw"] <= W and m["nFora"] == 0, f"{nome}: nada passa da largura de {W} px", f"sw={m['sw']} {m['fora']}")
    ok(m["nPeq"] == 0, f"{nome}: botões e campos com pelo menos {TOQUE} px", f"{m['nPeq']}: {m['peq']}")
    ok(m["nFonte"] == 0, f"{nome}: texto com pelo menos {FONTE} px", f"{m['nFonte']}: {m['fonte']}")
    ok(m["nSobre"] == 0, f"{nome}: nas linhas da lista nada fica por cima nem cortado", f"{m['nSobre']}: {m['sobre']}")


# O principal com a página no topo: inteiro dentro da janela, sem nada por
# cima (elementFromPoint) e sem texto cortado por overflow.
PRINCIPAL = """(sels) => { const out = {};
  const pe = document.createElement('style'); pe.textContent = '* { pointer-events: auto !important; }';
  document.head.appendChild(pe);
  for (const s of sels) {
    const e = document.querySelector(s);
    if (!e) { out[s] = { erro: 'não existe' }; continue; }
    const cs = getComputedStyle(e); const b = e.getBoundingClientRect();
    const r = { top: Math.round(b.top), bottom: Math.round(b.bottom), left: Math.round(b.left), right: Math.round(b.right),
                fs: parseFloat(cs.fontSize), txt: e.textContent.trim().replace(/\\s+/g, ' ').slice(0, 60) };
    r.dentro = cs.display !== 'none' && cs.visibility !== 'hidden' && b.height > 0 && b.top >= 0 && b.bottom <= innerHeight + 0.5 && b.left >= 0 && b.right <= innerWidth + 0.5;
    if (r.dentro) {
      const topo = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      if (!topo || !(e === topo || e.contains(topo))) r.coberto = topo ? (topo.id || topo.tagName + '.' + topo.className) : 'nada';
      for (const x of [e, ...e.querySelectorAll('*')])
        if (x.clientWidth && x.scrollWidth > x.clientWidth + 1) r.cortado = (x.id || x.className || x.tagName) + ' ' + x.scrollWidth + '>' + x.clientWidth;
    }
    out[s] = r;
  }
  pe.remove();
  return out; }"""


def principal(pg, nome, item, kg, ultima=None):
    for h in (H, H_BAIXA):
        pg.set_viewport_size({"width": W, "height": h})
        pg.evaluate("window.scrollTo(0, 0)"); pg.wait_for_timeout(250)
        if PRINTS and h == H_BAIXA: pg.screenshot(path=str(PRINTS / f"{PREFIXO}{nome}-648.png"))
        sels = ["#peso-item", "#peso-val", "#btn-imprimir"] + (["#ultima-etq"] if ultima else [])
        r = pg.evaluate(PRINCIPAL, sels)
        bom = lambda x: x.get("dentro") and not x.get("coberto") and not x.get("cortado")
        pi, pv, pb = r["#peso-item"], r["#peso-val"], r["#btn-imprimir"]
        ok(bom(pi) and item.upper() in pi.get("txt", "").upper(), f"{nome} @{h}: o que está pesando ({item}) à vista sem rolar", pi)
        ok(bom(pv) and pv.get("fs", 0) >= 28 and kg in pv.get("txt", ""), f"{nome} @{h}: peso {kg} à vista, ≥ 28 px", pv)
        ok(bom(pb), f"{nome} @{h}: IMPRIMIR à vista sem rolar", pb)
        if ultima:
            pu = r["#ultima-etq"]
            ok(bom(pu) and all(t in pu.get("txt", "") for t in ultima), f"{nome} @{h}: última etiqueta {ultima} à vista sem rolar", pu)
    pg.set_viewport_size({"width": W, "height": H})


# Geometria + estilo de cada elemento visível, para comparar o monitor com e
# sem o estilo do coletor. Relógio, status e crachá mudam sozinhos ou ficam
# por cima: entra a caixa, não o texto. As linhas novas do coletor saem.
FOTO_LAYOUT = """() => { const out = [];
  for (const e of document.querySelectorAll('body *')) {
    if (['eko-resp-tag', 'ultima-etq', 'peso-item', 'peso-liq'].includes(e.id) || e.closest('#toast-area')) continue;
    if (e.ownerSVGElement) continue;   // barras do código: o número muda de uma rodada para a outra
    const cs = getComputedStyle(e); const b = e.getBoundingClientRect();
    out.push([e.tagName, e.id, e.className && e.className.baseVal === undefined ? e.className : '',
      Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height),
      cs.display, cs.position, cs.fontSize, cs.color, cs.backgroundColor, cs.borderTopColor, cs.padding]);
  }
  return out; }"""


def main():
    tmp = Path(tempfile.mkdtemp(prefix="eko_residuos_tc60_"))
    env = {**os.environ, "EKO_PORT": str(PORTA), "EKO_PORT_CB": str(PORTA + 1), "EKO_PORT_HTTPS": str(PORTA + 2),
           "EKO_DB_FILE": str(tmp / "t.db"), "EKO_LOG_DIR": str(tmp / "logs"), "TZ": "America/Sao_Paulo",
           "EKO_PRINT_SIMULAR": "1", "EKO_FECHAR_TELA_SIMULAR": "1"}
    srv = subprocess.Popen(["node", str(REPO / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(300):
            try:
                if req("/healthcheck").get("ok"): break
            except Exception: pass
            time.sleep(0.2)
        # Nada deste banco de teste vai para a VPS de verdade.
        req("/config", {"vps_sacoleiras_url": "http://127.0.0.1:9/api/sacoleiras/agora"})
        req("/colaboradores/salvar", {"nome": "TESTE TC60", "pin": PIN, "telas": ["mp"]})
        bal = {"peso": 0.0}
        erros = []
        with sync_playwright() as pw:
            br = _navegador(pw)

            def contexto(w, h, ua=UA_APP, sem_coletor=False):
                ctx = br.new_context(viewport={"width": w, "height": h}, user_agent=ua, device_scale_factor=1)
                pg = ctx.new_page(); pg.set_default_timeout(10000)
                pg.on("pageerror", lambda e: erros.append(str(e)))
                pg.route("**/balanca/peso", lambda rota: rota.fulfill(status=200, content_type="application/json",
                         body=json.dumps({"ok": True, "portaAberta": True, "peso": bal["peso"], "estavel": bal.get("estavel", True)})))
                if sem_coletor:
                    def tirar(rota):
                        r = rota.fetch(); html = r.text()
                        html = re.sub(r'<style id="estilo-coletor">.*?</style>', '', html, flags=re.S)
                        html = re.sub(r'<div class="ultima-etq"[^>]*></div>', '', html)
                        html = re.sub(r'<span class="peso-item"[^>]*></span>', '', html)
                        html = re.sub(r'<span class="peso-liq"[^>]*></span>', '', html)
                        rota.fulfill(response=r, body=html)
                    pg.route("**/outras-pesagens.html*", tirar)
                return ctx, pg

            def abrir(pg, conferir_senha=False):
                pg.goto(BASE + URL, wait_until="domcontentloaded", timeout=30000)
                if conferir_senha:
                    pg.wait_for_selector("#eko-acesso", state="visible", timeout=15000)
                    conferir(pg, "senha", com_acesso=True)
                senha(pg)

            def pesar(pg, kg):
                bal["peso"] = kg
                pg.wait_for_function(f"() => document.getElementById('peso-val').textContent === {json.dumps(f'{kg:.1f}')}", timeout=10000, polling=200)
                pg.wait_for_function("() => /Estável/.test(document.getElementById('balanca-status').textContent)", timeout=10000, polling=200)

            # ── 1/2. Coletor 360×690 ─────────────────────────────────
            print(f"\n[1] Coletor {W}×{H} (UA do app)")
            ctx, pg = contexto(W, H)
            abrir(pg, conferir_senha=True)
            print("\n[1b] Senha e aviso do app")
            ch = pg.evaluate("[sessionStorage.getItem('eko_liberado_residuos'), sessionStorage.getItem('eko_liberado_mp')]")
            ok(ch[0] and not ch[1], "no app a senha fica na chave própria da tela (residuos), não na 'mp' de 8 h", ch)
            pg.evaluate("toast('aviso', 'Esta tela não recebe leitura: XYZ', 4500)")
            t = pg.evaluate("(() => { const t = [...document.querySelectorAll('#toast-area .toast')].pop(); return t ? [t.textContent, t.className] : null; })()")
            ok(t and t[0] == "Esta tela não recebe leitura: XYZ" and "warn" in t[1], "aviso do app sai com o texto dele, não a palavra 'aviso'", t)
            conferir(pg, "inicio")
            pg.locator("#it-APARA\\.AMARELA").click()
            conferir(pg, "apara-escolhida")
            pesar(pg, 812.4)
            pg.wait_for_function("() => !document.getElementById('btn-imprimir').disabled", timeout=10000, polling=200)
            conferir(pg, "peso-chegando")
            print(f"\n[2] O principal sem rolar (página no topo, {H} e {H_BAIXA} px)")
            principal(pg, "peso-chegando", "Apara Amarela", "812.4")
            bal["estavel"] = False
            pg.wait_for_function("() => /ESTABILIDADE/.test(document.getElementById('btn-imprimir').textContent)", timeout=10000, polling=200)
            pg.evaluate("window.scrollTo(0, 0)")
            r = pg.evaluate(PRINCIPAL, ["#btn-imprimir"])["#btn-imprimir"]
            ok(r.get("dentro") and not r.get("coberto") and not r.get("cortado"), "peso instável: o texto do botão cabe nele", r)
            conferir(pg, "peso-instavel")
            bal["estavel"] = True
            pg.wait_for_function("() => !document.getElementById('btn-imprimir').disabled", timeout=10000, polling=200)
            pg.locator("#btn-imprimir").click()
            pg.wait_for_function("() => document.querySelectorAll('#hist-lista .hist-item').length === 1", timeout=15000, polling=200)
            bal["peso"] = 0.0
            pg.wait_for_function("() => document.getElementById('balanca-status').textContent === 'Aguardando material'", timeout=10000, polling=200)
            sess = req("/sessoes/abertas?tipo=outras")["sessoes"]
            etq = sess[0]["etiquetas"][0]["id"] if sess and sess[0]["etiquetas"] else "?"
            conferir(pg, "etiqueta-impressa")
            pg.locator("#it-RES\\.BORRA").click()
            pg.wait_for_selector("#modal-bipagem-pendente.on", timeout=5000)
            conferir(pg, "janela-bipe-antes")
            tocar(pg, "#modal-bipagem-pendente .btn-modal", "janela bipe antes")
            pesar(pg, 23.6)
            principal(pg, "etiqueta-impressa", "Apara Amarela", "23.6", ultima=["BIPAR", etq])

            print("\n[3] Leitor do app (onLeu)")
            tem = pg.evaluate("typeof onLeu === 'function'")
            ok(tem, "a tela tem onLeu (o app entrega o código por ela)")
            if tem:
                pg.evaluate("document.getElementById('peso-manual').focus()")
                pg.evaluate(f"onLeu({json.dumps(etq)})"); pg.wait_for_timeout(1200)
                ok(pg.locator("#hist-lista .hist-item.pendente").count() == 1, "com o campo de peso em foco: não bipa (igual ao leitor-teclado)")
                pg.evaluate("document.activeElement.blur()")
                pg.evaluate(f"onLeu({json.dumps(' ' + etq + ' ')})")
                pg.wait_for_selector("#hist-lista .hist-item.bipada", timeout=8000)
                ok(True, f"bipe de {etq} pelo onLeu chega ao biparItem")
                st = [e["status"] for e in req("/sessoes/abertas?tipo=outras")["sessoes"][0]["etiquetas"]]
                ok(st == ["bipada"], "servidor gravou a etiqueta como bipada", st)
                pu = pg.evaluate("(document.getElementById('ultima-etq')||{}).textContent || ''")
                ok(pu.startswith("✓") and etq in pu and "bipada" in pu, "depois do bipe a última etiqueta diz bipada", pu)
                pg.locator("#btn-recuperada").click(); pg.wait_for_selector("#modal-recuperada.on")
                n0 = pg.locator("#hist-lista .hist-item.bipada").count()
                pg.evaluate("onLeu('O0009999')"); pg.wait_for_timeout(800)
                ok(pg.locator("#modal-recuperada.on").count() == 1 and not pg.locator(".toast.error").count(),
                   "janela aberta (bobina sem etiqueta): bipe da lista não faz nada")
                tocar(pg, "#modal-recuperada .btn-modal.secundario", "bobina sem etiqueta: Fechar")

            # 12 pesagens na mesma sessão (11 pela API) e a tela retomando
            sid = sess[0]["id"]
            for i in range(11):
                cod = ["RES.BORRA", "RES.VARREDURA", "RES.PO", "APARA.VERDE", "APARA.PRETA", "APARA.BRANCA"][i % 6]
                req("/etiquetas/outras", {"clientToken": f"tc60-{i}-{time.time_ns()}", "sessao_id": sid, "item_codigo": cod,
                    "peso": round(12 + i * 7.3, 1), "peso_bruto": round(12 + i * 7.3, 1), "tara": 0})
            bal["peso"] = 0.0
            pg.reload(wait_until="domcontentloaded", timeout=30000)
            pg.wait_for_function("() => document.getElementById('eko-acesso') || /ONLINE/.test((document.getElementById('srv-status') || {}).textContent)", timeout=15000, polling=200)
            ok(pg.locator("#eko-acesso").count() == 0, "app: reabrir com a pesagem aberta no nome da pessoa NÃO pede a senha")
            senha(pg)
            pg.wait_for_function("() => document.querySelectorAll('#hist-lista .hist-item').length === 12", timeout=15000, polling=200)
            ok(True, "lista com 12 pesagens")
            conferir(pg, "lista-12")
            # com a sessão aberta (faixa FINALIZAR em cima) o principal continua à vista
            ultimo = req("/sessoes/abertas?tipo=outras")["sessoes"][0]["etiquetas"]
            ult_id = sorted(ultimo, key=lambda e: e.get("seq_sessao") or 0)[-1]["id"]
            npend = pg.locator("#hist-lista .hist-item.pendente").count()
            pg.locator("#hist-lista .hist-acao").first.click()
            pg.wait_for_function(f"() => document.querySelectorAll('#hist-lista .hist-item.pendente').length === {npend - 1}", timeout=10000, polling=200)
            for e in [x["id"] for x in ultimo if x["status"] == "aguardando_bipe" and x["id"] != ult_id]:
                req(f"/etiquetas/{e}/bipar", {})
            pg.reload(wait_until="domcontentloaded", timeout=30000); senha(pg)
            pg.wait_for_function("() => document.querySelectorAll('#hist-lista .hist-item.bipada').length === 12", timeout=15000, polling=200)
            pg.locator("#it-RES\\.VARREDURA").click()
            pesar(pg, 64.2)
            principal(pg, "sessao-aberta", "Varredura", "64.2", ultima=["✓", ult_id])

            # Refugo: janela, etiqueta inválida e não achada
            pg.locator("#btn-refugo").click(); pg.wait_for_selector("#modal-refugo.on")
            conferir(pg, "refugo")
            pg.fill("#refugo-etiqueta", "X12"); tocar(pg, "#modal-refugo .btn-peso-ok", "refugo: OK")
            pg.wait_for_function("() => /inválida/.test(document.getElementById('refugo-bobina').textContent)", polling=200)
            conferir(pg, "refugo-invalida")
            # No app o Enter do leitor não chega à página: o bipe vem pelo onLeu,
            # com o campo da etiqueta em foco (abrirRefugo põe o foco nele).
            pg.evaluate("document.getElementById('refugo-etiqueta').focus(); typeof onLeu === 'function' && onLeu('E0009999')")
            try:
                pg.wait_for_function("() => /E0009999/.test(document.getElementById('refugo-bobina').textContent) && !/inválida/.test(document.getElementById('refugo-bobina').textContent)", timeout=8000, polling=200)
                leu = True
            except Exception:
                leu = False
            ok(leu, "refugo: bipe pelo leitor do app (onLeu) consulta a etiqueta", pg.evaluate("document.getElementById('refugo-bobina').textContent"))
            if not leu:
                pg.fill("#refugo-etiqueta", "E0009999"); tocar(pg, "#modal-refugo .btn-peso-ok", "refugo: OK")
                pg.wait_for_function("() => /E0009999/.test(document.getElementById('refugo-bobina').textContent)", polling=200)
            conferir(pg, "refugo-nao-achada")
            tocar(pg, "#modal-refugo .btn-modal.secundario", "refugo: Fechar")

            # Bobina sem etiqueta, com peso na balança e a senha pela metade
            bal["peso"] = 0.0
            pg.wait_for_function("() => document.getElementById('peso-val').textContent === '0.0'", polling=200)
            bal["peso"] = 350.0
            pg.wait_for_function("() => document.getElementById('peso-val').textContent === '350.0'", polling=200)
            pg.locator("#btn-recuperada").click(); pg.wait_for_selector("#modal-recuperada.on")
            pg.locator("#rec-teclado .touch-btn", has_text="5").click(); pg.locator("#rec-teclado .touch-btn", has_text="8").click()
            conferir(pg, "bobina-sem-etiqueta")
            tocar(pg, "#modal-recuperada .btn-modal.secundario", "bobina sem etiqueta: Fechar")

            # Resumo do dia
            pg.locator(".btn-dia").click(); pg.wait_for_selector("#rd-box", state="visible", timeout=10000)
            pg.wait_for_function("() => !/Carregando/i.test(document.getElementById('rd-box').textContent)", timeout=15000, polling=200)
            conferir(pg, "resumo-do-dia")
            tocar(pg, "#rd-fechar", "resumo: FECHAR")

            # FINALIZAR
            bal["peso"] = 0.0
            pg.locator(".btn-finalizar").click()
            pg.wait_for_function("() => !document.getElementById('banner-turno').classList.contains('on')", timeout=15000, polling=200)
            try:
                pg.wait_for_selector("#eko-acesso", state="visible", timeout=10000); pediu = True
            except Exception:
                pediu = False
            ok(pediu, "app: depois do FINALIZAR a senha é pedida de novo (coletor compartilhado)")
            if pediu:
                pg.wait_for_selector("#toast-area .toast", timeout=5000)
                vis = pg.evaluate("""() => { const pe = document.createElement('style'); pe.textContent = '* { pointer-events: auto !important; }';
                    document.head.appendChild(pe);
                    const ts = [...document.querySelectorAll('#toast-area .toast')];
                    const r = ts.map(t => { const b = t.getBoundingClientRect(); const e = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
                        return [t.textContent, !!e && (e === t || t.contains(e))]; });
                    pe.remove(); return r; }""")
                ok(vis and all(v for _, v in vis), "app: os avisos do FINALIZAR ficam à vista por cima do teclado da senha", vis)
            if PRINTS: pg.screenshot(path=str(PRINTS / f"{PREFIXO}senha-depois-de-finalizar.png"))
            senha(pg)
            conferir(pg, "finalizado")
            # sem pesagem aberta, quem reabre a tela digita a senha (não herda a de antes)
            pg.reload(wait_until="domcontentloaded", timeout=30000)
            pg.wait_for_function("() => document.getElementById('eko-acesso') || /ONLINE/.test((document.getElementById('srv-status') || {}).textContent)", timeout=15000, polling=200)
            ok(pg.locator("#eko-acesso").count() == 1, "app: reabrir sem pesagem aberta pede a senha")
            senha(pg)
            # A senha confere a MESMA pesagem que a tela retoma (a mais nova):
            # com uma pesagem antiga do Teste e uma mais nova de OUTRO, reabrir
            # pede a senha (antes "valia" pela antiga e entrava na de OUTRO).
            def sessao_com_item(op, i):
                sid_ = req("/sessoes", {"tipo": "outras", "operador": op})["sessao_id"]
                req("/etiquetas/outras", {"clientToken": f"dono-{op}-{i}-{time.time_ns()}", "sessao_id": sid_, "item_codigo": "RES.BORRA",
                    "peso": 10.0 + i, "peso_bruto": 10.0 + i, "tara": 0})
                return sid_
            s_meu = sessao_com_item("TESTE TC60", 1)
            pg.reload(wait_until="domcontentloaded", timeout=30000)
            pg.wait_for_function("() => document.getElementById('eko-acesso') || /ONLINE/.test((document.getElementById('srv-status') || {}).textContent)", timeout=15000, polling=200)
            ok(pg.locator("#eko-acesso").count() == 0, "app: com a pesagem dele aberta, reabrir não pede a senha")
            s_outro = None
            for i in range(20):   # o servidor ordena por início: espera a de OUTRO ser a mais nova
                if s_outro is None: s_outro = sessao_com_item("OUTRO", 2)
                if req("/sessoes/abertas?tipo=outras")["sessoes"][0]["id"] == s_outro: break
                req(f"/sessoes/{s_outro}/cancelar", {}); s_outro = None; pg.wait_for_timeout(300)
            pg.reload(wait_until="domcontentloaded", timeout=30000)
            pg.wait_for_function("() => document.getElementById('eko-acesso') || /ONLINE/.test((document.getElementById('srv-status') || {}).textContent)", timeout=15000, polling=200)
            ok(pg.locator("#eko-acesso").count() == 1, "app: pesagem mais nova é de OUTRO: reabrir pede a senha (não entra calado na dele)")
            for x in (s_meu, s_outro):
                if x: req(f"/sessoes/{x}/cancelar", {})
            ctx.close()

            # ── 3b. Bobina alta densidade (main 905b268) ─────────────────
            # Com as fontes do Google abortadas (coletor sem internet: cai na
            # fonte do sistema, mais larga) e com elas.
            AD = '[id="it-BOB.VER.1,52"]'
            for sem_fontes in (True, False):
                rot = "sem fontes do Google" if sem_fontes else "com as fontes"
                suf = "-sem-fontes" if sem_fontes else ""
                print(f"\n[3b] Bobina AD escolhida e pesada ({rot})")
                ctx, pg = contexto(W, H)
                if sem_fontes:
                    pg.route(re.compile(r"https://fonts\.g(oogleapis|static)\.com/"), lambda rota: rota.abort())
                pg.goto(BASE + URL, wait_until="domcontentloaded", timeout=30000)
                pg.wait_for_selector("#eko-acesso", state="visible", timeout=15000)
                tl = pg.locator("#eko-acesso .tela").text_content().strip()
                ok(tl == "Outras Pesagens", "teclado da senha diz o nome da tela: Outras Pesagens", tl)
                senha(pg)
                pg.locator(AD).click()
                lay = pg.evaluate("""(s) => { const b = document.querySelector(s); const sp = b.querySelector('span'), sm = b.querySelector('small');
                    const r = e => e.getBoundingClientRect();
                    return { sp: [r(sp).top, r(sp).bottom], sm: [r(sm).top, r(sm).bottom], w: r(b).width, h: r(b).height }; }""", AD)
                ok(lay["sm"][0] >= lay["sp"][1] - 1, f"AD ({rot}): a sacola fica embaixo de 'VERDE 1,52 m', não ao lado", lay)
                pesar(pg, 503.3)
                pg.wait_for_function("() => !document.getElementById('btn-imprimir').disabled", timeout=10000, polling=200)
                conferir(pg, f"ad-pesada{suf}")
                for h in (H, H_BAIXA):
                    pg.set_viewport_size({"width": W, "height": h}); pg.evaluate("window.scrollTo(0, 0)"); pg.wait_for_timeout(200)
                    r = pg.evaluate(PRINCIPAL, ["#peso-item", "#peso-liq", "#btn-imprimir"])
                    bom = lambda x: x.get("dentro") and not x.get("coberto") and not x.get("cortado")
                    pi, pl, pb = r["#peso-item"], r["#peso-liq"], r["#btn-imprimir"]
                    ok(bom(pi) and "AD VERDE 1,52" in pi.get("txt", ""), f"AD @{h} ({rot}): barra diz 'AD VERDE 1,52' inteiro, sem reticência", pi)
                    ok(bom(pl) and "500.0" in pl.get("txt", "") and "3.3" in pl.get("txt", "") and "tubete" in pl.get("txt", ""),
                       f"AD @{h} ({rot}): barra mostra o líquido 500.0 e o tubete 3.3, como a etiqueta sai", pl)
                    ok(bom(pb), f"AD @{h} ({rot}): IMPRIMIR à vista", pb)
                pg.set_viewport_size({"width": W, "height": H})
                if PRINTS: pg.screenshot(path=str(PRINTS / f"{PREFIXO}ad-pesada{suf}-tela.png"))
                pesar(pg, 1600.0)
                pg.wait_for_timeout(300)
                pb = pg.evaluate(PRINCIPAL, ["#btn-imprimir"])["#btn-imprimir"]
                desl = pg.evaluate("document.getElementById('btn-imprimir').disabled")
                ok(desl and "PESO FORA" in pb.get("txt", "") and "1.500" in pb.get("txt", "") and not pb.get("cortado"),
                   f"AD 1600 kg ({rot}): IMPRIMIR apagado diz o motivo (peso fora de 20–1.500)", pb)
                conferir(pg, f"ad-peso-fora{suf}")
                if PRINTS: pg.screenshot(path=str(PRINTS / f"{PREFIXO}ad-peso-fora{suf}-tela.png"))
                if not sem_fontes:
                    pesar(pg, 503.3)
                    pg.wait_for_function("() => !document.getElementById('btn-imprimir').disabled", timeout=10000, polling=200)
                    pg.locator("#btn-imprimir").click()
                    pg.wait_for_function("() => document.querySelectorAll('#hist-lista .hist-item').length === 1", timeout=15000, polling=200)
                    bal["peso"] = 0.0
                    sess = req("/sessoes/abertas?tipo=outras")["sessoes"]
                    e_ad = sess[0]["etiquetas"][0]
                    ok(abs(float(e_ad["peso"]) - 500.0) < 0.05, "AD: etiqueta impressa com 500.0 kg (o líquido que a barra mostrou)", e_ad.get("peso"))
                    conferir(pg, "ad-impressa")
                    if PRINTS: pg.screenshot(path=str(PRINTS / f"{PREFIXO}ad-impressa-tela.png"))
                    if pg.evaluate("typeof onLeu === 'function'"):
                        pg.evaluate(f"onLeu({json.dumps(e_ad['id'])})")
                        try:
                            pg.wait_for_selector("#hist-lista .hist-item.bipada", timeout=8000); bip = True
                        except Exception:
                            bip = False
                        ok(bip, f"AD: bipe de {e_ad['id']} pelo onLeu")
                    else:
                        ok(False, "AD: a tela tem onLeu")
                    pg.wait_for_function("() => document.getElementById('peso-val').textContent === '0.0'", timeout=10000, polling=200)
                    pl = pg.evaluate("(document.getElementById('peso-liq') || {}).textContent || ''")
                    ok(pl.startswith("0.0"), "AD: balança vazia, a barra mostra 0.0 (não um líquido negativo)", pl)
                    if PRINTS: pg.screenshot(path=str(PRINTS / f"{PREFIXO}ad-bipada-tela.png"))
                    req(f"/sessoes/{sess[0]['id']}/finalizar", {})
                ctx.close()

            # ── 4. Monitor do Mini PC ──────────────────────────────────
            print("\n[4] Monitor do Mini PC 1366×768: igual com e sem o estilo do coletor")
            fotos = {}
            for sem in (False, True):
                ctx, pg = contexto(1366, 768, ua=None, sem_coletor=sem)
                # No Mini PC a tela abre dentro do quadro do menu (seguranca-saida.js
                # reabre /?tela=… quando o navegador não é o app).
                pg.goto(BASE + "/?tela=" + urllib.parse.quote(URL, safe=""), wait_until="domcontentloaded", timeout=30000)
                fr = None
                for _ in range(150):
                    fr = next((x for x in pg.frames if urllib.parse.urlparse(x.url).path == URL), None)
                    if fr: break
                    pg.wait_for_timeout(200)
                fr.wait_for_load_state("domcontentloaded"); senha(fr)
                tem = fr.evaluate("!!document.getElementById('estilo-coletor')")
                if not sem:
                    ch = fr.evaluate("[sessionStorage.getItem('eko_liberado_mp'), sessionStorage.getItem('eko_liberado_residuos')]")
                    ok(ch[0] and not ch[1], "Mini PC: a senha continua na chave 'mp' (igual a antes)", ch)
                f = {"inicio": fr.evaluate(FOTO_LAYOUT)}
                if PRINTS: pg.screenshot(path=str(PRINTS / f"{PREFIXO}monitor-inicio-{'sem' if sem else 'com'}.png"))
                fr.locator("#it-RES\\.BORRA").click(); pesar(fr, 41.7)
                fr.wait_for_function("() => !document.getElementById('btn-imprimir').disabled", polling=200)
                f["peso"] = fr.evaluate(FOTO_LAYOUT)
                if PRINTS: pg.screenshot(path=str(PRINTS / f"{PREFIXO}monitor-peso-{'sem' if sem else 'com'}.png"))
                n = fr.locator("#hist-lista .hist-item").count()
                fr.locator("#btn-imprimir").click()
                fr.wait_for_function(f"() => document.querySelectorAll('#hist-lista .hist-item').length === {n + 1}", timeout=15000, polling=200)
                bal["peso"] = 0.0
                fr.wait_for_function("() => document.getElementById('balanca-status').textContent === 'Aguardando material'", timeout=10000, polling=200)
                fr.wait_for_timeout(300)
                # os horários e números da lista mudam de uma rodada para a outra; o tamanho não
                fr.evaluate("document.querySelectorAll('#hist-lista .hist-id, #hist-lista .hist-small').forEach(e => e.style.visibility = 'hidden')")
                f["lista"] = fr.evaluate(FOTO_LAYOUT)
                if PRINTS: pg.screenshot(path=str(PRINTS / f"{PREFIXO}monitor-lista-{'sem' if sem else 'com'}.png"))
                # Leitor USB do Mini PC (teclado rápido + Enter) continua bipando.
                pend = fr.evaluate("state.itens[0].id")
                # As teclas vão de uma vez (cadência de leitor, < 300 ms): o
                # pg.keyboard.type passava dos 300 ms com a VPS carregada.
                fr.evaluate("""(c) => { for (const k of [...c, 'Enter'])
                    window.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); }""", pend)
                fr.wait_for_function("() => !document.querySelector('#hist-lista .hist-item.pendente')", timeout=10000, polling=200)
                if not sem: ok(True, f"Mini PC: leitor USB (teclado) bipa {pend}")
                for jan, botao in [("refugo", "#btn-refugo"), ("recuperada", "#btn-recuperada")]:
                    fr.locator(botao).click(); fr.wait_for_selector(f"#modal-{jan}.on")
                    fr.wait_for_timeout(600)
                    f[jan] = fr.evaluate(FOTO_LAYOUT)
                    if PRINTS: pg.screenshot(path=str(PRINTS / f"{PREFIXO}monitor-{jan}-{'sem' if sem else 'com'}.png"))
                    fr.locator(f"#modal-{jan} .btn-modal.secundario").click()
                fr.locator(".btn-finalizar").click()
                fr.wait_for_function("() => !document.getElementById('banner-turno').classList.contains('on')", timeout=15000, polling=200)
                fr.wait_for_timeout(1500)
                if not sem: ok(fr.locator("#eko-acesso").count() == 0, "Mini PC: depois do FINALIZAR a senha NÃO é pedida (igual a antes)")
                fotos[sem] = (tem, f)
                ctx.close()
            (_, a), (tem_sem, b) = fotos[False], fotos[True]
            ok(not tem_sem, "a versão sem o estilo do coletor não tem o bloco", tem_sem)
            for k in a:
                dif = [f"{x[:3]} {x[3:7]}/{y[3:7]} {x[7:]}≠{y[7:]}" for x, y in zip(a[k], b[k]) if x != y]
                ok(len(a[k]) == len(b[k]) and not dif, f"monitor ({k}): {len(a[k])} elementos na mesma posição e estilo",
                   f"{len(a[k])}≠{len(b[k])} " + "; ".join(dif[:4]))
            ok(not erros, "sem erro de JavaScript", "; ".join(erros)[:300])
            br.close()
    finally:
        srv.kill(); srv.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'FALHOU: ' + str(len(falhas)) if falhas else 'OK'}")
    sys.exit(1 if falhas else 0)


main()
