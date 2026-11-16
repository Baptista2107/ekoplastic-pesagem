"""Teste de navegador do LEITOR na tela de Retirada de MP (16/11/2026).

Roda na VPS (Playwright + Chromium de lá), com a API do Mini PC FALSA (rotas
interceptadas): não grava nada. Não entra no rodar-todos.js (o Mini PC não tem
navegador de teste).

    cd ~/bling-claude && venv/bin/python <repo pesagem>/testes/navegador/retirada_leitor.py \
        <repo pesagem>/public /tmp/prints

O leitor manda os caracteres + Enter como teclado USB. Confere, em 1366x768:
  1. dois bipes juntos de bags fora do pedido: um de cada vez, cada um com a
     sua janela; nenhum some; o 1º /consumir demora 1,2 s e o 2º avisa mesmo
     assim que espera (antes só olhava aos 700 ms e esperava calado);
  2. bipe com a janela de motivo ABERTA: não some — espera, avisa, e sai depois
     da resposta (antes um `return` jogava o código fora e o bag saía do
     barracão sem S);
  3. bipe com a janela "JÁ FOI RETIRADA" aberta: espera ela fechar e sai;
  4. Enter do leitor com um botão em foco (com e sem janela): não clica nele;
  5. "Outro motivo…" aberto: o código bipado não entra no texto do motivo e
     vira bipe na fila — também com um soluço de 150 ms no meio da rajada; e o
     código DIGITADO por gente (+ Enter) fica no texto, não vira bipe;
  6. /consumir que nunca responde: depois do teto, avisa "confira se saiu" e o
     bipe seguinte sai (a fila não trava);
  7. buffer: sobra de leitura sem Enter some depois de 1 s; Enter perdido entre
     dois bipes → os DOIS códigos saem, na ordem (revisão B6: o leitor apitou
     nos dois).
  8. bipe com a confirmação de FINALIZAR aberta: não vai na sessão que está
     fechando; com a tela pedindo a senha depois, não sai e avisa (revisão,
     achado 1 — o bag saía sem baixa no Bling). Idem CANCELAR;
  9. teclado da tela ("Digitar código") aberto: o Enter do leitor não aperta
     o botão tocado por último, e o bipe avisa que NÃO saiu (revisão M2);
 10. depois do teto a lista é relida do servidor; "já foi retirada" NESTA
     sessão não abre bloqueio (revisão M3);
 11. servidor responde sessao_fechada: abre outra sessão e repete uma vez —
     também no /consumir com o motivo de fora do pedido (3ª revisão, item 4);
 12. bipe durante o envio ao Bling (sem janela na tela): avisa que espera o
     envio (3ª revisão, item 1).
 13. aditivo com a rede pendurada: o bipe seguinte avisa que espera e sai
     depois do teto (6ª revisão, achado A: o fetch sem teto travava a fila);
 14. aditivo na fila quando confirmam o FINALIZAR: não vai na sessão que está
     fechando; com a senha pedida depois, não é lançado, avisa e o contador
     volta (achado B);
 15. aditivo tocado com a janela de motivo aberta: avisa que está na fila,
     zera o contador no toque e lança o que estava na tela NO TOQUE (achado C);
 16. "Outro motivo…" com o Enter do 1º código perdido: os dois códigos saem,
     na ordem, e nenhum fica no texto do motivo (achado D).
O item 10 relê a sessão DESTA tela, nunca adota a retirada aberta mais nova
de outra pessoa (3ª revisão, item 3).
Na tela de antes (c302b11) falha nos itens 1-7; no 5dd9c56, em 7-12. Sai 1 se falhar.
No 47c434e falha no 1 (o 2º espera calado) e no 5b (soluço: o código fica no motivo).
No 9410234 falha em 13-16 (com PULAR=13, 14-16 falham cada um por si).

O LEITOR aqui é uma rajada com o carimbo de hora de cada tecla 4 ms depois da
outra (CDP Input.dispatchKeyEvent com timestamp), como o HS-960 — o ritmo é da
fonte, não de quanto o Playwright demora para mandar cada tecla com a VPS
carregada (antes o teste passava 2 de 7: keyboard.type chegava a 70-150 ms
entre teclas e "virava gente"). Gente digitando continua sendo keyboard.type
com atraso. Toda conferência espera o ESTADO (ate), não um tempo fixo.

    CPU_LENTA=4 venv/bin/python ... → mesma conferência com a CPU da página 4x
    mais lenta (Emulation.setCPUThrottlingRate), o Mini PC ocupado: as teclas
    chegam atrasadas ao JavaScript, e nenhum bipe pode se perder por isso."""
import os
import json, sys, time, urllib.parse
from pathlib import Path
sys.path.insert(0, "/home/ekoplastic/bling-claude")
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

PUB = Path(sys.argv[1]); OUT = Path(sys.argv[2]); OUT.mkdir(parents=True, exist_ok=True)
HTML = (PUB / "mp-retirada.html").read_text(encoding="utf-8")
# encerrar() = o que o componente de verdade faz ao fim do processo: monta o
# teclado de senha (bloqueando() passa a true até alguém entrar).
ACESSO = ("window.EkoAcesso={exigir:(t,f)=>{window.EKO_RESPONSAVEL='TESTE';f('TESTE');},"
          "encerrar:()=>{window._bloq=true;},bloqueando:()=>!!window._bloq};")

FORA = {"R0000101", "R0000102", "R0000103", "R0000105", "R0000106"}   # bag fora do pedido
JA = {"R0000201"}                                                      # já foi retirado
TRAVA = {"R0000301"}                                                   # /consumir nunca responde
JA_AQUI = {"R0000202"}                                                 # já saiu NESTA sessão
LENTO = {"R0000101": 1.2,   # /consumir que demora (s): o Mini PC ocupado; passa dos 700 ms do aviso antigo
         "R0000480": 1.5}   # bipe no ar quando tocam o aditivo e o Finalizar (14)
ATRASADAS = []           # (hora de soltar, rota) das respostas LENTO
ATRASO_FEITO = set()
CONSUMIDOS = []          # (id, corpo) dos /consumir que deram saída
FECHADAS = set()         # sessões que o servidor falso já fechou
SESS = {"prox": 777}
EVENTOS = []             # ('consumir', id, sessao) / ('fechar', sessao) na ordem em que chegaram
CHAMADAS = {"abertas": 0, "sessao": 0}
OUTRA = {"ligada": False}   # /sessoes/abertas passa a ter uma retirada mais nova de OUTRA pessoa
SEGURAR = {"ligado": False, "rotas": []}   # finalizar fica no ar até o teste soltar
PENDURADAS = []          # rotas que ficaram sem resposta de propósito
GRAVADOS_NO_TETO = []    # (id, corpo) dos /consumir pendurados: gravados no servidor
ADITIVO = {"pendurar": 0, "seq": 500}   # pendurar: quantos /retirada/aditivo ficam sem resposta
ADITIVOS_RECEBIDOS = []  # corpos dos /retirada/aditivo que deram saída
falhas = []


def ok(cond, msg):
    print(("  ✓ " if cond else "  ✗ ") + msg)
    if not cond:
        falhas.append(msg)


def etiq(i):
    return {"id": i, "material_key": "GBD", "material_nome": "GRÃO BAIXA DENSIDADE", "cor": "Preto",
            "fornecedor": "Ecorafia", "lote": "021026", "peso": 1000}


def rota(route):
    req = route.request
    u = urllib.parse.urlparse(req.url); p = urllib.parse.unquote(u.path)
    J = lambda d, st=200: route.fulfill(status=st, content_type="application/json", body=json.dumps(d))
    if p in ("/", "/mp-retirada.html"):
        return route.fulfill(status=200, content_type="text/html", body=HTML)
    if p == "/acesso-colaborador.js":
        return route.fulfill(status=200, content_type="application/javascript", body=ACESSO)
    if p.endswith(".js") or p.endswith(".css"):
        return route.fulfill(status=200, content_type="application/javascript", body="")
    if p == "/healthcheck":
        return J({"ok": True, "servidor": "online", "bling": {"conectado": True}})
    if p == "/sessoes" and req.method == "POST":
        sid = SESS["prox"]; SESS["prox"] += 1
        return J({"ok": True, "sessao_id": sid})
    if p.startswith("/sessoes/abertas"):
        CHAMADAS["abertas"] += 1
        if OUTRA["ligada"]:
            return J({"ok": True, "sessoes": [{"id": 999, "tipo": "retirada", "operador": "OUTRA PESSOA",
                      "inicio": "2026-11-16T12:00:00-03:00", "etiquetas": [dict(etiq("R0000999"), id="S0000999", ref_id="R0000999", tipo="retirada")]}]})
        return J({"ok": True, "sessoes": []})
    if req.method == "GET" and p.startswith("/sessoes/") and p.split("/")[2].isdigit() and p.count("/") == 2:
        CHAMADAS["sessao"] += 1
        sid = int(p.split("/")[2])
        ets = [dict(etiq(i), id="S" + i[1:], ref_id=i, tipo="retirada")
               for i, c in CONSUMIDOS + GRAVADOS_NO_TETO if c.get("sessao_id") == sid]
        return J({"ok": True, "sessao": {"id": sid, "fim": None}, "etiquetas": ets})
    if p.startswith("/sessoes/") and (p.endswith("/finalizar") or p.endswith("/cancelar")):
        sid = int(p.split("/")[2]); FECHADAS.add(sid); EVENTOS.append(("fechar", sid))
        if SEGURAR["ligado"]:
            SEGURAR["rotas"].append(route)    # o teste solta depois
            return None
        # O envio ao Bling demora: na tela de antes, o bipe que esperava a
        # confirmação saía NESTE meio-tempo, ainda com o número desta sessão.
        time.sleep(0.8)
        return J({"ok": True, "sessao_id": sid, "bling": {"ok": True, "modo": "simulacao"}})
    if p == "/retirada/pedidos":
        return J({"ok": True, "modo": "teste", "pedidos": [{"id": "RM-1", "material_key": "GBD", "material_nome": "CARBONATO",
                  "fornecedor": "Karina", "lote": "", "bags_pedidos": 3, "bags_atendidos": 0, "status": "aberto",
                  "autor_nome": "Willian", "criado_em": "2026-11-16T09:43:00-03:00", "etiquetas_atendidas": []}]})
    if p.startswith("/etiquetas/") and p.endswith("/consumir"):
        i = p.split("/")[2]
        corpo = json.loads(req.post_data or "{}")
        if i in LENTO and id(route) not in ATRASO_FEITO:
            # Segura a resposta SEM travar o Python (um sleep aqui pararia
            # também as teclas do bipe seguinte): ate() solta na hora certa.
            ATRASO_FEITO.add(id(route)); ATRASADAS.append((time.time() + LENTO[i], route))
            return None
        if i in TRAVA:
            GRAVADOS_NO_TETO.append((i, corpo))   # o servidor grava; a resposta nunca chega
            PENDURADAS.append(route)          # nunca responde
            return None
        EVENTOS.append(("consumir", i, corpo.get("sessao_id")))
        if corpo.get("sessao_id") in FECHADAS:
            return J({"ok": False, "sessao_fechada": True, "sessao_id": corpo.get("sessao_id"),
                      "erro": "sessão já fechada"}, 409)
        if i in JA:
            return J({"ok": False, "ja_consumida": True, "etiqueta": etiq(i), "consumo": {"id": "S0009999"}}, 409)
        if i in JA_AQUI:
            return J({"ok": False, "ja_consumida": True, "etiqueta": etiq(i),
                      "consumo": {"id": "S0009998", "sessao_id": corpo.get("sessao_id")}}, 409)
        if i in FORA and not corpo.get("fora_do_pedido"):
            return J({"ok": False, "fora_do_pedido": True, "modo": "teste", "etiqueta": etiq(i),
                      "pedidos": [{"id": "RM-1", "material_nome": "CARBONATO", "fornecedor": "Karina", "lote": "",
                                   "bags_pedidos": 3, "bags_atendidos": 0}]}, 409)
        CONSUMIDOS.append((i, corpo))
        ev = dict(etiq(i)); ev.update({"id": "S" + i[1:], "ref_id": i})
        return J({"ok": True, "etiqueta_virtual": ev})
    if p == "/retirada/aditivo" and req.method == "POST":
        corpo = json.loads(req.post_data or "{}")
        EVENTOS.append(("aditivo", corpo.get("materialKey"), corpo.get("sessao_id")))
        if ADITIVO["pendurar"] > 0:
            ADITIVO["pendurar"] -= 1
            PENDURADAS.append(route)          # rede pendurada: nunca responde
            return None
        if corpo.get("sessao_id") in FECHADAS:
            return J({"ok": False, "sessao_fechada": True, "sessao_id": corpo.get("sessao_id"),
                      "erro": "sessão já fechada"}, 409)
        ADITIVOS_RECEBIDOS.append(corpo)
        ADITIVO["seq"] += 1
        return J({"ok": True, "etiqueta": {"id": f"S0000{ADITIVO['seq']}", "material_key": corpo.get("materialKey"),
                  "material_nome": "CARBONATO", "cor": None, "fornecedor": corpo.get("fornecedor"), "lote": "SACOS",
                  "peso": 25 * (corpo.get("qtd_sacos") or 0), "qtd_sacos": corpo.get("qtd_sacos")}})
    if p == "/catalogo-mp":
        return J({"ok": True, "materiais": []})
    return J({"ok": True})


CPU_LENTA = float(os.environ.get("CPU_LENTA") or 1)
PULAR = set((os.environ.get("PULAR") or "").split(","))   # cenários a pular (só para provar a tela antiga)
ESPERA_MS = int(8000 * max(1, CPU_LENTA / 2))     # teto de cada espera por estado
CDP = {}


def leitor(pg, codigo, enter=True, soluco=None, t0=None):
    """Leitor: rajada com carimbo de 4 ms entre teclas (o do HS-960) + Enter.
    O carimbo é da fonte: com a página lenta as teclas chegam atrasadas ao
    JavaScript, mas o e.timeStamp continua sendo o da rajada. soluco=(k, s):
    o Windows segurou a rajada s segundos antes da tecla k. t0: carimbo da 1ª
    tecla (para emendar no bipe anterior sem depender de quanto o CDP demorou
    para mandar o anterior com a VPS carregada). Devolve o carimbo da última."""
    cdp = CDP["s"]; t0 = time.time() if t0 is None else t0
    if soluco:
        time.sleep(soluco[1])   # o carimbo não pode ficar no futuro
        t0 -= soluco[1]
    extra = lambda i: soluco[1] if soluco and i >= soluco[0] else 0
    for i, ch in enumerate(codigo):
        t = t0 + i * 0.004 + extra(i)
        cdp.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": ch, "text": ch, "unmodifiedText": ch,
                                            "windowsVirtualKeyCode": ord(ch.upper()), "timestamp": t})
        cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": ch,
                                            "windowsVirtualKeyCode": ord(ch.upper()), "timestamp": t + 0.001})
    t = t0 + (len(codigo) - 1) * 0.004 + extra(len(codigo) - 1)
    if enter:
        t = t0 + len(codigo) * 0.004 + extra(len(codigo))
        cdp.send("Input.dispatchKeyEvent", {"type": "keyDown", "key": "Enter", "code": "Enter", "text": "\r",
                                            "unmodifiedText": "\r", "windowsVirtualKeyCode": 13, "timestamp": t})
        cdp.send("Input.dispatchKeyEvent", {"type": "keyUp", "key": "Enter", "code": "Enter",
                                            "windowsVirtualKeyCode": 13, "timestamp": t + 0.001})
    return t


bipar = leitor


def ativo(pg, mid):
    return pg.evaluate(f"document.getElementById('{mid}').classList.contains('ativo')")


def fechar_tudo(pg):
    pg.evaluate("""() => { ['modal-fora','modal-bloqueado','keypad-modal'].forEach(id => {
        const el = document.getElementById(id); if (el && el.classList.contains('ativo')) {
          if (id === 'modal-fora' && window.fecharFora) fecharFora(null);
          else if (id === 'modal-bloqueado' && window.fecharBloqueio) fecharBloqueio();
          else el.classList.remove('ativo'); } }); }""")
    # Espera a fila do leitor esvaziar (o que ficou para trás não vaza para o
    # próximo cenário), em vez de um tempo fixo.
    ate(pg, lambda: pg.evaluate("""(typeof _itensNaFila !== 'undefined' ? _itensNaFila
                                     : (typeof _bipesNaFila !== 'undefined' ? _bipesNaFila : 0)) === 0"""))
    pg.wait_for_timeout(100)


def ids():
    return [c[0] for c in CONSUMIDOS]


def toasts(pg):
    return pg.evaluate("[...document.querySelectorAll('#toast-wrap .toast')].map(t=>t.textContent).join(' | ')")


def clicar(pg, sel, esperar=100):
    """Clica se der; na tela antiga a janela pode nem ter aberto — o teste
    segue e marca a falha nas conferências, em vez de parar no 1º erro."""
    try:
        pg.click(sel, timeout=ESPERA_MS)
    except Exception:
        print(f"  (não deu para clicar em {sel})")
    pg.wait_for_timeout(esperar)


def ate(pg, cond, ms=None):
    """Espera cond() virar verdade (até ms): com a VPS carregada (ou a CPU
    lenta) a fila leva mais que qualquer tempo fixo — o teste espera o estado."""
    fim = time.time() + (ms or ESPERA_MS) / 1000
    while True:
        soltar_atrasadas()
        if cond() or time.time() >= fim:
            break
        pg.wait_for_timeout(100)
    return cond()


def soltar_atrasadas():
    agora = time.time()
    for item in [a for a in ATRASADAS if a[0] <= agora]:
        ATRASADAS.remove(item)
        rota(item[1])


def responder_motivo(pg):
    clicar(pg, "#fora-motivos button[data-motivo='Bag do lote pedido não está no estoque']")


def lido(pg, cod):
    """O bipe chegou à fila e avisou que espera (prova de que foi lido)."""
    return ate(pg, lambda: f"{cod} lido" in toasts(pg))


with sync_playwright() as p:
    nav = _navegador(p)
    ctx = nav.new_context(viewport={"width": 1366, "height": 768})
    ctx.add_init_script("window.EKO_TETO_FETCH_MS = 2500;")
    pg = ctx.new_page(); erros = []
    pg.on("pageerror", lambda e: erros.append(str(e)))
    pg.route("**/*", rota)
    CDP["s"] = ctx.new_cdp_session(pg)
    if CPU_LENTA > 1:
        CDP["s"].send("Emulation.setCPUThrottlingRate", {"rate": CPU_LENTA})
        print(f"(CPU da página {CPU_LENTA:g}x mais lenta)")
    pg.goto("http://eko.teste/mp-retirada.html")
    ate(pg, lambda: pg.evaluate("typeof teclaDoLeitor === 'function' && document.readyState === 'complete'"))
    pg.wait_for_timeout(300)

    print("== 1. dois bipes juntos, os dois fora do pedido")
    bipar(pg, "R0000101"); bipar(pg, "R0000102")
    ok(ate(pg, lambda: ativo(pg, "modal-fora") and "R0000101" in pg.inner_text("#fora-info")),
       "janela aberta para o 1º bag (R0000101)")
    ok(ids() == [], "nenhum saiu ainda")
    ok(lido(pg, "R0000102"), f"o 2º avisa que está esperando a janela do 1º ({toasts(pg)[:90]})")
    responder_motivo(pg)
    ok(ate(pg, lambda: "R0000101" in ids()), "1º saiu com o motivo")
    ok(ate(pg, lambda: ativo(pg, "modal-fora") and "R0000102" in pg.inner_text("#fora-info")),
       "e a janela do 2º abriu em seguida")
    responder_motivo(pg)
    ok(ate(pg, lambda: len(ids()) >= 2) and ids() == ["R0000101", "R0000102"], f"os dois saíram, na ordem ({ids()})")

    fechar_tudo(pg)
    print("== 2. bipe com a janela de motivo aberta")
    CONSUMIDOS.clear()
    bipar(pg, "R0000103")
    ok(ate(pg, lambda: ativo(pg, "modal-fora")), "janela de motivo aberta (R0000103)")
    bipar(pg, "R0000401")
    ok(ate(pg, lambda: "R0000401" in toasts(pg) and "espera" in toasts(pg)),
       f"aviso visível de que está esperando ({toasts(pg)[:90]})")
    ok("R0000401" not in ids(), "bag normal bipado com a janela aberta ainda não saiu (espera)")
    pg.screenshot(path=str(OUT / "retirada_bipe_esperando.png"))
    clicar(pg, "#modal-fora .btn-fechar")   # CANCELAR · NÃO RETIRAR
    ok(ate(pg, lambda: "R0000401" in ids()) and "R0000103" not in ids(),
       f"cancelou o fora; o bipe que esperava saiu ({ids()})")

    fechar_tudo(pg)
    print("== 3. bipe com a janela JÁ FOI RETIRADA aberta")
    CONSUMIDOS.clear()
    bipar(pg, "R0000201")
    ok(ate(pg, lambda: ativo(pg, "modal-bloqueado")), "janela JÁ FOI RETIRADA aberta")
    bipar(pg, "R0000402")
    lido(pg, "R0000402")
    ok("R0000402" not in ids(), "bipe com ela aberta espera")
    clicar(pg, "#modal-bloqueado .btn-fechar")
    ok(ate(pg, lambda: "R0000402" in ids()), "fechou a janela: o bipe saiu")

    fechar_tudo(pg)
    print("== 4. Enter do leitor com botão em foco")
    CONSUMIDOS.clear()
    pg.evaluate("document.querySelector(\"button[onclick='simularBipe()']\").focus()")
    bipar(pg, "R0000403")
    ok(ate(pg, lambda: "R0000403" in ids()), "e o bipe saiu")
    ok(not ativo(pg, "keypad-modal"), "sem janela: o Enter não 'clicou' em Digitar código")
    bipar(pg, "R0000105")
    ate(pg, lambda: ativo(pg, "modal-fora"))
    pg.evaluate("document.querySelector(\"button[onclick='reimprimirEtiqueta()']\").focus()")
    bipar(pg, "R0000404")
    lido(pg, "R0000404")
    ok(not ativo(pg, "keypad-modal"), "com janela aberta: o Enter não 'clicou' no Reimprimir atrás dela")
    responder_motivo(pg)
    ok(ate(pg, lambda: len(ids()) >= 3) and ids() == ["R0000403", "R0000105", "R0000404"], f"tudo saiu na ordem ({ids()})")

    fechar_tudo(pg)
    print("== 5. 'Outro motivo…' aberto e o leitor bipando")
    CONSUMIDOS.clear()
    bipar(pg, "R0000106")
    ate(pg, lambda: ativo(pg, "modal-fora"))
    clicar(pg, "#fora-motivos button[data-motivo='__outro']")
    ate(pg, lambda: pg.evaluate("document.activeElement && document.activeElement.id === 'fora-outro'"))
    # Gente digitando um código + Enter na caixa: é texto do motivo, não bipe.
    pg.keyboard.type("R0000498", delay=120); pg.keyboard.press("Enter")
    pg.wait_for_timeout(500)
    val = pg.evaluate("document.getElementById('fora-outro').value")
    ok(val == "R0000498" and "R0000498" not in toasts(pg) and not [e for e in EVENTOS if e[1] == "R0000498"],
       f"código DIGITADO por gente fica no motivo, não vira bipe ({val!r})")
    pg.fill("#fora-outro", "")
    pg.keyboard.type("lote errado", delay=200)       # gente digitando
    bipar(pg, "R0000405")                            # leitor no meio
    ok(lido(pg, "R0000405"), "o bipe no meio do motivo foi lido e espera a janela")
    val = pg.evaluate("document.getElementById('fora-outro').value")
    ok(val == "lote errado", f"o código bipado não ficou no motivo ({val!r})")
    ok("R0000405" not in ids(), "o bipe ficou esperando a janela")
    clicar(pg, "#fora-outro-ok")
    ate(pg, lambda: len(ids()) >= 2)
    mot = next((c[1].get("fora_do_pedido", {}).get("motivo") for c in CONSUMIDOS if c[0] == "R0000106"), None)
    ok(mot == "lote errado", f"o motivo foi o digitado ({mot!r})")
    ok(ids() == ["R0000106", "R0000405"], f"e o bipe saiu depois ({ids()})")

    fechar_tudo(pg)
    print("== 5b. 'Outro motivo…': rajada com um soluço de 150 ms no meio (Mini PC ocupado)")
    CONSUMIDOS.clear()
    bipar(pg, "R0000106")
    ate(pg, lambda: ativo(pg, "modal-fora"))
    clicar(pg, "#fora-motivos button[data-motivo='__outro']")
    ate(pg, lambda: pg.evaluate("document.activeElement && document.activeElement.id === 'fora-outro'"))
    pg.keyboard.type("lote errado", delay=200)
    leitor(pg, "R0000415", soluco=(4, 0.15))
    ok(lido(pg, "R0000415"), "mesmo com o soluço, o código virou bipe")
    val = pg.evaluate("document.getElementById('fora-outro').value")
    ok(val == "lote errado", f"e não ficou no motivo ({val!r})")
    clicar(pg, "#fora-outro-ok")
    ok(ate(pg, lambda: len(ids()) >= 2) and ids() == ["R0000106", "R0000415"], f"e saiu depois do motivo ({ids()})")

    fechar_tudo(pg)
    print("== 6. /consumir que nunca responde")
    CONSUMIDOS.clear()
    n0 = len(PENDURADAS)
    bipar(pg, "R0000301"); bipar(pg, "R0000406")
    ate(pg, lambda: len(PENDURADAS) > n0)            # o 1º chegou ao servidor e ficou pendurado
    pg.wait_for_timeout(300)
    ok(ids() == [], "com o 1º pendurado, o 2º espera")
    ok(ate(pg, lambda: "confira se saiu" in toasts(pg)), f"passado o teto, avisa 'confira se saiu' ({toasts(pg)[:120]})")
    ok(ate(pg, lambda: "R0000406" in ids()), "e a fila andou: o 2º saiu")

    fechar_tudo(pg)
    print("== 6b. dois bipes normais seguidos, sem janela")
    CONSUMIDOS.clear()
    bipar(pg, "R0000411"); bipar(pg, "R0000412")
    ok(ate(pg, lambda: len(ids()) >= 2) and ids() == ["R0000411", "R0000412"], f"os dois saíram ({ids()})")
    ok("R0000412 lido" not in toasts(pg), "sem janela, nenhum aviso de espera à toa")

    fechar_tudo(pg)
    print("== 7. buffer do leitor: sobra sem Enter e Enter perdido")
    CONSUMIDOS.clear()
    leitor(pg, "R0000410", enter=False)              # leitura sem Enter (perdido)
    pg.wait_for_timeout(1300)                        # 1 s sem tecla (pelo carimbo): a sobra some
    bipar(pg, "R0000407")
    ate(pg, lambda: "R0000407" in ids()); pg.wait_for_timeout(200)
    ok(ids() == ["R0000407"], f"sobra sem Enter descartada: saiu só o bipe novo ({ids()})")
    CONSUMIDOS.clear()
    t = leitor(pg, "R0000408", enter=False)          # Enter deste bipe se perdeu
    bipar(pg, "R0000409", t0=t + 0.3)                # e 0,3 s depois (pelo carimbo) vem o próximo
    ate(pg, lambda: len(ids()) >= 2)
    ok(ids() == ["R0000408", "R0000409"], f"Enter perdido: os dois códigos saem, na ordem ({ids()})")

    fechar_tudo(pg)
    print("== 8. bipe com a confirmação de FINALIZAR aberta")
    CONSUMIDOS.clear(); EVENTOS.clear()
    sid = pg.evaluate("estado.sessaoId")
    clicar(pg, "#btn-finalizar")
    ok(ate(pg, lambda: ativo(pg, "modal-confirmar")), "confirmação de finalizar aberta")
    bipar(pg, "R0000421")
    lido(pg, "R0000421")
    ok("R0000421" not in ids(), "bipe com a confirmação aberta espera")
    clicar(pg, "#conf-ok")
    ate(pg, lambda: "R0000421 NÃO saiu" in toasts(pg) or "R0000421" in ids())
    na_fechada = [e for e in EVENTOS if e[0] == "consumir" and e[1] == "R0000421" and e[2] == sid]
    ok(not na_fechada, f"o bipe NÃO foi na sessão #{sid}, que estava fechando ({EVENTOS})")
    ok(("fechar", sid) in EVENTOS, "a sessão foi finalizada")
    ok("R0000421" not in ids() and "NÃO saiu" in toasts(pg),
       f"com a senha pedida depois, o bag não sai e avisa ({toasts(pg)[:140]})")
    pg.evaluate("window._bloq = false")             # alguém entrou com a senha
    bipar(pg, "R0000422")
    ate(pg, lambda: "R0000422" in ids())
    novo = pg.evaluate("estado.sessaoId")
    ok("R0000422" in ids() and novo and novo != sid, f"o bipe seguinte sai numa sessão nova (#{novo})")

    fechar_tudo(pg)
    print("== 8b. bipe com a confirmação de CANCELAR aberta")
    CONSUMIDOS.clear(); EVENTOS.clear()
    sid = pg.evaluate("estado.sessaoId")
    clicar(pg, "#btn-cancelar")
    ok(ate(pg, lambda: ativo(pg, "modal-confirmar")), "confirmação de cancelar aberta")
    bipar(pg, "R0000423")
    lido(pg, "R0000423")
    clicar(pg, "#conf-ok")
    ate(pg, lambda: "R0000423 NÃO saiu" in toasts(pg) or "R0000423" in ids())
    ok(not [e for e in EVENTOS if e[0] == "consumir" and e[2] == sid],
       f"o bipe NÃO foi na sessão cancelada #{sid} ({EVENTOS})")
    ok("R0000423" not in ids() and "NÃO saiu" in toasts(pg), "e avisa que não saiu")
    pg.evaluate("window._bloq = false")

    fechar_tudo(pg)
    print("== 9. teclado da tela aberto e o leitor bipando")
    CONSUMIDOS.clear()
    clicar(pg, "button[onclick='simularBipe()']")
    ok(ate(pg, lambda: ativo(pg, "keypad-modal")), "teclado 'Digitar código' aberto")
    clicar(pg, "#keypad-modal .kp-grid button:has-text('1')")   # foco fica no '1'
    bipar(pg, "R0000440")
    ate(pg, lambda: "R0000440 NÃO saiu" in toasts(pg))
    disp = pg.inner_text("#keypad-display").strip()
    ok(disp == "R1", f"o Enter do leitor não apertou o botão em foco (visor {disp!r})")
    ok("R0000440" not in ids() and "NÃO saiu" in toasts(pg), f"o bipe não saiu e avisa ({toasts(pg)[:120]})")
    pg.evaluate("kpCancel()"); pg.wait_for_timeout(200)

    fechar_tudo(pg)
    print("== 10. depois do teto a lista é relida; já retirado NESTA sessão")
    bipar(pg, "R0000460")                           # garante uma retirada aberta nesta tela
    ate(pg, lambda: "R0000460" in ids())
    CONSUMIDOS.clear()
    antes = CHAMADAS["sessao"]
    sid10 = pg.evaluate("estado.sessaoId")
    ok(sid10 is not None, f"retirada aberta nesta tela (#{sid10})")
    OUTRA["ligada"] = True                          # outra pessoa abriu uma retirada mais nova
    bipar(pg, "R0000301")
    ok(ate(pg, lambda: CHAMADAS["sessao"] > antes), "passado o teto, a tela relê a sessão DELA do servidor")
    ok(pg.evaluate("estado.sessaoId") == sid10, f"e não adota a retirada da outra pessoa (#{pg.evaluate('estado.sessaoId')})")
    ok(ate(pg, lambda: pg.evaluate("estado.itens.some(i => i.origId === 'R0000301')")),
       "o bag gravado no servidor durante o teto entra na lista")
    ok(pg.evaluate("!document.getElementById('btn-finalizar').disabled"), "e o Finalizar fica ligado")
    bipar(pg, "R0000202")
    ok(ate(pg, lambda: "já está nesta retirada" in toasts(pg)), f"avisa que já está na lista ({toasts(pg)[:120]})")
    ok(not ativo(pg, "modal-bloqueado"), "já saiu nesta retirada: sem janela de bloqueio")

    fechar_tudo(pg)
    print("== 11. servidor diz que a sessão já fechou")
    CONSUMIDOS.clear()
    sid = pg.evaluate("estado.sessaoId")
    FECHADAS.add(sid)
    bipar(pg, "R0000430")
    ate(pg, lambda: "R0000430" in ids())
    cons = [c for c in CONSUMIDOS if c[0] == "R0000430"]
    ok(cons and cons[0][1].get("sessao_id") not in FECHADAS,
       f"abriu outra sessão e o bag saiu nela ({cons})")
    ok("já tinha sido fechada" in toasts(pg), "e avisa que a anterior tinha fechado")
    OUTRA["ligada"] = False

    fechar_tudo(pg)
    print("== 11b. sessão fecha enquanto a janela de motivo está aberta")
    CONSUMIDOS.clear()
    bipar(pg, "R0000102")
    ok(ate(pg, lambda: ativo(pg, "modal-fora")), "janela de motivo aberta")
    sid = pg.evaluate("estado.sessaoId"); FECHADAS.add(sid)     # outra aba fechou a sessão
    responder_motivo(pg)
    ate(pg, lambda: "R0000102" in ids())
    cons = [c for c in CONSUMIDOS if c[0] == "R0000102"]
    ok(cons and cons[0][1].get("sessao_id") not in FECHADAS and cons[0][1].get("fora_do_pedido"),
       f"com o motivo, saiu numa sessão nova ({cons})")

    fechar_tudo(pg)
    print("== 12. bipe durante o envio ao Bling, sem janela na tela")
    CONSUMIDOS.clear()
    pg.evaluate("document.querySelectorAll('#toast-wrap .toast').forEach(t => t.remove())")   # 'NÃO saiu' do 8b/9 não vale aqui
    SEGURAR["ligado"] = True
    clicar(pg, "#btn-finalizar")
    ate(pg, lambda: ativo(pg, "modal-confirmar"))
    clicar(pg, "#conf-ok")
    ate(pg, lambda: len(SEGURAR["rotas"]) > 0)      # o envio chegou ao servidor e fica no ar
    bipar(pg, "R0000450")
    ok(ate(pg, lambda: "espera o envio ao Bling" in toasts(pg)), f"avisa que espera o envio ({toasts(pg)[-160:]})")
    ok("R0000450" not in ids(), "e não sai enquanto o envio está no ar")
    SEGURAR["ligado"] = False
    for r in SEGURAR["rotas"]:
        r.fulfill(status=200, content_type="application/json",
                  body=json.dumps({"ok": True, "bling": {"ok": True, "modo": "simulacao"}}))
    SEGURAR["rotas"].clear()
    ate(pg, lambda: "R0000450 NÃO saiu" in toasts(pg) or "R0000450" in ids())
    ok("R0000450" not in ids() and "NÃO saiu" in toasts(pg), "terminado o envio, a tela pede a senha e avisa que não saiu")
    pg.evaluate("window._bloq = false")

    def tocar_aditivo(pg, sacos=2):
        """Pessoa escolhe Dessecante/Karina, põe N sacos e toca ADICIONAR."""
        pg.evaluate(f"""() => {{ estado.tipo = 'DESSEC'; estado.fornecedor = 'Karina'; estado.cor = null;
            document.getElementById('sacos-input').value = {sacos}; ajustarSacos(0); adicionarAditivo(); }}""")

    def limpar_toasts(pg):
        pg.evaluate("document.querySelectorAll('#toast-wrap .toast').forEach(t => t.remove())")

    fechar_tudo(pg)
    if "13" in PULAR:
        # Na tela antiga o 13 trava a fila para sempre e derruba 14-16 em
        # cascata; PULAR=13 prova cada um deles por conta própria.
        bipar(pg, "R0000470"); ate(pg, lambda: "R0000470" in ids())
    else:
        print("== 13. aditivo com a rede pendurada e um bipe logo atrás")
        CONSUMIDOS.clear(); limpar_toasts(pg)
        n0 = len(PENDURADAS)
        ADITIVO["pendurar"] = 1
        tocar_aditivo(pg)
        ok(ate(pg, lambda: len(PENDURADAS) > n0), "o aditivo chegou ao servidor e ficou sem resposta")
        bipar(pg, "R0000470")
        ok(ate(pg, lambda: "R0000470 lido" in toasts(pg) and "espera" in toasts(pg)),
           f"o bipe atrás do aditivo avisa que espera ({toasts(pg)[-140:]})")
        ok(ate(pg, lambda: "R0000470" in ids()), "passado o teto do aditivo, o bipe sai (a fila não trava)")
        ok("confira na lista" in toasts(pg), f"e o aditivo avisa para conferir na lista ({toasts(pg)[-160:]})")

    fechar_tudo(pg)
    print("== 14. aditivo na fila quando confirmam o FINALIZAR")
    CONSUMIDOS.clear(); EVENTOS.clear(); limpar_toasts(pg)
    sid = pg.evaluate("estado.sessaoId")
    ok(sid is not None and pg.evaluate("estado.itens.length > 0"), f"retirada aberta com itens (#{sid})")
    SEGURAR["ligado"] = True
    bipar(pg, "R0000480")                           # bipe no ar (resposta demora 1,5 s)
    ate(pg, lambda: len(ATRASADAS) > 0)
    tocar_aditivo(pg)                               # aditivo na fila atrás dele
    clicar(pg, "#btn-finalizar", esperar=0)
    clicar(pg, "#conf-ok", esperar=0)
    ok(ate(pg, lambda: len(SEGURAR["rotas"]) > 0), "o envio ao Bling chegou ao servidor (e fica no ar)")
    pg.wait_for_timeout(500)
    na_fechada = [e for e in EVENTOS if e[0] == "aditivo" and e[2] == sid]
    ok(not na_fechada, f"o aditivo NÃO foi na sessão #{sid}, que estava fechando ({EVENTOS})")
    SEGURAR["ligado"] = False
    for r in SEGURAR["rotas"]:
        r.fulfill(status=200, content_type="application/json",
                  body=json.dumps({"ok": True, "bling": {"ok": True, "modo": "simulacao"}}))
    SEGURAR["rotas"].clear()
    ok(ate(pg, lambda: "NÃO foi lançado" in toasts(pg)),
       f"com a senha pedida depois, o aditivo não é lançado e avisa ({toasts(pg)[-160:]})")
    ok(not [e for e in EVENTOS if e[0] == "aditivo"], f"nenhum aditivo foi ao servidor ({EVENTOS})")
    ok(pg.evaluate("estado.sacos") == 2, f"e o contador volta para 2 ({pg.evaluate('estado.sacos')})")
    pg.evaluate("window._bloq = false")

    fechar_tudo(pg)
    print("== 15. aditivo tocado com a janela de motivo aberta")
    CONSUMIDOS.clear(); ADITIVOS_RECEBIDOS.clear(); limpar_toasts(pg)
    pg.evaluate("document.getElementById('sacos-input').value = 0; ajustarSacos(0)")
    bipar(pg, "R0000103")
    ok(ate(pg, lambda: ativo(pg, "modal-fora")), "janela de motivo aberta (R0000103)")
    tocar_aditivo(pg, 2)
    ok(ate(pg, lambda: "Dessecante na fila" in toasts(pg)), f"o aditivo avisa que está na fila ({toasts(pg)[-140:]})")
    ok(pg.evaluate("estado.sacos") == 0, "o contador zerou no toque (2º toque não lança de novo)")
    pg.evaluate("document.getElementById('sacos-input').value = 5; ajustarSacos(0)")   # pessoa mexe no contador
    responder_motivo(pg)
    ok(ate(pg, lambda: len(ADITIVOS_RECEBIDOS) >= 1), "o aditivo foi lançado depois da janela")
    q = ADITIVOS_RECEBIDOS[0].get("qtd_sacos") if ADITIVOS_RECEBIDOS else None
    ok(q == 2, f"com os sacos do TOQUE (2), não os de agora (5) ({q})")
    pg.evaluate("document.getElementById('sacos-input').value = 0; ajustarSacos(0)")

    fechar_tudo(pg)
    print("== 16. 'Outro motivo…' com o Enter do 1º código perdido")
    CONSUMIDOS.clear(); limpar_toasts(pg)
    bipar(pg, "R0000106")
    ate(pg, lambda: ativo(pg, "modal-fora"))
    clicar(pg, "#fora-motivos button[data-motivo='__outro']")
    ate(pg, lambda: pg.evaluate("document.activeElement && document.activeElement.id === 'fora-outro'"))
    pg.keyboard.type("lote errado", delay=200)
    leitor(pg, "R0000416", enter=False)              # o Enter deste se perdeu
    pg.wait_for_timeout(300)                         # a pessoa pega o próximo bag
    leitor(pg, "R0000417")
    ok(lido(pg, "R0000416") and lido(pg, "R0000417"), f"os dois códigos foram lidos ({toasts(pg)[-160:]})")
    val = pg.evaluate("document.getElementById('fora-outro').value")
    ok(val == "lote errado", f"nenhum ficou no motivo ({val!r})")
    clicar(pg, "#fora-outro-ok")
    ok(ate(pg, lambda: len(ids()) >= 3) and ids() == ["R0000106", "R0000416", "R0000417"],
       f"e saíram depois do motivo, na ordem ({ids()})")

    ok(not erros, f"sem erro de JavaScript ({erros[:2]})")
    pg.screenshot(path=str(OUT / "retirada_leitor_fim.png"))
    pg.unroute("**/*")
    for r in PENDURADAS:                             # solta o que ficou pendurado de propósito
        try: r.abort()
        except Exception: pass
    nav.close()

print(f"\n{'OK' if not falhas else str(len(falhas)) + ' falha(s)'}")
sys.exit(1 if falhas else 0)
