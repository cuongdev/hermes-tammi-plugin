#!/usr/bin/env python3
"""Render assets/src/*.term transcripts to assets/*.svg.

Transcripts are CLI output captured against fake backends (no real account data).
Markup: [g] green, [y] yellow, [r] red, [c] cyan, [d] dim, [b] bold, [i] typed input,
[v]/[p] banner colors, [/] reset. Optional first line: "# title: ...".
"""
import html
import re
import sys
import unicodedata
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent

FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace"
SIZE = 13
CW = 7.83          # advance width of one cell at 13px in common monospace fonts
LH = 19            # line height
PAD_X, PAD_TOP, PAD_BOTTOM, BAR = 18, 16, 22, 30
MAX_COLS = 128

COLORS = {
    "g": "#a6e3a1", "y": "#f9e2af", "r": "#f38ba8", "c": "#89dceb", "d": "#7f849c",
    "b": "#ffffff", "i": "#ffffff", "v": "#ff3b4a", "p": "#ff7ab8",
}
FG, BG = "#cdd6f4", "#1e1e2e"
TAG = re.compile(r"\[(g|y|r|c|d|b|i|v|p)\]|\[/\]")


def cells(s: str) -> int:
    n = 0
    for ch in s:
        if unicodedata.combining(ch):
            continue
        n += 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1
    return n


def parse(line: str):
    runs, style, pos = [], None, 0
    for m in TAG.finditer(line):
        if m.start() > pos:
            runs.append((line[pos:m.start()], style))
        style = m.group(1)  # None for [/]
        pos = m.end()
    if pos < len(line):
        runs.append((line[pos:], style))
    return runs


def wrap(runs):
    flat = [(ch, style) for text, style in runs for ch in text]
    if sum(cells(c) for c, _ in flat) <= MAX_COLS:
        return [runs]
    lead = len(flat) - len("".join(c for c, _ in flat).lstrip(" "))
    indent = [(" ", None)] * (lead + 3)
    rows, cur = [], []
    for item in flat:
        cur.append(item)
        if sum(cells(c) for c, _ in cur) > MAX_COLS:
            cut = max((i for i, (c, _) in enumerate(cur) if c == " " and i > lead + 4), default=len(cur) - 1)
            rows.append(cur[:cut])
            rest = cur[cut + 1:] if cur[cut][0] == " " else cur[cut:]
            cur = indent + rest
    rows.append(cur)

    def regroup(chars):
        out = []
        for c, style in chars:
            if out and out[-1][1] == style:
                out[-1] = (out[-1][0] + c, style)
            else:
                out.append((c, style))
        return out

    return [regroup(r) for r in rows]


def render(src: Path) -> Path:
    raw = unicodedata.normalize("NFC", src.read_text(encoding="utf-8")).rstrip("\n").split("\n")
    title = "Terminal"
    if raw and raw[0].startswith("# title:"):
        title = raw.pop(0).split(":", 1)[1].strip()
    rows = [r for line in raw for r in wrap(parse(line))]
    cols = max([sum(cells(t) for t, _ in r) for r in rows] + [60])
    width = int(PAD_X * 2 + cols * CW) + 4
    height = BAR + PAD_TOP + len(rows) * LH + PAD_BOTTOM
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="{html.escape(title)}">',
        f'<rect width="{width}" height="{height}" rx="10" fill="{BG}"/>',
        f'<rect width="{width}" height="{BAR}" rx="10" fill="#313244"/><rect y="{BAR - 10}" width="{width}" height="10" fill="#313244"/>',
        '<circle cx="18" cy="15" r="6" fill="#ff5f57"/><circle cx="38" cy="15" r="6" fill="#febc2e"/><circle cx="58" cy="15" r="6" fill="#28c840"/>',
        f'<text x="{width / 2:.0f}" y="19" fill="#a6adc8" font-family="-apple-system, Segoe UI, sans-serif" font-size="12" text-anchor="middle">{html.escape(title)}</text>',
        f'<g font-family="{FONT}" font-size="{SIZE}" fill="{FG}">',
    ]
    for n, row in enumerate(rows):
        y = BAR + PAD_TOP + (n + 1) * LH - 5
        x = PAD_X
        for text, style in row:
            attrs = ""
            if style:
                attrs = f' fill="{COLORS[style]}"'
                if style in ("b", "i"):
                    attrs += ' font-weight="bold"'
            out.append(f'<text x="{x:.1f}" y="{y}" xml:space="preserve"{attrs}>{html.escape(text)}</text>')
            x += cells(text) * CW
    out.append("</g></svg>")
    dst = OUT / (src.stem + ".svg")
    dst.write_text("\n".join(out) + "\n", encoding="utf-8")
    return dst


if __name__ == "__main__":
    targets = [Path(a) for a in sys.argv[1:]] or sorted(HERE.glob("*.term"))
    for t in targets:
        print("rendered", render(t).relative_to(OUT.parent))
