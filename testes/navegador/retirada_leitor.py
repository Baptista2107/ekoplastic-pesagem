"""Teste de navegador do LEITOR na tela de Retirada de MP (16/11/2026).

Roda na VPS (Playwright + Chromium de lá), com a API do Mini PC FALSA (rotas
interceptadas): não grava nada. Não entra no rodar-todos.js (o Mini PC não tem
navegador de teste).

    cd ~/bling-claude && venv/bin/python <repo pesagem>/testes/navegador/retirada_leitor.py \
        <repo pesagem>/public /tmp/prints

O leitor manda os caracteres + Enter como teclado USB. Confere, em 1366x768:
  1. dois bipes juntos de bags fora do pedido: um de cada vez, cada um com a
     sua janela; nenhum some;
  2. bipe com a janela de motivo ABERTA: não some — espera, avisa, e sai depois
     da resposta (antes um `return` jogava o código fora e o bag saía do
     barracão sem S);
  3. bipe com a janela "JÁ FOI RETIRADA" aberta: espera ela fechar e sai;
  4. Enter do leitor com um botão em foco (com e sem janela): não clica nele;
  5. "Outro motivo…" aberto: o código bipado não entra no texto do motivo e
     vira bipe na fila;
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
O item 10 relê a sessão DESTA tela, nunca adota a retirada aberta mais nova
de outra pessoa (3ª revisão, item 3).
Na tela de antes (c302b11) falha nos itens 1-7; no 5dd9c56, em 7-12. Sai 1 se falhar."""
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
CONSUMIDOS = []          # (id, corpo) dos /consumir que deram saída
FECHADAS = set()         # sessões que o servidor falso já fechou
SESS = {"prox": 777}
EVENTOS = []             # ('consumir', id, sessao) / ('fechar', sessao) na ordem em que chegaram
CHAMADAS = {"abertas": 0, "sessao": 0}
OUTRA = {"ligada": False}   # /sessoes/abertas passa a ter uma retirada mais nova de OUTRA pessoa
SEGURAR = {"ligado": False, "rotas": []}   # finalizar fica no ar até o teste soltar
PENDURADAS = []          # rotas que ficaram sem resposta de propósito
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
        ets = [dict(etiq(i), id="S" + i[1:], ref_id=i, tipo="retirada") for i, c in CONSUMIDOS if c.get("sessao_id") == sid]
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
        if i in TRAVA:
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
    if p == "/catalogo-mp":
        return J({"ok": True, "materiais": []})
    return J({"ok": True})


def bipar(pg, codigo, esperar=250):
    """Leitor: rajada de teclas (sem atraso) + Enter."""
    pg.keyboard.type(codigo)
    pg.keyboard.press("Enter")
    pg.wait_for_timeout(esperar)


def ativo(pg, mid):
    return pg.evaluate(f"document.getElementById('{mid}').classList.contains('ativo')")


def fechar_tudo(pg):
    pg.evaluate("""() => { ['modal-fora','modal-bloqueado','keypad-modal'].forEach(id => {
        const el = document.getElementById(id); if (el && el.classList.contains('ativo')) {
          if (id === 'modal-fora' && window.fecharFora) fecharFora(null);
          else if (id === 'modal-bloqueado' && window.fecharBloqueio) fecharBloqueio();
          else el.classList.remove('ativo'); } }); }""")
    pg.wait_for_timeout(600)


def ids():
    return [c[0] for c in CONSUMIDOS]


def toasts(pg):
    return pg.evaluate("[...document.querySelectorAll('#toast-wrap .toast')].map(t=>t.textContent).join(' | ')")


def clicar(pg, sel, esperar=350):
    """Clica se der; na tela antiga a janela pode nem ter aberto — o teste
    segue e marca a falha nas conferências, em vez de parar no 1º erro."""
    try:
        pg.click(sel, timeout=2000)
    except Exception:
        print(f"  (não deu para clicar em {sel})")
    pg.wait_for_timeout(esperar)


def ate(pg, cond, ms=3000):
    """Espera cond() virar verdade (até ms): com a VPS carregada a fila leva
    mais que os 500 ms fixos — o teste não pode depender do relógio da máquina."""
    fim = time.time() + ms / 1000
    while not cond() and time.time() < fim:
        pg.wait_for_timeout(100)
    return cond()


def responder_motivo(pg):
    clicar(pg, "#fora-motivos button[data-motivo='Bag do lote pedido não está no estoque']")


with sync_playwright() as p:
    nav = _navegador(p)
    ctx = nav.new_context(viewport={"width": 1366, "height": 768})
    ctx.add_init_script("window.EKO_TETO_FETCH_MS = 2500; window.EKO_LEITOR_MAX_MS = 110;")
    pg = ctx.new_page(); erros = []
    pg.on("pageerror", lambda e: erros.append(str(e)))
    pg.route("**/*", rota)
    pg.goto("http://eko.teste/mp-retirada.html"); pg.wait_for_timeout(700)

    print("== 1. dois bipes juntos, os dois fora do pedido")
    bipar(pg, "R0000101", 0); bipar(pg, "R0000102", 400)
    ok(ativo(pg, "modal-fora") and "R0000101" in pg.inner_text("#fora-info"), "janela aberta para o 1º bag (R0000101)")
    ok(ids() == [], "nenhum saiu ainda")
    pg.wait_for_timeout(600)
    ok("R0000102 lido" in toasts(pg), f"o 2º avisa que está esperando a janela do 1º ({toasts(pg)[:90]})")
    responder_motivo(pg)
    ok("R0000101" in ids(), "1º saiu com o motivo")
    ok(ativo(pg, "modal-fora") and "R0000102" in pg.inner_text("#fora-info"), "e a janela do 2º abriu em seguida")
    responder_motivo(pg)
    ok(ids() == ["R0000101", "R0000102"], f"os dois saíram, na ordem ({ids()})")

    fechar_tudo(pg)
    print("== 2. bipe com a janela de motivo aberta")
    CONSUMIDOS.clear()
    bipar(pg, "R0000103", 500)
    ok(ativo(pg, "modal-fora"), "janela de motivo aberta (R0000103)")
    bipar(pg, "R0000401", 400)
    ok("R0000401" not in ids(), "bag normal bipado com a janela aberta ainda não saiu (espera)")
    ok("R0000401" in toasts(pg) and "espera" in toasts(pg), f"aviso visível de que está esperando ({toasts(pg)[:90]})")
    pg.screenshot(path=str(OUT / "retirada_bipe_esperando.png"))
    clicar(pg, "#modal-fora .btn-fechar", 500)   # CANCELAR · NÃO RETIRAR
    ok("R0000103" not in ids() and "R0000401" in ids(), f"cancelou o fora; o bipe que esperava saiu ({ids()})")

    fechar_tudo(pg)
    print("== 3. bipe com a janela JÁ FOI RETIRADA aberta")
    CONSUMIDOS.clear()
    bipar(pg, "R0000201", 400)
    ok(ativo(pg, "modal-bloqueado"), "janela JÁ FOI RETIRADA aberta")
    bipar(pg, "R0000402", 400)
    ok("R0000402" not in ids(), "bipe com ela aberta espera")
    clicar(pg, "#modal-bloqueado .btn-fechar", 300)
    ok(ate(pg, lambda: "R0000402" in ids()), "fechou a janela: o bipe saiu")

    fechar_tudo(pg)
    print("== 4. Enter do leitor com botão em foco")
    CONSUMIDOS.clear()
    pg.evaluate("document.querySelector(\"button[onclick='simularBipe()']\").focus()")
    bipar(pg, "R0000403", 400)
    ok(not ativo(pg, "keypad-modal"), "sem janela: o Enter não 'clicou' em Digitar código")
    ok("R0000403" in ids(), "e o bipe saiu")
    bipar(pg, "R0000105", 500)
    pg.evaluate("document.querySelector(\"button[onclick='reimprimirEtiqueta()']\").focus()")
    bipar(pg, "R0000404", 400)
    ok(not ativo(pg, "keypad-modal"), "com janela aberta: o Enter não 'clicou' no Reimprimir atrás dela")
    responder_motivo(pg); pg.wait_for_timeout(300)
    ok(ids() == ["R0000403", "R0000105", "R0000404"], f"tudo saiu na ordem ({ids()})")

    fechar_tudo(pg)
    print("== 5. 'Outro motivo…' aberto e o leitor bipando")
    CONSUMIDOS.clear()
    bipar(pg, "R0000106", 500)
    clicar(pg, "#fora-motivos button[data-motivo='__outro']", 200)
    pg.keyboard.type("lote errado", delay=200)       # gente digitando (teto do teste: 110 ms)
    bipar(pg, "R0000405", 400)                       # leitor no meio
    val = pg.evaluate("document.getElementById('fora-outro').value")
    ok(val == "lote errado", f"o código bipado não ficou no motivo ({val!r})")
    ok("R0000405" not in ids(), "o bipe ficou esperando a janela")
    clicar(pg, "#fora-outro-ok", 500)
    mot = next((c[1].get("fora_do_pedido", {}).get("motivo") for c in CONSUMIDOS if c[0] == "R0000106"), None)
    ok(mot == "lote errado", f"o motivo foi o digitado ({mot!r})")
    ok(ids() == ["R0000106", "R0000405"], f"e o bipe saiu depois ({ids()})")

    fechar_tudo(pg)
    print("== 6. /consumir que nunca responde")
    CONSUMIDOS.clear()
    bipar(pg, "R0000301", 0); bipar(pg, "R0000406", 300)
    ok(ids() == [], "com o 1º pendurado, o 2º espera")
    pg.wait_for_timeout(3200)                        # teto de teste: 2,5 s
    ok("confira se saiu" in toasts(pg), f"passado o teto, avisa 'confira se saiu' ({toasts(pg)[:120]})")
    ok("R0000406" in ids(), "e a fila andou: o 2º saiu")

    fechar_tudo(pg)
    print("== 6b. dois bipes normais seguidos, sem janela")
    CONSUMIDOS.clear()
    bipar(pg, "R0000411", 0); bipar(pg, "R0000412", 1000)
    ok(ids() == ["R0000411", "R0000412"], f"os dois saíram ({ids()})")
    ok("R0000412 lido" not in toasts(pg), "sem janela, nenhum aviso de espera à toa")

    fechar_tudo(pg)
    print("== 7. buffer do leitor: sobra sem Enter e Enter perdido")
    CONSUMIDOS.clear()
    pg.keyboard.type("R0000410")                     # leitura sem Enter (perdido)
    pg.wait_for_timeout(1300)                        # 1 s sem tecla: a sobra some
    bipar(pg, "R0000407", 500)
    ok(ids() == ["R0000407"], f"sobra sem Enter descartada: saiu só o bipe novo ({ids()})")
    CONSUMIDOS.clear()
    pg.keyboard.type("R0000408")                     # Enter deste bipe se perdeu
    bipar(pg, "R0000409", 500)                       # e logo vem o próximo
    ok(ids() == ["R0000408", "R0000409"], f"Enter perdido: os dois códigos saem, na ordem ({ids()})")

    fechar_tudo(pg)
    print("== 8. bipe com a confirmação de FINALIZAR aberta")
    CONSUMIDOS.clear(); EVENTOS.clear()
    sid = pg.evaluate("estado.sessaoId")
    clicar(pg, "#btn-finalizar", 400)
    ok(ativo(pg, "modal-confirmar"), "confirmação de finalizar aberta")
    bipar(pg, "R0000421", 400)
    ok("R0000421" not in ids(), "bipe com a confirmação aberta espera")
    clicar(pg, "#conf-ok", 1200)
    na_fechada = [e for e in EVENTOS if e[0] == "consumir" and e[1] == "R0000421" and e[2] == sid]
    ok(not na_fechada, f"o bipe NÃO foi na sessão #{sid}, que estava fechando ({EVENTOS})")
    ok(("fechar", sid) in EVENTOS, "a sessão foi finalizada")
    ok("R0000421" not in ids() and "NÃO saiu" in toasts(pg),
       f"com a senha pedida depois, o bag não sai e avisa ({toasts(pg)[:140]})")
    pg.evaluate("window._bloq = false")             # alguém entrou com a senha
    bipar(pg, "R0000422", 600)
    novo = pg.evaluate("estado.sessaoId")
    ok("R0000422" in ids() and novo and novo != sid, f"o bipe seguinte sai numa sessão nova (#{novo})")

    fechar_tudo(pg)
    print("== 8b. bipe com a confirmação de CANCELAR aberta")
    CONSUMIDOS.clear(); EVENTOS.clear()
    sid = pg.evaluate("estado.sessaoId")
    clicar(pg, "#btn-cancelar", 400)
    ok(ativo(pg, "modal-confirmar"), "confirmação de cancelar aberta")
    bipar(pg, "R0000423", 400)
    clicar(pg, "#conf-ok", 1200)
    ok(not [e for e in EVENTOS if e[0] == "consumir" and e[2] == sid],
       f"o bipe NÃO foi na sessão cancelada #{sid} ({EVENTOS})")
    ok("R0000423" not in ids() and "NÃO saiu" in toasts(pg), "e avisa que não saiu")
    pg.evaluate("window._bloq = false")

    fechar_tudo(pg)
    print("== 9. teclado da tela aberto e o leitor bipando")
    CONSUMIDOS.clear()
    clicar(pg, "button[onclick='simularBipe()']", 300)
    ok(ativo(pg, "keypad-modal"), "teclado 'Digitar código' aberto")
    clicar(pg, "#keypad-modal .kp-grid button:has-text('1')", 200)   # foco fica no '1'
    bipar(pg, "R0000440", 500)
    disp = pg.inner_text("#keypad-display").strip()
    ok(disp == "R1", f"o Enter do leitor não apertou o botão em foco (visor {disp!r})")
    ok("R0000440" not in ids() and "NÃO saiu" in toasts(pg), f"o bipe não saiu e avisa ({toasts(pg)[:120]})")
    pg.evaluate("kpCancel()"); pg.wait_for_timeout(200)

    fechar_tudo(pg)
    print("== 10. depois do teto a lista é relida; já retirado NESTA sessão")
    bipar(pg, "R0000460", 600)                      # garante uma retirada aberta nesta tela
    CONSUMIDOS.clear()
    antes = CHAMADAS["sessao"]
    sid10 = pg.evaluate("estado.sessaoId")
    ok(sid10 is not None, f"retirada aberta nesta tela (#{sid10})")
    OUTRA["ligada"] = True                          # outra pessoa abriu uma retirada mais nova
    bipar(pg, "R0000301", 0)
    pg.wait_for_timeout(3200)
    ok(CHAMADAS["sessao"] > antes, "passado o teto, a tela relê a sessão DELA do servidor")
    ok(pg.evaluate("estado.sessaoId") == sid10, f"e não adota a retirada da outra pessoa (#{pg.evaluate('estado.sessaoId')})")
    bipar(pg, "R0000202", 700)
    ok(not ativo(pg, "modal-bloqueado"), "já saiu nesta retirada: sem janela de bloqueio")
    ok("já está nesta retirada" in toasts(pg), f"avisa que já está na lista ({toasts(pg)[:120]})")

    fechar_tudo(pg)
    print("== 11. servidor diz que a sessão já fechou")
    CONSUMIDOS.clear()
    sid = pg.evaluate("estado.sessaoId")
    FECHADAS.add(sid)
    bipar(pg, "R0000430", 900)
    cons = [c for c in CONSUMIDOS if c[0] == "R0000430"]
    ok(cons and cons[0][1].get("sessao_id") not in FECHADAS,
       f"abriu outra sessão e o bag saiu nela ({cons})")
    ok("já tinha sido fechada" in toasts(pg), "e avisa que a anterior tinha fechado")
    OUTRA["ligada"] = False

    fechar_tudo(pg)
    print("== 11b. sessão fecha enquanto a janela de motivo está aberta")
    CONSUMIDOS.clear()
    bipar(pg, "R0000102", 600)
    ok(ativo(pg, "modal-fora"), "janela de motivo aberta")
    sid = pg.evaluate("estado.sessaoId"); FECHADAS.add(sid)     # outra aba fechou a sessão
    responder_motivo(pg); pg.wait_for_timeout(600)
    cons = [c for c in CONSUMIDOS if c[0] == "R0000102"]
    ok(cons and cons[0][1].get("sessao_id") not in FECHADAS and cons[0][1].get("fora_do_pedido"),
       f"com o motivo, saiu numa sessão nova ({cons})")

    fechar_tudo(pg)
    print("== 12. bipe durante o envio ao Bling, sem janela na tela")
    CONSUMIDOS.clear()
    SEGURAR["ligado"] = True
    clicar(pg, "#btn-finalizar", 400)
    clicar(pg, "#conf-ok", 400)                   # o envio fica no ar
    bipar(pg, "R0000450", 600)
    ok("espera o envio ao Bling" in toasts(pg), f"avisa que espera o envio ({toasts(pg)[-160:]})")
    ok("R0000450" not in ids(), "e não sai enquanto o envio está no ar")
    SEGURAR["ligado"] = False
    for r in SEGURAR["rotas"]:
        r.fulfill(status=200, content_type="application/json",
                  body=json.dumps({"ok": True, "bling": {"ok": True, "modo": "simulacao"}}))
    SEGURAR["rotas"].clear()
    pg.wait_for_timeout(800)
    ok("R0000450" not in ids() and "NÃO saiu" in toasts(pg), "terminado o envio, a tela pede a senha e avisa que não saiu")
    pg.evaluate("window._bloq = false")

    ok(not erros, f"sem erro de JavaScript ({erros[:2]})")
    pg.screenshot(path=str(OUT / "retirada_leitor_fim.png"))
    pg.unroute("**/*")
    for r in PENDURADAS:                             # solta o que ficou pendurado de propósito
        try: r.abort()
        except Exception: pass
    nav.close()

print(f"\n{'OK' if not falhas else str(len(falhas)) + ' falha(s)'}")
sys.exit(1 if falhas else 0)
