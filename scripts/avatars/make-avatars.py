"""niti's agent avatars: from the six source drawings to every size the products use.

For each source (niti1..6.png, transparent background) this crops the character, centres it on a
square, and makes a second "blink" frame with every open eye shut — detected as filled dark shapes
in the face's eye band, painted over with the surrounding body colour, and redrawn as a closed lid.
Eyes already closed in the drawing (a wink, a laugh) are left alone.

The CLI's copy: the source drawings sit beside this script, and it writes only the CLI's outputs.
(niti-app/scripts/make-avatars.py is the desktop app's own copy, which also writes the app's
256px set; keep the two in step when the art changes.)
  web/avatars/niti{n}.png, niti{n}-blink.png    128px, dashboard + graph
  tui/internal/theme/avatars_gen.go             hand-drawn 18×18 + 12×12 pixel art, the terminal

  python3 scripts/avatars/make-avatars.py        (needs Pillow)
"""
from collections import deque
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

HERE = Path(__file__).resolve().parent
SRC, ROOT = HERE, HERE.parents[1]
INK_MAX = 60  # an ink pixel: dark (the eyes/mouth are near-black navy)


def ink(px):
    r, g, b, a = px
    return a > 200 and max(r, g, b) < INK_MAX


def components(im):
    """Connected dark shapes, on a half-size copy for speed; boxes returned at full size."""
    small = im.resize((im.width // 2, im.height // 2), Image.NEAREST)
    w, h = small.size
    data = small.load()
    seen = bytearray(w * h)
    out = []
    for y in range(h):
        for x in range(w):
            if seen[y * w + x] or not ink(data[x, y]):
                continue
            q, pts = deque([(x, y)]), []
            seen[y * w + x] = 1
            while q:
                cx, cy = q.popleft()
                pts.append((cx, cy))
                for nx, ny in ((cx + 1, cy), (cx - 1, cy), (cx, cy + 1), (cx, cy - 1)):
                    if 0 <= nx < w and 0 <= ny < h and not seen[ny * w + nx] and ink(data[nx, ny]):
                        seen[ny * w + nx] = 1
                        q.append((nx, ny))
            if len(pts) < 40:
                continue
            xs, ys = [p[0] for p in pts], [p[1] for p in pts]
            x0, y0, x1, y1 = min(xs), min(ys), max(xs) + 1, max(ys) + 1
            out.append({"box": (x0 * 2, y0 * 2, x1 * 2, y1 * 2), "area": len(pts) * 4, "pts": [(px * 2, py * 2) for px, py in pts]})
    return out


def body_colour(im, box):
    """The flat colour around a shape: the most common opaque, non-ink colour in a ring outside it."""
    x0, y0, x1, y1 = box
    pad = max(8, (x1 - x0) // 4)
    counts = {}
    data = im.load()
    for y in range(max(0, y0 - pad), min(im.height, y1 + pad)):
        for x in range(max(0, x0 - pad), min(im.width, x1 + pad)):
            if x0 - 4 <= x < x1 + 4 and y0 - 4 <= y < y1 + 4:
                continue
            p = data[x, y]
            if p[3] > 240 and not ink(p):
                k = (p[0] // 6 * 6, p[1] // 6 * 6, p[2] // 6 * 6)
                counts[k] = counts.get(k, 0) + 1
    k = max(counts, key=counts.get)
    return (k[0], k[1], k[2], 255)


def blink(im):
    """A copy with every open eye closed. Returns (image, number of eyes closed)."""
    body = im.getbbox()  # set by caller to the alpha-trimmed character
    top, height = body[1], body[3] - body[1]
    eyes = []
    data0 = im.load()
    for c in components(im):
        x0, y0, x1, y1 = c["box"]
        w, h = x1 - x0, y1 - y0
        band = ((y0 + y1) / 2 - top) / height
        # Open eyes are solid through their lower middle; a closed or winking eye is a stroke
        # (an arch, a chevron) and hollow there. The mouth sits below the eye band.
        tot = solid = 0
        for y in range(int(y0 + h * 0.55), int(y0 + h * 0.85)):
            for x in range(int(x0 + w * 0.35), int(x0 + w * 0.65)):
                tot += 1
                solid += ink(data0[x, y])
        if tot and solid / tot > 0.9 and 0.3 < band < 0.57:
            eyes.append(c)
    out = im.copy()
    draw = ImageDraw.Draw(out)
    data = out.load()
    for c in eyes:
        x0, y0, x1, y1 = c["box"]
        colour = body_colour(im, c["box"])
        # Paint the eye (and its highlight) out: its bounding box, slightly grown, but only where
        # the drawing is opaque — so the silhouette's edge is never touched.
        grow = 6
        for y in range(y0 - grow, y1 + grow):
            for x in range(x0 - grow, x1 + grow):
                if 0 <= x < out.width and 0 <= y < out.height and data[x, y][3] > 200:
                    data[x, y] = colour
        # The closed lid: a soft downward arc where the lower half of the eye was.
        w, h = x1 - x0, y1 - y0
        stroke = max(6, round(w * 0.24))
        cx, cy = (x0 + x1) / 2, y0 + h * 0.62
        rx, ry = w * 0.62, h * 0.32
        draw.arc((cx - rx, cy - ry, cx + rx, cy + ry), start=20, end=160, fill=(13, 17, 30, 255), width=stroke)
    return out, len(eyes)


def square(im, size):
    """Trim to the opaque character, centre on a square canvas with a small margin, resize."""
    alpha = im.split()[3].point(lambda a: 255 if a > 128 else 0)
    box = alpha.getbbox()
    im = im.crop(box)
    side = round(max(im.size) * 1.06)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(im, ((side - im.width) // 2, (side - im.height) // 2), im)
    return canvas.resize((size, size), Image.LANCZOS)


# ---- The terminal art: drawn by hand, one silhouette for all six --------------------------------
#
# The six drawings differ slightly in outline; in the terminal they are one family. The shape is
# the consensus of the six (each scaled to one box and averaged), cleaned into smooth pixel steps,
# with the drawings' shared three-tone layout: light lobe top-left (H), body (B), shade
# bottom-right (S). Each avatar brings its own three colours, and a face drawn pixel by pixel on
# the same grid — eyes always in the same columns, mouth centred.

SHAPE_18 = [
    "........HHHB......",
    ".......HHHHHB.....",
    "......HHHHHHBB....",
    ".....HHHHHHBBB....",
    "..HHHHHHHBBBBBB...",
    ".HHHHHHHBBBBBBB...",
    "HHHHHHBBBBBBBBBB..",
    "HHHHBBBBBBBBBBBBB.",
    "HHHBBBBBBBBBBBBBBS",
    "HHBBBBBBBBBBBBBSSS",
    ".HBBBBBBBBBBBSSSSS",
    "..BBBBBBBBBBSSSSSS",
    "...BBBBBBBSSSSSSS.",
    "...BBBBBBSSSSSSS..",
    "....BBBSSSSSSS....",
    "....BSSSSSSSS.....",
    ".....SSSSSS.......",
    "......SSSS........",
]
SHAPE_12 = [
    ".....HHH....",
    "....HHHHB...",
    "...HHHHHBB..",
    ".HHHHHHBBB..",
    "HHHBBBBBBBB.",
    "HHBBBBBBBBBS",
    "HBBBBBBBBBSS",
    ".BBBBBBBBSSS",
    "..BBBBBBSSS.",
    "..BBBSSSSS..",
    "...SSSSS....",
    "....SSS.....",
]

# Each avatar's colours, sampled from its drawing: light lobe, body, shade, then tongue and blush.
COLOURS = [
    {"H": "#54b4f6", "B": "#1272f6", "S": "#0048d8"},
    {"H": "#d284f0", "B": "#7242f6", "S": "#4e24d8", "t": "#d88cf2"},
    {"H": "#f6c660", "B": "#f67e2a", "S": "#f0422a", "t": "#f2685a"},
    {"H": "#a296f6", "B": "#7254f6", "S": "#1e36de", "t": "#c77ef0", "b": "#5a36d6"},
    {"H": "#f69090", "B": "#f6425a", "S": "#d21248"},
    {"H": "#a8f0cc", "B": "#12c6b4", "S": "#006c78", "t": "#a8f0cc", "b": "#0b8f8a"},
]
FACE_INK, FACE_WHITE = "#0d111e", "#f6f1e8"

# Faces: {row: row string} overlays on the shape. k ink · w eye highlight · t tongue · b blush ·
# anything else leaves the body showing. [open, blinking] per avatar.
FACES_18 = [
    [  # calm: tall eyes
        {7: ".....kk....kk.....", 8: ".....kk....kk.....", 9: ".....kk....kk....."},
        {9: ".....kk....kk....."},
    ],
    [  # wink: one tall eye, an arch, an open smile
        {7: ".....kk.....k.....", 8: ".....kk....k.k....", 9: ".....kk...........", 11: "........kk........", 12: "........tt........"},
        {7: "............k.....", 8: "...........k.k....", 9: ".....kk...........", 11: "........kk........", 12: "........tt........"},
    ],
    [  # delighted: shining eyes, a wide open smile
        {7: ".....wk....wk.....", 8: ".....kk....kk.....", 9: ".....kk....kk.....", 11: ".......kkkk.......", 12: "........tt........"},
        {9: ".....kk....kk.....", 11: ".......kkkk.......", 12: "........tt........"},
    ],
    [  # laughing: eyes shut in arches, blush, open mouth (it doesn't blink)
        {7: ".....kk....kk.....", 8: "....k..k..k..k....", 9: "...bb.........bb..", 10: "........kk........", 11: "........tt........"},
        {7: ".....kk....kk.....", 8: "....k..k..k..k....", 9: "...bb.........bb..", 10: "........kk........", 11: "........tt........"},
    ],
    [  # smug: heavy lids, side-eye, a smirk
        {7: "....kkk....kkk....", 8: ".....wk.....wk....", 10: "..........k.......", 11: ".......kkk........"},
        {7: "....kkk....kkk....", 10: "..........k.......", 11: ".......kkk........"},
    ],
    [  # cheeky: a shining eye, a chevron wink, blush, open smile
        {7: ".....wk.....kk....", 8: ".....kk....k......", 9: "............kk....", 10: "...bb.........bb..", 11: "........kk........", 12: "........tt........"},
        {7: "............kk....", 8: ".....kk....k......", 9: "............kk....", 10: "...bb.........bb..", 11: "........kk........", 12: "........tt........"},
    ],
]
FACES_12 = [
    [{4: "....k..k....", 5: "....k..k...."}, {5: "....k..k...."}],
    [{4: "....k.......", 5: "....k..kk...", 7: ".....kk.....", 8: ".....tt....."}, {5: "....k..kk...", 7: ".....kk.....", 8: ".....tt....."}],
    [{4: "....k..k....", 5: "....k..k....", 7: "....kkkk....", 8: ".....tt....."}, {5: "....k..k....", 7: "....kkkk....", 8: ".....tt....."}],
    [{4: "...kk..kk...", 6: "..b......b..", 7: ".....kk.....", 8: ".....tt....."}, {4: "...kk..kk...", 6: "..b......b..", 7: ".....kk.....", 8: ".....tt....."}],
    [{4: "...kk..kk...", 5: "....k...k...", 6: ".......k....", 7: ".....kk....."}, {4: "...kk..kk...", 6: ".......k....", 7: ".....kk....."}],
    [{4: "....k..kk...", 5: "....k.......", 7: ".....kk.....", 8: ".....tt....."}, {4: ".......kk...", 5: "....k.......", 7: ".....kk.....", 8: ".....tt....."}],
]


def draw(shape, face, colours):
    rows = []
    for y, line in enumerate(shape):
        row = []
        for x, c in enumerate(line):
            if c == ".":
                row.append("")
                continue
            px = colours[c]
            f = face.get(y, "")
            m = f[x] if x < len(f) else "."
            if m == "k":
                px = FACE_INK
            elif m == "w":
                px = FACE_WHITE
            elif m in ("t", "b"):
                px = colours.get(m, FACE_INK)
            row.append(px)
        rows.append(row)
    return rows


web_dir = ROOT / "web/avatars"
web_dir.mkdir(parents=True, exist_ok=True)
grids = []
for n in range(1, 7):
    src = Image.open(SRC / f"niti{n}.png").convert("RGBA")
    # Drop the faint stray pixels around the drawing before anything else.
    a = src.split()[3].point(lambda v: v if v > 24 else 0)
    src.putalpha(a)
    hi = square(src, 1024)
    closed, count = blink(hi)
    print(f"niti{n}: {count} open eye(s) closed for the blink")
    # No open eyes (avatar 4 laughs with its eyes shut): no blink frame.
    for img, suffix in ((hi, ""), (closed, "-blink"))[: 2 if count else 1]:
        img.resize((128, 128), Image.LANCZOS).save(web_dir / f"niti{n}{suffix}.png", optimize=True)
    i = n - 1
    grids.append(((draw(SHAPE_18, FACES_18[i][0], COLOURS[i]), draw(SHAPE_18, FACES_18[i][1], COLOURS[i])), (draw(SHAPE_12, FACES_12[i][0], COLOURS[i]), draw(SHAPE_12, FACES_12[i][1], COLOURS[i]))))


def go_grid(g, indent):
    pad = "\t" * indent
    return "{\n" + "".join(pad + "\t{" + ", ".join(f'"{c}"' for c in row) + "},\n" for row in g) + pad + "}"


go = [
    "// Code generated by scripts/avatars/make-avatars.py from the six avatar drawings. DO NOT EDIT.\n",
    "package theme\n",
    "// AvatarArtBig / AvatarArtSmall: each agent avatar as pixel art (\"\" = transparent), [slot][open, blinking].",
    "var AvatarArtBig = [6][2][18][18]string{",
]
for (big, _small) in grids:
    go.append("\t{\n\t\t" + go_grid(big[0], 2) + ",\n\t\t" + go_grid(big[1], 2) + ",\n\t},")
go.append("}\n")
go.append("var AvatarArtSmall = [6][2][12][12]string{")
for (_big, small) in grids:
    go.append("\t{\n\t\t" + go_grid(small[0], 2) + ",\n\t\t" + go_grid(small[1], 2) + ",\n\t},")
go.append("}\n")
(ROOT / "tui/internal/theme/avatars_gen.go").write_text("\n".join(go))
print("wrote", web_dir, ROOT / "tui/internal/theme/avatars_gen.go")
