"""Gera o PDF A4 do POP a partir do pop.html desta pasta.
Uso: python3 gerar_pdf.py <saida.pdf>
Usa o Chromium do Playwright com as libs de ~/bling-claude/.chrome-libs."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path.home() / "bling-claude"))
from playwright.sync_api import sync_playwright
from recorte_extrusao_operador import _navegador

AQUI = Path(__file__).resolve().parent
saida = Path(sys.argv[1])
with sync_playwright() as pw:
    br = _navegador(pw)
    # Largura útil do A4 (210 − 2×10 mm de margem) = 190 mm ≈ 718 px: a medida
    # abaixo só vale com o texto quebrando igual ao PDF.
    pg = br.new_page(viewport={"width": 718, "height": 1051})
    pg.goto((AQUI / "pop.html").as_uri())
    pg.wait_for_load_state("networkidle")
    # .folha tem overflow:hidden: o que passar da folha some calado no PDF.
    pg.emulate_media(media="print")
    cheias = pg.evaluate("""[...document.querySelectorAll('.folha')].map((f, i) => {
        const fim = f.getBoundingClientRect().bottom + 1;
        return [...f.querySelectorAll('*')].some(e => e.getBoundingClientRect().bottom > fim) ? i + 1 : 0;
    }).filter(Boolean)""")
    if cheias:
        br.close()
        sys.exit(f"ERRO: folha(s) {cheias} passam do A4 — diminua imagem ou texto")
    pg.pdf(path=str(saida), format="A4", print_background=True, prefer_css_page_size=True)
    br.close()
print(saida)
