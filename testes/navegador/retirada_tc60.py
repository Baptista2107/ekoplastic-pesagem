"""Teste de navegador da RETIRADA de MP no coletor TC60 (25/11/2026).

Gustavo, 25/11: "não tá legal de ver no android do TC60" e "todas as telas
merecem atenção uma a uma". O TC60 (Android 14, 720×1440, dpr 2) mostra a
WebView do app "Ekoplastic MP" com ~360×690 CSS, sem "viewport largo". O Bruno
usa com uma mão e às vezes de luva.

Sobe o server.js de verdade com banco temporário (impressão simulada, portas
14130/14131/14132) e abre /mp-retirada.html como o app abre (360×690, dpr 2,
user-agent "… EkoColetor/2.0"). A lista de pedidos do painel vem de uma rota
falsa (/retirada/pedidos), o resto é o servidor. Em cada estado — senha, sem
pedido, com pedido, bag bipado, lista longa, aditivo em sacos, teclado
"Digitar código", janela de bag fora do pedido, janela "já foi retirada",
confirmação do FINALIZAR e o aviso depois dele — confere:

  1. nada passa da borda (sem rolagem para o lado, nenhum elemento fora);
  2. todo controle visível (botão, campo, link) tem ≥ 56 px de altura e de
     largura e está inteiro dentro da tela;
  3. todo texto visível tem ≥ 16 px (o teclado da senha é do
     acesso-colaborador.js, compartilhado: fica fora desta conta);
  4. o principal está à vista SEM rolar e sem nada por cima: o que bipar
     agora (aguardando bipagem + 1º pedido aberto), o último bag e o
     FINALIZAR. Listas e o formulário de sacos podem rolar: o último item
     da lista e o ADICIONAR ITEM se alcançam rolando, sem nada por cima.
  5. cabeçalho: o status do servidor diz OK / BLING OFF / OFFLINE (não só
     cor); o crachá do responsável com nome comprido corta com reticências;
     com o teclado do Android aberto (tela encolhida para 400 px), o campo
     de quantidade em foco não fica atrás da barra do FINALIZAR;
  6. Monitor do Mini PC (1366×768): a tela com o bloco do coletor é IGUAL à
     tela sem ele (posição, tamanho e fonte de cada elemento), em 4 estados.

Não entra no rodar-todos.js (o Mini PC não tem navegador de teste).

    cd ~/bling-claude && timeout 400 venv/bin/python -I <repo pesagem>/testes/navegador/retirada_tc60.py <repo pesagem> [pasta-fotos] [prefixo]

Sai 1 se falhar."""
import json, os, re, shutil, subprocess, sys, tempfile, time, urllib.request
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

REPO = Path(sys.argv[1])
FOTOS = Path(sys.argv[2]) if len(sys.argv) > 2 else None
PREFIXO = sys.argv[3] if len(sys.argv) > 3 else "foto"
if FOTOS: FOTOS.mkdir(parents=True, exist_ok=True)
PORTA = 14130
PIN = "5824"
NOME = "BRUNO HENRIQUE DE OLIVEIRA SANTOS"
UA_APP = "Mozilla/5.0 (Linux; Android 14; TC60) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Mobile Safari/537.36 EkoColetor/2.0"
W, H = 360, 690
MIN_TOQUE, MIN_FONTE = 56, 16
HTML = (REPO / "public/mp-retirada.html").read_text(encoding="utf-8")
# O bloco do coletor fica entre estes marcadores; a 1366 px a tela com ele tem
# de ser igual à tela sem ele.
SEM_TC60 = re.sub(r"<!-- tc60 -->.*?<!-- /tc60 -->", "", HTML, flags=re.S)
falhas = []


def ok(cond, msg, det=""):
    print(("  ✓ " if cond else "  ✗ ") + msg + ("" if cond or not det else f"  [{det}]"))
    if not cond: falhas.append(msg)


def req(rota, corpo=None):
    dados = json.dumps(corpo).encode() if corpo is not None else None
    r = urllib.request.Request(f"http://127.0.0.1:{PORTA}" + rota, data=dados,
                               headers={"Content-Type": "application/json"} if dados else {})
    with urllib.request.urlopen(r, timeout=10) as x: return json.loads(x.read())


def pedido(i, **extra):
    p = {"id": f"RM-{i}", "material_key": "GBD", "material_nome": "GRÃO BAIXA DENSIDADE", "cor": "Preto",
         "fornecedor": "Ecorafia", "lote": "021026", "lote_fmt": "02/10/26", "peso": 1000, "bags_pedidos": 3,
         "bags_atendidos": 1 if i % 2 else 0, "status": "aberto", "autor_nome": "Willian",
         "criado_em": "2026-11-25T09:43:00-03:00", "etiquetas_atendidas": [],
         "enderecos": ["R02-A-03", "R02-B-01", "R05-C-02"]}
    p.update(extra)
    return p


PEDIDOS = {"agora": {"ok": True, "modo": "teste", "pedidos": []}}
DOIS = [pedido(1), pedido(2, material_key="PIG", material_nome="PIGMENTO BRANCO", cor="Branco", fornecedor="Cristal Master",
                          unidade="kg", kg_pedidos=100, kg_atendidos=25, kg_saco=25, lote="")]
LONGA = DOIS + [pedido(i) for i in range(3, 9)] + [pedido(9, status="atendido", bags_atendidos=3)]

# ── medições no navegador ────────────────────────────────────────────
JS_MEDIR = """(o) => {
  const W = document.documentElement.clientWidth, H = window.innerHeight;
  const vis = e => { for (let x = e; x && x !== document.documentElement; x = x.parentElement) {
      const cs = getComputedStyle(x); if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return false; }
    const b = e.getBoundingClientRect(); return b.width > 0 && b.height > 0; };
  const nome = e => (e.id ? '#' + e.id : e.tagName.toLowerCase() + (e.classList.length ? '.' + [...e.classList].join('.') : ''))
                    + (e.textContent ? ' "' + e.textContent.trim().replace(/\\s+/g, ' ').slice(0, 24) + '"' : '');
  const fora = (e) => o.ignorar && e.closest(o.ignorar);
  const borda = [], toque = [], fonte = [];
  for (const e of document.querySelectorAll('body *')) {
    if (e.id === '__ekoScan' || fora(e) || !vis(e)) continue;
    const b = e.getBoundingClientRect();
    if (b.right > W + 1 || b.left < -1) borda.push(nome(e) + ' ' + Math.round(b.left) + '→' + Math.round(b.right));
    const ctrl = e.matches('button, select, textarea, a[href], [onclick], input:not([type=hidden]):not([type=checkbox]):not([type=radio])');
    if (ctrl && (b.height < o.toque - 0.5 || b.width < o.toque - 0.5))
      toque.push(nome(e) + ' ' + Math.round(b.width) + '×' + Math.round(b.height));
    // Texto que vaza do próprio botão (linha sem quebra) também é "fora".
    if (ctrl && getComputedStyle(e).overflowX === 'visible' && e.scrollWidth > e.clientWidth + 1)
      borda.push(nome(e) + ' vaza do botão ' + e.scrollWidth + '>' + e.clientWidth);
    const temTexto = [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    // Texto que vaza da caixa (linha sem quebra) também conta como "fora" —
    // a não ser que uma caixa (fora o body) corte o excesso dentro da tela,
    // como a bolinha do status.
    let corta = null;
    for (let x = e; x && x !== document.body; x = x.parentElement)
      if (getComputedStyle(x).overflowX !== 'visible') { corta = x; break; }
    const cb = corta && corta.getBoundingClientRect();
    if (!(cb && cb.left >= -1 && cb.right <= W + 1)) for (const n of e.childNodes) {
      if (n.nodeType !== 3 || !n.textContent.trim()) continue;
      const rg = document.createRange(); rg.selectNodeContents(n); const t = rg.getBoundingClientRect();
      if (t.width && (t.right > W + 1 || t.left < -1)) borda.push(nome(e) + ' (texto) ' + Math.round(t.left) + '→' + Math.round(t.right));
    }
    const fs = parseFloat(getComputedStyle(e).fontSize);
    if ((temTexto || e.matches('input, textarea')) && fs < o.fonte - 0.01) fonte.push(nome(e) + ' ' + fs + 'px');
  }
  return { sw: document.documentElement.scrollWidth, W, borda, toque, fonte };
}"""

# À vista sem rolar: inteiro dentro da tela e é ele (ou um filho) que está no
# ponto do meio — nada fixo por cima.
JS_A_VISTA = """(sels) => sels.map(s => {
  const e = document.querySelector(s); if (!e) return s + ': não existe';
  const b = e.getBoundingClientRect(), H = window.innerHeight, W = document.documentElement.clientWidth;
  if (!b.width || !b.height) return s + ': escondido';
  if (b.top < -1 || b.bottom > H + 1 || b.left < -1 || b.right > W + 1)
    return s + ': fora da tela (' + Math.round(b.top) + '→' + Math.round(b.bottom) + ' de ' + H + ')';
  // Aviso (toast) não recebe toque (pointer-events:none): basta estar na tela.
  if (getComputedStyle(e).pointerEvents === 'none' || e.closest('#toast-wrap')) return null;
  const p = document.elementFromPoint(b.left + b.width / 2, b.top + Math.min(b.height / 2, 20));
  if (!p || !(e === p || e.contains(p))) return s + ': coberto por ' + (p ? (p.id || p.className || p.tagName) : 'nada');
  return null;
}).filter(Boolean)"""

# Os avisos (toast) somem sozinhos no meio da medição: ficam fora.
JS_ASSINATURA = """() => [...document.querySelectorAll('body *')].filter(e => e.id !== 'clock' && !e.closest('#toast-wrap')).map(e => {
  const b = e.getBoundingClientRect(), cs = getComputedStyle(e);
  return [e.tagName, e.id, e.className, Math.round(b.left), Math.round(b.top), Math.round(b.width), Math.round(b.height),
          cs.fontSize, cs.display, cs.position, cs.color, cs.backgroundColor].join('|');
})"""


def medir(pg, nome, a_vista=(), ignorar="#eko-acesso", toque=True, fonte=True):
    pg.evaluate("window.scrollTo(0, 0)"); pg.wait_for_timeout(250)
    if FOTOS:
        pg.screenshot(path=str(FOTOS / f"{PREFIXO}-{nome}.png"), timeout=30000)
        pg.screenshot(path=str(FOTOS / f"{PREFIXO}-{nome}-inteira.png"), full_page=True, timeout=30000)
    r = pg.evaluate(JS_MEDIR, {"toque": MIN_TOQUE, "fonte": MIN_FONTE, "ignorar": ignorar})
    ok(r["sw"] <= W and not r["borda"], f"{nome}: nada passa da borda de {W} px",
       f"scrollWidth {r['sw']}; {len(r['borda'])} fora: " + "; ".join(r["borda"][:5]))
    if toque:
        ok(not r["toque"], f"{nome}: controles com ≥ {MIN_TOQUE} px", f"{len(r['toque'])}: " + "; ".join(r["toque"][:6]))
    if fonte:
        ok(not r["fonte"], f"{nome}: texto com ≥ {MIN_FONTE} px", f"{len(r['fonte'])}: " + "; ".join(r["fonte"][:6]))
    if a_vista:
        faltam = pg.evaluate(JS_A_VISTA, list(a_vista))
        ok(not faltam, f"{nome}: à vista sem rolar — " + ", ".join(a_vista), "; ".join(faltam))


def senha(pg):
    # Espera a tela decidir: teclado da senha na frente ou responsável já entrado.
    pg.wait_for_function("() => document.getElementById('eko-acesso') || window.EKO_RESPONSAVEL", timeout=20000)
    pg.wait_for_timeout(300)
    if pg.locator("#eko-acesso").count() and pg.locator("#eko-acesso").is_visible():
        for ch in PIN: pg.locator("#eko-kb button", has_text=ch).first.click()
        pg.locator("#eko-kb button.ok").click(); pg.wait_for_timeout(1200)
    return not (pg.locator("#eko-acesso").count() and pg.locator("#eko-acesso").is_visible())


def itens(pg, n):
    pg.wait_for_function(f"() => estado.itens.length >= {n} && _itensNaFila === 0", timeout=30000)
    pg.wait_for_timeout(400)


def rota_pedidos(route):
    route.fulfill(status=200, content_type="application/json", body=json.dumps(PEDIDOS["agora"]))


def por_pedidos(pg, lista):
    PEDIDOS["agora"] = {"ok": True, "modo": "teste", "pedidos": lista}
    pg.evaluate("carregarPedidos()"); pg.wait_for_timeout(500)


def main():
    tmp = Path(tempfile.mkdtemp(prefix="eko_tc60_"))
    env = {**os.environ, "EKO_PORT": str(PORTA), "EKO_PORT_CB": str(PORTA + 1), "EKO_PORT_HTTPS": str(PORTA + 2),
           "EKO_DB_FILE": str(tmp / "t.db"), "EKO_LOG_DIR": str(tmp / "logs"), "EKO_TOKEN_FILE": str(tmp / "tok.json"),
           "TZ": "America/Sao_Paulo", "EKO_PRINT_SIMULAR": "1", "EKO_FECHAR_TELA_SIMULAR": "1"}
    srv = subprocess.Popen(["node", str(REPO / "server.js")], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(300):
            try:
                if req("/healthcheck").get("ok"): break
            except Exception: pass
            time.sleep(0.2)
        # Nada deste banco de teste vai para a VPS de verdade.
        req("/config", {"vps_sacoleiras_url": "http://127.0.0.1:9/api/sacoleiras/agora"})
        # Nome comprido de propósito: o crachá tem de cortar com reticências.
        req("/colaboradores/salvar", {"nome": NOME, "pin": PIN, "telas": ["mp"]})
        # Bags no estoque: recebidos e bipados.
        srec = req("/sessoes", {"tipo": "recebimento", "operador": NOME, "fornecedor": "Ecorafia"})["sessao_id"]
        bags = []
        for i in range(12):
            r = req("/print/etiqueta", {"clientToken": f"tc60-{time.time()}-{i}", "tipo": "recebimento", "materialKey": "GBD",
                                        "materialNomeEt": "GRÃO BAIXA DENSIDADE", "cor": "Preto", "fornecedor": "Ecorafia",
                                        "peso": 1000 + i * 12.5, "lote": "021026", "codigo": "X1",
                                        "sku": "GBD.PRE.ECORAF | 1000 | L021026", "sessao_id": srec})
            req(f"/etiquetas/{r['id']}/bipar", {})
            bags.append(r["id"])
        ok(len(bags) == 12, "12 bags no estoque do banco de teste", bags)

        with sync_playwright() as pw:
            br = _navegador(pw)
            erros = []

            # ── Coletor TC60 ─────────────────────────────────────────
            print(f"\n[1] Coletor TC60 ({W}×{H}, dpr 2, app)")
            ctx = br.new_context(viewport={"width": W, "height": H}, user_agent=UA_APP, device_scale_factor=2, has_touch=True)
            pg = ctx.new_page(); pg.set_default_timeout(8000); pg.set_default_navigation_timeout(60000)
            pg.on("dialog", lambda d: d.accept())
            pg.on("pageerror", lambda e: erros.append(str(e)))
            pg.route("**/retirada/pedidos", rota_pedidos)
            pg.goto(f"http://127.0.0.1:{PORTA}/mp-retirada.html"); pg.wait_for_timeout(1500)
            # Teclado da senha: componente compartilhado (acesso-colaborador.js).
            # Aqui só se confere que cabe; tamanho de toque e fonte dele não são desta tela.
            medir(pg, "pin", ignorar=None, toque=False, fonte=False)
            ok(senha(pg), "senha aceita")

            medir(pg, "sem-pedido", a_vista=("#fluxo-bipagem .bipa-display .titulo", "#btn-finalizar", "#eko-resp-tag"))
            cr = pg.evaluate("""() => { const e = document.getElementById('eko-resp-tag'), cs = getComputedStyle(e);
                return { corta: e.scrollWidth > e.clientWidth + 1, display: cs.display, to: cs.textOverflow }; }""")
            ok(not cr["corta"] or (cr["display"] in ("block", "inline-block") and cr["to"] == "ellipsis"),
               "crachá com nome comprido: corta com reticências (não no seco)", json.dumps(cr))

            # Status do servidor no cabeçalho: os três estados, com texto.
            def status(resp):
                pg.route("**/healthcheck", resp); pg.evaluate("checarServidor()"); pg.wait_for_timeout(600)
                pg.unroute("**/healthcheck")
                return pg.evaluate("""() => { const e = document.getElementById('srv-status');
                    return { cls: e.className, txt: getComputedStyle(e, '::after').content, cor: getComputedStyle(e).color }; }""")
            J = lambda d: (lambda r: r.fulfill(status=200, content_type="application/json", body=json.dumps(d)))
            s_ok = status(J({"ok": True, "bling": {"autenticado": True}}))
            s_bl = status(J({"ok": True, "bling": {"autenticado": False}}))
            s_of = status(lambda r: r.fulfill(status=500, body="erro"))
            ok(s_ok["txt"] == '"OK"' and s_bl["txt"] == '"BLING OFF"' and s_of["txt"] == '"OFFLINE"'
               and len({s_ok["cor"], s_bl["cor"], s_of["cor"]}) == 3,
               "status: OK / BLING OFF / OFFLINE escritos e em três cores", json.dumps([s_ok, s_bl, s_of]))
            if FOTOS: pg.screenshot(path=str(FOTOS / f"{PREFIXO}-status-offline.png"), timeout=30000)
            pg.evaluate("checarServidor()"); pg.wait_for_timeout(600)

            por_pedidos(pg, DOIS)
            medir(pg, "com-pedido", a_vista=("#fluxo-bipagem .bipa-display .titulo", "#pp-lista .pp-item .pp-mat", "#btn-finalizar"))

            pg.evaluate(f"onLeu({json.dumps(bags[0])})"); itens(pg, 1)
            ok(pg.evaluate("estado.itens.length") == 1, "bipe pelo app (onLeu) saiu na retirada")
            medir(pg, "bag-bipado", a_vista=("#ultima-retirada", "#btn-finalizar", "#pp-lista .pp-item .pp-mat"))
            ok(not pg.locator("#btn-finalizar").is_disabled(), "bag-bipado: FINALIZAR ligado")

            por_pedidos(pg, LONGA)
            for b in bags[1:8]: pg.evaluate(f"onLeu({json.dumps(b)})")
            itens(pg, 8)
            # Um aditivo em sacos na lista, como no dia a dia.
            pg.locator(".subtab[data-tipo=sacos]").click(); pg.wait_for_timeout(300)
            pg.locator("#opc-tipo .opc", has_text="DESSECANTE").click(); pg.wait_for_timeout(200)
            pg.locator("#opc-forn .opc").first.click(); pg.wait_for_timeout(200)
            pg.evaluate("setSacos(5)"); pg.wait_for_timeout(200)
            medir(pg, "sacos", a_vista=("#btn-finalizar",))
            # O formulário de sacos é maior que a tela: o ADICIONAR se alcança
            # rolando e não fica escondido atrás da barra do FINALIZAR.
            pg.locator("#btn-add-aditivo").scroll_into_view_if_needed(); pg.wait_for_timeout(300)
            faltam = pg.evaluate(JS_A_VISTA, ["#btn-add-aditivo"])
            ok(not faltam, "sacos: rolando, o ADICIONAR ITEM fica à vista e tocável", "; ".join(faltam))
            pg.locator("#btn-add-aditivo").click(); itens(pg, 9)
            pg.evaluate("setFluxo('bipagem')"); pg.wait_for_timeout(300)
            pg.evaluate(f"onLeu({json.dumps(bags[8])})"); itens(pg, 10)
            medir(pg, "lista-longa", a_vista=("#fluxo-bipagem .bipa-display .titulo", "#ultima-retirada", "#btn-finalizar"))
            # A lista inteira se alcança rolando: o último item e o X dele.
            pg.locator("#hist-lista .item").last.scroll_into_view_if_needed(); pg.wait_for_timeout(300)
            faltam = pg.evaluate(JS_A_VISTA, ["#hist-lista .item:last-child .item-x"])
            ok(not faltam, "lista-longa: rolando, o X do último item fica à vista e tocável", "; ".join(faltam))
            pg.locator("#btn-resumo-dia").scroll_into_view_if_needed(); pg.wait_for_timeout(300)
            faltam = pg.evaluate(JS_A_VISTA, ["#btn-resumo-dia", "#btn-relatorio"])
            ok(not faltam, "lista-longa: rolando até o fim, Relatório e Resumo do dia à vista e tocáveis", "; ".join(faltam))

            # Aditivo com cor (Pigmento): blocos de cor + fornecedor.
            pg.locator(".subtab[data-tipo=sacos]").click(); pg.wait_for_timeout(300)
            pg.locator("#opc-tipo .opc", has_text="PIGMENTO").click(); pg.wait_for_timeout(200)
            if pg.locator("#opc-cor .opc").count(): pg.locator("#opc-cor .opc").first.click()
            pg.locator("#opc-forn .opc").first.click(); pg.wait_for_timeout(200)
            pg.locator("#avulso-input").fill("12,5"); pg.evaluate("ajustarSacos(0); document.activeElement.blur()"); pg.wait_for_timeout(200)
            medir(pg, "sacos-pigmento", a_vista=("#opc-tipo .opc", "#btn-finalizar"))
            # Teclado do Android aberto: o app encolhe a tela (adjustResize).
            # O campo em foco não pode ficar atrás da barra do FINALIZAR.
            pg.set_viewport_size({"width": W, "height": 400})
            for campo in ("#avulso-input", "#sacos-input"):
                # O Android rola o campo em foco só o mínimo: ele fica no pé da tela.
                pg.locator(campo).focus(); pg.evaluate(f"document.querySelector('{campo}').scrollIntoView({{block: 'end'}})")
                pg.wait_for_timeout(300)
                faltam = pg.evaluate(JS_A_VISTA, [campo])
                ok(not faltam, f"teclado do Android aberto: {campo} em foco fica à vista", "; ".join(faltam))
                if FOTOS and campo == "#avulso-input": pg.screenshot(path=str(FOTOS / f"{PREFIXO}-sacos-teclado-android.png"), timeout=30000)
            pg.evaluate("document.activeElement.blur()")
            pg.set_viewport_size({"width": W, "height": H}); pg.wait_for_timeout(300)
            pg.evaluate("setFluxo('bipagem')"); pg.wait_for_timeout(300)

            pg.evaluate("simularBipe()"); pg.wait_for_timeout(400)
            medir(pg, "teclado", a_vista=(".kp-ok", ".kp-cancel", ".kp-grid button:last-child"))
            pg.evaluate("kpCancel()"); pg.wait_for_timeout(200)

            pg.evaluate("""() => { perguntarFora({ modo: 'producao', etiqueta: { id: 'R0000999', material_nome: 'GRÃO BAIXA DENSIDADE',
                cor: 'Preto', fornecedor: 'Ecorafia', lote: '021026', peso: 1000 }, pedidos: [
                { id: 'RM-1', material_nome: 'GRÃO BAIXA DENSIDADE', cor: 'Preto', fornecedor: 'Ecorafia', lote: '021026', bags_pedidos: 3, bags_atendidos: 1 },
                { id: 'RM-2', material_nome: 'PIGMENTO BRANCO', fornecedor: 'Cristal Master', unidade: 'kg', kg_pedidos: 100, kg_atendidos: 25, kg_saco: 25 }] }); }""")
            pg.wait_for_timeout(400)
            medir(pg, "janela-fora", a_vista=("#modal-fora .titulo",))
            pg.locator("#fora-motivos button", has_text="Outro motivo").click(); pg.wait_for_timeout(300)
            pg.evaluate("document.activeElement && document.activeElement.blur()")
            medir(pg, "janela-fora-outro", a_vista=())
            pg.evaluate("fecharFora(null)"); pg.wait_for_timeout(300)

            pg.evaluate("""() => mostrarBloqueio({ id: 'R0000777', material_nome: 'GRÃO BAIXA DENSIDADE', cor: 'Preto', fornecedor: 'Ecorafia',
                peso: 1000 }, { id: 'S0000777', hora_impressao: '2026-11-24T14:05:00-03:00' })""")
            pg.wait_for_timeout(400)
            medir(pg, "janela-bloqueado", a_vista=("#modal-bloqueado .btn-fechar",))
            pg.evaluate("fecharBloqueio()"); pg.wait_for_timeout(300)

            # Aviso de erro: etiqueta que não existe no banco. O aviso some em
            # 3,5 s; para medir com a VPS carregada, o mesmo texto fica na tela
            # pelo showToast da própria página.
            pg.evaluate("onLeu('R0099999')")
            pg.wait_for_selector("#toast-wrap .toast.erro", timeout=15000)
            txt = pg.locator("#toast-wrap .toast.erro").first.inner_text()
            pg.evaluate("t => { document.getElementById('toast-wrap').innerHTML = ''; showToast('erro', '✗', t.replace(/^\\S+\\s*/, ''), 120000); }", txt)
            pg.wait_for_timeout(400)
            medir(pg, "aviso-erro", a_vista=("#toast-wrap .toast.erro", "#btn-finalizar"))
            pg.evaluate("document.getElementById('toast-wrap').innerHTML = ''")

            pg.locator("#btn-finalizar").click(); pg.wait_for_timeout(500)
            medir(pg, "janela-finalizar", a_vista=("#conf-ok", "#modal-confirmar .btn-fechar"))
            pg.locator("#conf-ok").click(); pg.wait_for_timeout(2500)
            # Finalizou: a tela volta a pedir a senha (processo encerrado).
            ok(pg.locator("#eko-acesso").is_visible(), "finalizou: pede a senha de novo")
            medir(pg, "finalizado", ignorar=None, toque=False, fonte=False)
            ctx.close()

            # ── Monitor do Mini PC ───────────────────────────────────
            print("\n[2] Monitor do Mini PC (1366×768): igual com e sem o bloco do coletor")
            servir = {"html": HTML}
            ctx = br.new_context(viewport={"width": 1366, "height": 768})
            pg = ctx.new_page(); pg.set_default_timeout(8000); pg.set_default_navigation_timeout(60000)
            pg.on("pageerror", lambda e: erros.append("1366: " + str(e)))
            pg.route("**/retirada/pedidos", rota_pedidos)
            pg.route("**/mp-retirada.html", lambda r: r.fulfill(status=200, content_type="text/html; charset=utf-8", body=servir["html"]))
            PEDIDOS["agora"] = {"ok": True, "modo": "teste", "pedidos": DOIS}
            pg.goto(f"http://127.0.0.1:{PORTA}/mp-retirada.html"); senha(pg)
            pg.evaluate(f"onLeu({json.dumps(bags[10])})"); itens(pg, 1)
            assin = {}
            for qual, html in (("sem", SEM_TC60), ("com", HTML)):
                servir["html"] = html
                pg.goto(f"http://127.0.0.1:{PORTA}/mp-retirada.html"); senha(pg)
                # Sem transição/animação nas duas: a VPS carregada pegava a cor
                # da aba no meio da troca e acusava diferença que não existe.
                pg.add_style_tag(content="*,*::before,*::after{transition:none!important;animation:none!important}")
                pg.wait_for_selector("#srv-status.on", timeout=20000)
                itens(pg, 1); pg.wait_for_timeout(800)
                a = {"bipagem": pg.evaluate(JS_ASSINATURA)}
                if FOTOS and qual == "com": pg.screenshot(path=str(FOTOS / f"{PREFIXO}-1366-bipagem.png"))
                pg.evaluate("setFluxo('sacos'); selTipo('PIG')"); pg.wait_for_timeout(800)
                a["sacos"] = pg.evaluate(JS_ASSINATURA)
                if FOTOS and qual == "com": pg.screenshot(path=str(FOTOS / f"{PREFIXO}-1366-sacos.png"))
                pg.evaluate("setFluxo('bipagem'); simularBipe()"); pg.wait_for_timeout(800)
                a["teclado"] = pg.evaluate(JS_ASSINATURA)
                pg.evaluate("kpCancel()"); pg.locator("#btn-finalizar").click(); pg.wait_for_timeout(800)
                a["finalizar"] = pg.evaluate(JS_ASSINATURA)
                if FOTOS and qual == "com": pg.screenshot(path=str(FOTOS / f"{PREFIXO}-1366-finalizar.png"))
                pg.evaluate("fecharConfirmacao(false)")
                assin[qual] = a
            for estado in ("bipagem", "sacos", "teclado", "finalizar"):
                s, c = assin["sem"][estado], assin["com"][estado]
                dif = [f"{x}  ≠  {y}" for x, y in zip(s, c) if x != y]
                ok(len(s) == len(c) and not dif, f"1366 {estado}: igual com e sem o bloco do coletor",
                   f"{len(s)} × {len(c)} elementos; " + " || ".join(dif[:3]))
            ctx.close()
            ok(not erros, "sem erro de JavaScript", "; ".join(erros)[:400])
            br.close()
    finally:
        srv.kill(); srv.wait(timeout=10)
        shutil.rmtree(tmp, ignore_errors=True)
    print(f"\n{'FALHOU: ' + str(len(falhas)) if falhas else 'OK'}")
    sys.exit(1 if falhas else 0)


main()
