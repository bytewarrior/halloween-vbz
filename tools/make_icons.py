"""Erzeugt die Kürbis-Icons der App (icons/*.png)."""
from pathlib import Path
from PIL import Image, ImageDraw

BG, ORANGE, DARK, GREEN, GLOW = (22, 14, 31), (255, 122, 24), (204, 82, 0), (76, 155, 60), (255, 210, 63)


def pumpkin(size, scale):
    s = size * 4                      # überabgetastet für glatte Kanten
    im = Image.new("RGBA", (s, s), BG + (255,))
    d = ImageDraw.Draw(im)
    c, r = s / 2, s / 2 * scale
    w, h = r * 1.0, r * 0.82
    cy = c + r * 0.08
    for dx, k in ((-0.5, 0.62), (0.5, 0.62), (-0.22, 0.7), (0.22, 0.7), (0, 0.6)):
        col = DARK if abs(dx) > 0.3 else ORANGE
        d.ellipse([c + dx * w - w * k, cy - h, c + dx * w + w * k, cy + h], fill=col)
    d.ellipse([c - w * 0.6, cy - h, c + w * 0.6, cy + h], fill=ORANGE)
    d.rounded_rectangle([c - r * 0.09, cy - h - r * 0.28, c + r * 0.09, cy - h + r * 0.1], radius=r * 0.05, fill=GREEN)
    # Gesicht
    ey = cy - h * 0.25
    for sx in (-1, 1):
        ex = c + sx * w * 0.38
        d.polygon([(ex - r * 0.17, ey + r * 0.1), (ex + r * 0.17, ey + r * 0.1), (ex, ey - r * 0.16)], fill=GLOW)
    d.polygon([(c - r * 0.09, cy + r * 0.08), (c + r * 0.09, cy + r * 0.08), (c, cy - r * 0.1)], fill=GLOW)
    my = cy + h * 0.38
    mouth = [(c - w * 0.55, my - r * 0.1), (c - w * 0.3, my), (c - w * 0.15, my - r * 0.08), (c, my + r * 0.02),
             (c + w * 0.15, my - r * 0.08), (c + w * 0.3, my), (c + w * 0.55, my - r * 0.1),
             (c + w * 0.35, my + r * 0.22), (c, my + r * 0.3), (c - w * 0.35, my + r * 0.22)]
    d.polygon(mouth, fill=GLOW)
    return im.resize((size, size), Image.LANCZOS)


out = Path(__file__).resolve().parent.parent / "icons"
out.mkdir(exist_ok=True)
pumpkin(192, 0.86).save(out / "icon-192.png")
pumpkin(512, 0.86).save(out / "icon-512.png")
pumpkin(512, 0.62).save(out / "icon-maskable-512.png")   # Sicherheitszone für runde Masken
print("Icons geschrieben nach", out)
