#!/usr/bin/env python3
"""Generate pack/app.ico — a tray icon drawn pixel by pixel, no dependencies.

The mark: dark rounded square, cyan ">" prompt, green status dot. It stays
readable at 16 px, which is what the notification area actually renders.
"""

import math
import struct
from pathlib import Path

SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]
SS = 4  # supersampling factor per axis

BG = (15, 23, 42)        # slate-900
EDGE = (51, 65, 85)      # slate-700
ACCENT = (56, 189, 248)  # sky-400
DOT = (74, 222, 128)     # green-400


def rounded_rect(x, y, w, h, r):
    # distance to the rounded rectangle border, negative inside
    cx = min(max(x, r), w - r)
    cy = min(max(y, r), h - r)
    return math.hypot(x - cx, y - cy) - r


def segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    t = (wx * vx + wy * vy) / (vx * vx + vy * vy)
    t = max(0.0, min(1.0, t))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def shade(size, x, y):
    """Return RGBA for a point in icon space (0..1)."""
    w = h = float(size)
    r = w * 0.22
    d = rounded_rect(x, y, w, h, r)
    if d > 0.6:
        return (0, 0, 0, 0)

    # base square with a hairline border
    if d > -max(0.9, w * 0.012):
        rgb = EDGE
    else:
        # subtle vertical gradient so the tile does not look flat
        t = y / h
        rgb = tuple(int(BG[i] + (18 - 8) * (t - 0.5) * (i * 0.2)) for i in range(3))

    thick = w * 0.085
    if math.hypot(x - w * 0.50, y - h * 0.5) < w * 0.001:
        pass

    # ">" prompt: two strokes meeting in the middle
    ax, ay = w * 0.32, h * 0.31
    bx, by = w * 0.55, h * 0.50
    cx, cy = w * 0.32, h * 0.69
    d1 = segment(x, y, ax, ay, bx, by)
    d2 = segment(x, y, bx, by, cx, cy)
    if min(d1, d2) <= thick / 2:
        rgb = ACCENT
    elif min(d1, d2) <= thick / 2 + 0.7 and d <= 0:
        # one pixel of soft edge keeps the chevron from looking ragged
        rgb = tuple(int((ACCENT[i] + rgb[i]) / 2) for i in range(3))

    # status dot
    if math.hypot(x - w * 0.70, y - h * 0.70) <= w * 0.075:
        rgb = DOT

    return (rgb[0], rgb[1], rgb[2], 255)


def render(size):
    rows = []
    step = 1.0 / SS
    for py in range(size):
        row = bytearray()
        for px in range(size):
            acc = [0.0, 0.0, 0.0, 0.0]
            for sy in range(SS):
                for sx in range(SS):
                    rgba = shade(size, px + (sx + 0.5) * step, py + (sy + 0.5) * step)
                    a = rgba[3] / 255.0
                    acc[0] += rgba[0] * a
                    acc[1] += rgba[1] * a
                    acc[2] += rgba[2] * a
                    acc[3] += a
            n = SS * SS
            if acc[3] <= 0:
                row += bytes((0, 0, 0, 0))
                continue
            alpha = acc[3] / n
            r = acc[0] / acc[3]
            g = acc[1] / acc[3]
            b = acc[2] / acc[3]
            row += bytes((int(b), int(g), int(r), int(alpha * 255)))
        rows.append(bytes(row))
    return rows


def ico_image(size):
    rows = render(size)
    header = struct.pack('<IiiHHIIiiII', 40, size, size * 2, 1, 32, 0, size * size * 4, 0, 0, 0, 0)
    body = b''.join(reversed(rows))  # bottom-up
    mask_row = ((size + 31) // 32) * 4
    mask = b'\x00' * (mask_row * size)
    return header + body + mask


def main():
    out = Path(__file__).with_name('app.ico')
    images = [ico_image(s) for s in SIZES]
    offset = 6 + 16 * len(images)
    dir_entries = b''
    for size, img in zip(SIZES, images):
        dir_entries += struct.pack(
            '<BBBBHHII',
            0 if size >= 256 else size,
            0 if size >= 256 else size,
            0, 0, 1, 32, len(img), offset,
        )
        offset += len(img)
    out.write_bytes(struct.pack('<HHH', 0, 1, len(images)) + dir_entries + b''.join(images))
    print(f'icon: {out} ({out.stat().st_size} bytes, {len(images)} sizes)')


if __name__ == '__main__':
    main()
