#!/usr/bin/env python3
"""Derive PI-Desktop platform icon resources from the canonical logo.

The tracked ``apps/desktop/build/icon_1024.png`` (rounded tile) and
``apps/desktop/build/mark_1024.png`` (transparent mark) are the brand sources
of truth. This script preserves them and emits:

  apps/desktop/build/icon.iconset/  - all macOS iconset sizes
  apps/desktop/build/icon.icns      - via `iconutil`, or PNG chunks elsewhere
  apps/desktop/build/icon.ico       - multi-size Windows application icon
  apps/desktop/build/icon.png       - 512px Windows/Linux package icon
  apps/desktop/build/tray-icon-mac.png - transparent macOS template icon

Run: python3 scripts/make-icon.py
"""

from __future__ import annotations

import shutil
import struct
import subprocess
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
BUILD = ROOT / "apps" / "desktop" / "build"
SOURCE = BUILD / "icon_1024.png"
MARK_SOURCE = BUILD / "mark_1024.png"

BASE = 1024


def main() -> None:
    if not SOURCE.is_file():
        raise FileNotFoundError(f"canonical logo is missing: {SOURCE}")

    with Image.open(SOURCE) as source:
        master = source.convert("RGBA")
    if master.size != (BASE, BASE):
        raise ValueError(
            f"canonical logo must be {BASE}x{BASE}, got {master.width}x{master.height}"
        )

    BUILD.mkdir(parents=True, exist_ok=True)
    windows_icon = BUILD / "icon.ico"
    master.save(
        windows_icon,
        format="ICO",
        sizes=[
            (16, 16),
            (32, 32),
            (48, 48),
            (64, 64),
            (128, 128),
            (256, 256),
        ],
    )
    package_icon = BUILD / "icon.png"
    master.resize((512, 512), Image.LANCZOS).save(package_icon)

    # macOS menu bar icons are template images: the opaque pixels are tinted
    # by the system. The application icon carries a white tile, so derive the
    # template from the transparent mark master instead.
    if not MARK_SOURCE.is_file():
        raise FileNotFoundError(f"transparent mark is missing: {MARK_SOURCE}")
    with Image.open(MARK_SOURCE) as mark_source:
        mark_master = mark_source.convert("RGBA")
    if mark_master.size != (BASE, BASE):
        raise ValueError(
            f"transparent mark must be {BASE}x{BASE}, got {mark_master.width}x{mark_master.height}"
        )
    tray_alpha = mark_master.getchannel("A")
    mark_bounds = tray_alpha.getbbox()
    if mark_bounds is None:
        raise ValueError("transparent mark does not contain a PI mark")
    tray_mark = Image.new("RGBA", mark_master.size, (0, 0, 0, 0))
    tray_mark.putalpha(tray_alpha)
    tray_mark = tray_mark.crop(mark_bounds)
    side = max(tray_mark.size)
    padding = int(side * 0.28)
    tray_icon_mac = Image.new(
        "RGBA", (side + padding * 2, side + padding * 2), (0, 0, 0, 0)
    )
    tray_icon_mac.alpha_composite(
        tray_mark,
        (
            padding + (side - tray_mark.width) // 2,
            padding + (side - tray_mark.height) // 2,
        ),
    )
    tray_icon_mac = tray_icon_mac.resize((BASE, BASE), Image.LANCZOS)
    tray_icon_mac_path = BUILD / "tray-icon-mac.png"
    tray_icon_mac.save(tray_icon_mac_path)

    iconset = BUILD / "icon.iconset"
    if iconset.exists():
        shutil.rmtree(iconset)
    iconset.mkdir()
    sizes = [16, 32, 128, 256, 512]
    for sz in sizes:
        master.resize((sz, sz), Image.LANCZOS).save(iconset / f"icon_{sz}x{sz}.png")
        master.resize((sz * 2, sz * 2), Image.LANCZOS).save(
            iconset / f"icon_{sz}x{sz}@2x.png"
        )

    iconutil = shutil.which("iconutil")
    icns = BUILD / "icon.icns"
    if iconutil is None:
        # Non-macOS hosts still ship the tracked .icns. Write the same PNG
        # chunks macOS reads instead of leaving a stale icon behind.
        chunks = []
        for kind, size in [
            ("icp4", 16),
            ("icp5", 32),
            ("icp6", 64),
            ("ic07", 128),
            ("ic08", 256),
            ("ic09", 512),
            ("ic10", 1024),
            ("ic11", 32),
            ("ic12", 64),
            ("ic13", 256),
            ("ic14", 512),
        ]:
            from io import BytesIO

            buffer = BytesIO()
            master.resize((size, size), Image.LANCZOS).save(buffer, format="PNG")
            payload = buffer.getvalue()
            chunks.append(kind.encode() + struct.pack(">I", len(payload) + 8) + payload)
        body = b"".join(chunks)
        icns.write_bytes(b"icns" + struct.pack(">I", len(body) + 8) + body)
        print(f"used {SOURCE}")
        print(f"wrote {windows_icon}")
        print(f"wrote {package_icon}")
        print(f"wrote {tray_icon_mac_path}")
        print(f"wrote {icns} (PNG chunks)")
        return

    subprocess.run(
        [iconutil, "-c", "icns", str(iconset), "-o", str(icns)], check=True
    )
    print(f"used {SOURCE}")
    print(f"wrote {windows_icon}")
    print(f"wrote {package_icon}")
    print(f"wrote {tray_icon_mac_path}")
    print(f"wrote {icns}")


if __name__ == "__main__":
    main()
