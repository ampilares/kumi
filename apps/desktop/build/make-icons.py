"""Rasterise the Kumi app icon (build/icon.svg) into the formats electron-builder wants.

Pillow cannot parse SVG, so the same geometry is redrawn here with primitives on a
4096px canvas and downsampled with LANCZOS — that supersampling is what keeps the
16px .ico entry legible.

Outputs (relative to this file):
  icon.png   512x512  — Linux (AppImage/deb) and the source electron-builder
                        converts to .icns when packaging macOS on a Mac.
  icon.ico   16/32/48/64/128/256 — Windows (NSIS installer + exe).

Run:  python apps/desktop/build/make-icons.py
"""

from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent
S = 4096                      # supersampled canvas
K = S / 1024                  # scale from the SVG's 1024 grid
BG = (44, 44, 43, 255)        # #2C2C2B charcoal
FG = (251, 250, 248, 255)     # #FBFAF8 warm white
STROKE = 108 * K
R = STROKE / 2


def s(v: float) -> float:
    return v * K


def stroke(d: ImageDraw.ImageDraw, x1, y1, x2, y2) -> None:
    """A round-capped stroke: a wide line plus a disc at each end."""
    d.line([(s(x1), s(y1)), (s(x2), s(y2))], fill=FG, width=int(round(STROKE)))
    for x, y in ((x1, y1), (x2, y2)):
        d.ellipse([s(x) - R, s(y) - R, s(x) + R, s(y) + R], fill=FG)


def render() -> Image.Image:
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, S - 1, S - 1], radius=s(205), fill=BG)
    stroke(d, 354, 280, 354, 744)   # stem
    stroke(d, 408, 512, 690, 280)   # upper arm
    stroke(d, 408, 512, 690, 744)   # lower arm
    return img


def main() -> None:
    master = render()
    master.resize((512, 512), Image.LANCZOS).save(OUT / "icon.png")
    sizes = [16, 32, 48, 64, 128, 256]
    master.resize((256, 256), Image.LANCZOS).save(
        OUT / "icon.ico", format="ICO", sizes=[(n, n) for n in sizes]
    )
    print("wrote", OUT / "icon.png", "and", OUT / "icon.ico")


if __name__ == "__main__":
    main()
