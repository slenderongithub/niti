"""niti's agent avatars: from the six source drawings to every size the products use.

For each source (niti1..6.png, transparent background) this crops the character, centres it on a
square, and makes a second "blink" frame with every open eye shut — detected as filled dark shapes
in the face's eye band, painted over with the surrounding body colour, and redrawn as a closed lid.
Eyes already closed in the drawing (a wink, a laugh) are left alone.

Outputs (pass the repo root):
  niti-app/src/renderer/src/assets/avatars/niti{n}.png, niti{n}-blink.png   256px, the app
  web/avatars/niti{n}.png, niti{n}-blink.png                                 128px, dashboard + graph

  python3 niti-app/scripts/make-avatars.py <source-dir> <repo-root>
"""
import sys
from collections import deque
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

SRC, ROOT = Path(sys.argv[1]), Path(sys.argv[2])
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


app_dir = ROOT / "niti-app/src/renderer/src/assets/avatars"
web_dir = ROOT / "web/avatars"
app_dir.mkdir(parents=True, exist_ok=True)
web_dir.mkdir(parents=True, exist_ok=True)
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
        img.resize((256, 256), Image.LANCZOS).save(app_dir / f"niti{n}{suffix}.png", optimize=True)
        img.resize((128, 128), Image.LANCZOS).save(web_dir / f"niti{n}{suffix}.png", optimize=True)
print("wrote", app_dir, web_dir)
