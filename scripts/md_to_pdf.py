"""Render a design-doc Markdown file to a styled PDF, so the .md stays the single source.

Usage: python scripts/md_to_pdf.py docs/pr_review_design.md docs/pr_review_design.pdf
Requires: pip install reportlab

Supports the Markdown these docs use: #/##/### headings, paragraphs, "- " bullets,
"1. " numbered lists, pipe tables, fenced code blocks, **bold**, `code`, and [links](url).
A fenced block directly under a "### Architecture" heading is replaced by a drawn diagram
when the document has one registered in DIAGRAMS.
"""
import math
import re
import sys
from xml.sax.saxutils import escape

from reportlab.graphics.shapes import Drawing, Line, Polygon, Rect, String
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (KeepTogether, Paragraph, Preformatted, SimpleDocTemplate, Spacer, Table,
                                TableStyle)

INK = colors.HexColor("#1f2933")
MUTED = colors.HexColor("#5b6670")
ACCENT = colors.HexColor("#2f5d8a")
RULE = colors.HexColor("#d5dbe1")
FILL = colors.HexColor("#f2f5f8")
CODEBG = colors.HexColor("#f6f8fa")
CONTENT_WIDTH = letter[0] - 2 * inch

ss = getSampleStyleSheet()
base = ParagraphStyle("base", parent=ss["Normal"], fontName="Helvetica", fontSize=10, leading=14.5, textColor=INK,
                      spaceAfter=6, alignment=TA_LEFT)
title = ParagraphStyle("title", parent=base, fontName="Helvetica-Bold", fontSize=22, leading=27, spaceAfter=4)
subtitle = ParagraphStyle("subtitle", parent=base, fontSize=12, leading=16, textColor=MUTED, spaceAfter=14)
h1 = ParagraphStyle("h1", parent=base, fontName="Helvetica-Bold", fontSize=14, leading=18, textColor=ACCENT,
                    spaceBefore=14, spaceAfter=6)
h2 = ParagraphStyle("h2", parent=base, fontName="Helvetica-Bold", fontSize=11, leading=15, spaceBefore=8, spaceAfter=4)
bullet = ParagraphStyle("bullet", parent=base, leftIndent=14, bulletIndent=3, spaceAfter=3)
numbered = ParagraphStyle("numbered", parent=base, leftIndent=16, bulletIndent=2, spaceAfter=3)
small = ParagraphStyle("small", parent=base, fontSize=8.5, leading=11.5, textColor=MUTED)
cell = ParagraphStyle("cell", parent=base, fontSize=8.8, leading=12, spaceAfter=0)
cellb = ParagraphStyle("cellb", parent=cell, fontName="Helvetica-Bold")
code = ParagraphStyle("code", fontName="Courier", fontSize=8, leading=10.5, textColor=INK, backColor=CODEBG,
                      borderPadding=(6, 6, 6, 6), leftIndent=6, rightIndent=6, spaceBefore=4, spaceAfter=10)


def inline(text: str) -> str:
    """Markdown inline syntax -> ReportLab paragraph markup. Code spans may sit inside bold."""
    codes = []

    def stash(m):
        codes.append(f'<font name="Courier">{escape(m.group(1))}</font>')
        return f"\x00{len(codes) - 1}\x00"

    t = re.sub(r"`([^`]+)`", stash, text)
    t = escape(t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", t)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", lambda m: m.group(1) if not m.group(2).startswith("http")
               else f'<link href="{m.group(2)}" color="#2f5d8a">{m.group(1)}</link>', t)
    return re.sub(r"\x00(\d+)\x00", lambda m: codes[int(m.group(1))], t)


def make_table(rows, header=True):
    ncols = max(len(r) for r in rows)
    rows = [r + [""] * (ncols - len(r)) for r in rows]
    # Column widths proportional to content length, with a floor so short columns stay readable.
    lengths = [max(min(len(re.sub(r"[`*]", "", r[c])), 120) for r in rows) for c in range(ncols)]
    weights = [max(l, 12) ** 0.8 for l in lengths]
    widths = [CONTENT_WIDTH * w / sum(weights) for w in weights]
    data = [[Paragraph(inline(c), cellb if (header and i == 0) else cell) for c in r] for i, r in enumerate(rows)]
    t = Table(data, colWidths=widths, repeatRows=1 if header else 0)
    style = [
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LINEBELOW", (0, 0), (-1, -1), 0.5, RULE),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
    ]
    if header:
        style += [("BACKGROUND", (0, 0), (-1, 0), FILL), ("LINEBELOW", (0, 0), (-1, 0), 1, ACCENT)]
    t.setStyle(TableStyle(style))
    return t


# ---------- Diagrams ----------

def _box(d, x, y, w, h, label, sub=None, fill=FILL, dashed=False):
    d.add(Rect(x, y, w, h, rx=5, ry=5, fillColor=fill, strokeColor=ACCENT, strokeWidth=1,
               strokeDashArray=[3, 2] if dashed else None))
    d.add(String(x + w / 2, y + h / 2 + (4 if sub else -3), label, fontName="Helvetica-Bold", fontSize=9,
                 fillColor=INK, textAnchor="middle"))
    if sub:
        d.add(String(x + w / 2, y + h / 2 - 9, sub, fontName="Helvetica", fontSize=7.2, fillColor=MUTED,
                     textAnchor="middle"))


def _arrow(d, x1, y1, x2, y2, label=None, lx=0, ly=0):
    d.add(Line(x1, y1, x2, y2, strokeColor=INK, strokeWidth=1))
    a = math.atan2(y2 - y1, x2 - x1)
    s = 6
    d.add(Polygon([x2, y2, x2 - s * math.cos(a - 0.4), y2 - s * math.sin(a - 0.4),
                   x2 - s * math.cos(a + 0.4), y2 - s * math.sin(a + 0.4)], fillColor=INK, strokeColor=INK))
    if label:
        d.add(String((x1 + x2) / 2 + lx, (y1 + y2) / 2 + ly, label, fontName="Helvetica", fontSize=7.2,
                     fillColor=MUTED, textAnchor="middle"))


def _group(d, x, y, w, h, label, label_dx=8):
    d.add(Rect(x, y, w, h, rx=6, ry=6, fillColor=None, strokeColor=RULE, strokeDashArray=[3, 3]))
    d.add(String(x + label_dx, y + h - 12, label, fontName="Helvetica", fontSize=7.2, fillColor=MUTED))


def pr_review_diagram():
    W, H = 468, 300
    d = Drawing(W, H)
    _group(d, 2, 128, 230, 168, "review command (npm run review)")
    _box(d, 16, 236, 202, 40, "review-cli.ts", "args, budget, --post preflight (head SHA)")
    _box(d, 16, 176, 202, 44, "review.ts — Claude Agent SDK", "read-only allowlist, dontAsk, spend cap")
    _box(d, 96, 138, 122, 28, "post_review (--post only)", None, fill=colors.white, dashed=True)
    _arrow(d, 117, 236, 117, 220)
    _arrow(d, 157, 176, 157, 166)

    _box(d, 300, 186, 164, 52, "Claude API", "tool loop + JSON-schema review", fill=colors.white)
    _arrow(d, 218, 206, 300, 214, "tool loop", 0, 6)
    _arrow(d, 300, 200, 218, 192, "structured review", 0, -12)

    _group(d, 2, 4, 330, 110, "MCP server (embedded, or npm run serve)", label_dx=62)
    _box(d, 16, 54, 148, 40, "Repo tools", "search_code · read_file · search_docs", fill=colors.white)
    _box(d, 176, 54, 144, 40, "PR tools", "get_pr · get_pr_diff · post_review*", fill=colors.white)
    _box(d, 16, 14, 304, 30, "GitHubClient", "60s PR cache · 50-PR cap · diff paging · line mapping")
    _arrow(d, 50, 176, 50, 94)
    d.add(String(56, 118, "tools/list, tools/call", fontName="Helvetica", fontSize=7.2, fillColor=MUTED))
    _arrow(d, 190, 138, 230, 94)

    _box(d, 360, 30, 104, 56, "GitHub REST API", "PR · files · reviews", fill=colors.white)
    _arrow(d, 320, 44, 360, 56)
    d.add(String(2, -8, "* post_review exists only when posting is enabled and a GitHub token is set",
                 fontName="Helvetica", fontSize=7, fillColor=MUTED))
    return d


DIAGRAMS = {"pr_review_design": pr_review_diagram}


# ---------- Markdown -> flowables ----------

def build(md_path: str, pdf_path: str):
    lines = open(md_path, encoding="utf-8").read().splitlines()
    doc_key = re.sub(r"\.md$", "", md_path.replace("\\", "/").split("/")[-1])
    story, doc_title = [], "Design Doc"
    i, last_heading, first_para_done = 0, "", False

    def flush_list(items, ordered):
        if not items:
            return
        for n, it in enumerate(items, 1):
            story.append(Paragraph(inline(it), numbered if ordered else bullet,
                                   bulletText=f"{n}." if ordered else "•"))

    while i < len(lines):
        line = lines[i]
        if line.startswith("# "):
            doc_title = line[2:].strip()
            story.append(Paragraph(inline(doc_title), title))
        elif line.startswith("## "):
            last_heading = line[3:].strip()
            story.append(Paragraph(inline(last_heading), h1))
        elif line.startswith("### "):
            last_heading = line[4:].strip()
            story.append(Paragraph(inline(last_heading), h2))
        elif line.startswith("```"):
            block = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                block.append(lines[i])
                i += 1
            if last_heading == "Architecture" and doc_key in DIAGRAMS:
                story += [Spacer(1, 4), DIAGRAMS[doc_key](), Spacer(1, 14),
                          Paragraph("Figure 1. Runtime architecture. Dashed outlines group what runs together.", small),
                          Spacer(1, 6)]
            else:
                story.append(KeepTogether([Preformatted("\n".join(block), code)]))
        elif line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in lines[i].strip().strip("|").split("|")]
                filled = [c for c in cells if c]
                is_separator = bool(filled) and all(re.fullmatch(r":?-{3,}:?", c) for c in filled)
                if not is_separator:
                    rows.append(cells)
                i += 1
            i -= 1
            header = any(c for c in rows[0])
            story.append(make_table(rows if header else rows[1:], header=header))
            story.append(Spacer(1, 6))
        elif re.match(r"^- ", line):
            items = []
            while i < len(lines) and re.match(r"^- ", lines[i]):
                items.append(lines[i][2:].strip())
                i += 1
            i -= 1
            flush_list(items, False)
        elif re.match(r"^\d+\. ", line):
            items = []
            while i < len(lines) and re.match(r"^\d+\. ", lines[i]):
                items.append(re.sub(r"^\d+\.\s+", "", lines[i]))
                i += 1
            i -= 1
            flush_list(items, True)
        elif line.strip():
            para = [line.strip()]
            while i + 1 < len(lines) and lines[i + 1].strip() and not re.match(r"^(#|```|\||- |\d+\. )", lines[i + 1]):
                i += 1
                para.append(lines[i].strip())
            text = " ".join(para)
            # The line right after the title is the subtitle.
            style = subtitle if not first_para_done and len(story) == 1 else base
            first_para_done = True
            story.append(Paragraph(inline(text), style))
        i += 1

    def on_page(c, d):
        c.saveState()
        c.setFont("Helvetica", 8)
        c.setFillColor(MUTED)
        c.drawString(d.leftMargin, 0.5 * inch, f"Codebase Q&A Assistant  |  {doc_title}")
        c.drawRightString(letter[0] - d.rightMargin, 0.5 * inch, f"Page {d.page}")
        c.setStrokeColor(RULE)
        c.line(d.leftMargin, 0.65 * inch, letter[0] - d.rightMargin, 0.65 * inch)
        c.restoreState()

    pdf = SimpleDocTemplate(pdf_path, pagesize=letter, leftMargin=inch, rightMargin=inch, topMargin=0.85 * inch,
                            bottomMargin=0.9 * inch, title=doc_title, author="Todd Oppel",
                            subject=f"Codebase Q&A Assistant - {doc_title}")
    pdf.build(story, onFirstPage=on_page, onLaterPages=on_page)
    print("wrote", pdf_path)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    build(sys.argv[1], sys.argv[2])
