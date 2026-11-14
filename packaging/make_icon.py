#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""生成 packaging/icon.ico（纯标准库，不依赖 Pillow）。

图案就是本项目的语义：深色画布上三块错落的布局框。
先按 1024px 画一遍（圆角用 SDF 抗锯齿），再用积分图缩到各档尺寸。
ICO 用 32bpp BGRA DIB（带 AND 掩码），Windows 与 PyInstaller 都认。
"""

from __future__ import annotations

import struct
import zlib
from pathlib import Path

SIZES = (256, 64, 48, 32, 16)
MASTER = 1024

BG = (26, 25, 24)
BORDER = (58, 55, 52)
AMBER = (233, 170, 86)
TEAL = (94, 176, 166)
CREAM = (241, 234, 221)


def sdf_box(px, py, x0, y0, x1, y1, radius):
    """圆角矩形有符号距离：<0 内部，>0 外部。"""
    cx, cy = (x0 + x1) * 0.5, (y0 + y1) * 0.5
    hx, hy = (x1 - x0) * 0.5 - radius, (y1 - y0) * 0.5 - radius
    qx, qy = abs(px - cx) - hx, abs(py - cy) - hy
    ax, ay = max(qx, 0.0), max(qy, 0.0)
    return (ax * ax + ay * ay) ** 0.5 + min(max(qx, qy), 0.0) - radius


class Canvas:
    def __init__(self, size):
        self.size = size
        self.px = [[float(c) for c in BG] for _ in range(size * size)]

    def fill(self, x0, y0, x1, y1, radius, color, alpha=1.0):
        """按 SDF 覆盖率混合一个圆角矩形。"""
        size = self.size
        feather = 1.0
        y_from, y_to = max(0, int(y0) - 2), min(size, int(y1) + 3)
        x_from, x_to = max(0, int(x0) - 2), min(size, int(x1) + 3)
        for y in range(y_from, y_to):
            py = y + 0.5
            row = self.px
            for x in range(x_from, x_to):
                d = sdf_box(x + 0.5, py, x0, y0, x1, y1, radius)
                if d >= feather:
                    continue
                cov = 1.0 if d <= 0 else 1.0 - d / feather
                a = cov * alpha
                p = row[y * size + x]
                p[0] += (color[0] - p[0]) * a
                p[1] += (color[1] - p[1]) * a
                p[2] += (color[2] - p[2]) * a

    def frame(self, x0, y0, x1, y1, radius, thickness, color, alpha=1.0):
        """描边：外圈减内圈。"""
        size = self.size
        feather = 1.0
        y_from, y_to = max(0, int(y0) - 2), min(size, int(y1) + 3)
        x_from, x_to = max(0, int(x0) - 2), min(size, int(x1) + 3)
        for y in range(y_from, y_to):
            py = y + 0.5
            for x in range(x_from, x_to):
                px = x + 0.5
                outer = sdf_box(px, py, x0, y0, x1, y1, radius)
                inner = sdf_box(px, py, x0 + thickness, y0 + thickness,
                                x1 - thickness, y1 - thickness,
                                max(0.0, radius - thickness))
                band = max(outer, -inner)
                if band >= feather:
                    continue
                cov = 1.0 if band <= 0 else 1.0 - band / feather
                a = cov * alpha
                p = self.px[y * size + x]
                p[0] += (color[0] - p[0]) * a
                p[1] += (color[1] - p[1]) * a
                p[2] += (color[2] - p[2]) * a

    def rgb_bytes(self):
        out = bytearray(self.size * self.size * 3)
        for i, p in enumerate(self.px):
            out[i * 3] = max(0, min(255, int(p[0] + 0.5)))
            out[i * 3 + 1] = max(0, min(255, int(p[1] + 0.5)))
            out[i * 3 + 2] = max(0, min(255, int(p[2] + 0.5)))
        return bytes(out)


def draw():
    c = Canvas(MASTER)
    u = MASTER / 256.0

    def r(v):
        return v * u

    # 底板 + 内描边
    c.fill(r(10), r(10), r(246), r(246), r(46), BORDER)
    c.fill(r(15), r(15), r(241), r(241), r(42), BG)

    # 左上主框（琥珀）
    c.fill(r(42), r(54), r(158), r(148), r(14), (58, 46, 32))
    c.fill(r(46), r(58), r(154), r(144), r(11), AMBER, 0.14)
    c.frame(r(46), r(58), r(154), r(144), r(11), r(5), AMBER)

    # 右侧竖条（青绿）
    c.fill(r(174), r(54), r(214), r(148), r(9), (32, 52, 50))
    c.fill(r(174), r(54), r(214), r(148), r(9), TEAL, 0.20)
    c.frame(r(174), r(54), r(214), r(148), r(9), r(5), TEAL)

    # 下方文字条（米白）
    c.fill(r(42), r(170), r(214), r(210), r(10), CREAM, 0.97)
    c.fill(r(60), r(184), r(124), r(192), r(4), BG, 0.55)
    c.fill(r(60), r(197), r(152), r(202), r(2.5), BG, 0.30)
    return c


def downsample(rgb, master, size):
    """积分图求均值，1024→16 也不会糊成一团。"""
    from array import array

    w = h = master
    stride = w * 3
    span = w + 1
    zero = array("q", [0]) * ((h + 1) * span)
    sr, sg, sb = array("q", zero), array("q", zero), array("q", zero)
    for y in range(h):
        run_r = run_g = run_b = 0
        base = y * stride
        prev = y * span
        cur = (y + 1) * span
        for x in range(w):
            px = base + x * 3
            run_r += rgb[px]
            run_g += rgb[px + 1]
            run_b += rgb[px + 2]
            i = cur + x + 1
            up = prev + x + 1
            sr[i] = sr[up] + run_r
            sg[i] = sg[up] + run_g
            sb[i] = sb[up] + run_b

    out = bytearray(size * size * 3)
    step = master / size
    for oy in range(size):
        y0 = int(oy * step)
        y1 = max(y0 + 1, int((oy + 1) * step))
        top, bottom = y0 * span, y1 * span
        for ox in range(size):
            x0 = int(ox * step)
            x1 = max(x0 + 1, int((ox + 1) * step))
            area = (x1 - x0) * (y1 - y0)
            i = (oy * size + ox) * 3
            for c, plane in enumerate((sr, sg, sb)):
                total = (plane[bottom + x1] - plane[top + x1]
                         - plane[bottom + x0] + plane[top + x0])
                out[i + c] = total // area
    return bytes(out)


def ico_image(rgb, size):
    """32bpp BGRA DIB：BITMAPINFOHEADER + 自下而上的行 + AND 掩码。"""
    mask_stride = ((size + 31) // 32) * 4
    pixels = bytearray(size * size * 4)
    for y in range(size):
        src = (size - 1 - y) * size * 3  # DIB 自下而上
        dst = y * size * 4
        for x in range(size):
            r, g, b = rgb[src + x * 3], rgb[src + x * 3 + 1], rgb[src + x * 3 + 2]
            pixels[dst + x * 4:dst + x * 4 + 4] = bytes((b, g, r, 255))
    header = struct.pack("<IiiHHIIiiII", 40, size, size * 2, 1, 32, 0,
                         len(pixels), 0, 0, 0, 0)
    return header + bytes(pixels) + bytes(mask_stride * size)


def write_ico(path, master_rgb):
    images = [(size, ico_image(downsample(master_rgb, MASTER, size), size))
              for size in SIZES]
    offset = 6 + 16 * len(images)
    directory = bytearray(struct.pack("<HHH", 0, 1, len(images)))
    payload = bytearray()
    for size, data in images:
        directory += struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32,
                                 len(data), offset)
        payload += data
        offset += len(data)
    path.write_bytes(bytes(directory + payload))


def write_png(path, rgb, size=512):
    big = downsample(rgb, MASTER, size)
    raw = b"".join(b"\x00" + big[y * size * 3:(y + 1) * size * 3] for y in range(size))

    def chunk(tag, data):
        return (struct.pack(">I", len(data)) + tag + data
                + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))

    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    path.write_bytes(png)


if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    master = draw().rgb_bytes()
    write_ico(here / "icon.ico", master)
    write_png(here / "icon.png", master)
    print("icon.ico %.1f KB / icon.png" % ((here / "icon.ico").stat().st_size / 1024))
