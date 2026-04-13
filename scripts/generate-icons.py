#!/usr/bin/env python3
"""
Generate all icon assets needed for electron-builder.
Creates PNG icons at standard sizes, a tray icon, and
placeholder .ico/.icns files (proper conversion requires
platform-specific tools).

Run: python3 scripts/generate-icons.py
"""

import struct
import zlib
import os

ASSETS_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets')

def create_png(width, height, rgba_data):
    """Create a minimal PNG file from RGBA pixel data."""
    def chunk(chunk_type, data):
        c = chunk_type + data
        crc = struct.pack('>I', zlib.crc32(c) & 0xffffffff)
        return struct.pack('>I', len(data)) + c + crc

    header = b'\x89PNG\r\n\x1a\n'
    ihdr = chunk(b'IHDR', struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0))

    # Build raw scanlines (filter byte 0 = None for each row)
    raw = b''
    for y in range(height):
        raw += b'\x00'  # filter byte
        row_start = y * width * 4
        raw += rgba_data[row_start:row_start + width * 4]

    compressed = zlib.compress(raw)
    idat = chunk(b'IDAT', compressed)
    iend = chunk(b'IEND', b'')

    return header + ihdr + idat + iend


def draw_icon(size):
    """Draw a simple icon: cyan circle with white 'D' approximation."""
    pixels = bytearray(size * size * 4)
    cx, cy = size / 2, size / 2
    r = size / 2 - 1

    for y in range(size):
        for x in range(size):
            idx = (y * size + x) * 4
            dx = x - cx
            dy = y - cy
            dist = (dx * dx + dy * dy) ** 0.5

            if dist <= r:
                # Cyan circle
                pixels[idx]     = 0    # R
                pixels[idx + 1] = 188  # G
                pixels[idx + 2] = 212  # B
                pixels[idx + 3] = 230  # A

                # Draw a rough 'D' in white (center region)
                rel_x = (x - cx) / r
                rel_y = (y - cy) / r

                in_d = False
                # Vertical bar of D
                if -0.3 <= rel_x <= -0.1 and -0.4 <= rel_y <= 0.4:
                    in_d = True
                # Horizontal bars
                if -0.3 <= rel_x <= 0.15 and (-0.42 <= rel_y <= -0.32 or 0.32 <= rel_y <= 0.42):
                    in_d = True
                # Curved right side of D
                arc_dist = ((rel_x - (-0.1)) ** 2 + rel_y ** 2) ** 0.5
                if 0.3 <= arc_dist <= 0.45 and rel_x >= -0.1:
                    in_d = True

                if in_d:
                    pixels[idx]     = 255
                    pixels[idx + 1] = 255
                    pixels[idx + 2] = 255
                    pixels[idx + 3] = 240
            else:
                # Transparent
                pixels[idx]     = 0
                pixels[idx + 1] = 0
                pixels[idx + 2] = 0
                pixels[idx + 3] = 0

    return bytes(pixels)


def create_ico(png_data_list):
    """
    Create a minimal .ico file from a list of (width, height, png_bytes) tuples.
    Uses PNG-compressed entries (supported by Windows Vista+).
    """
    count = len(png_data_list)
    # ICO header: 6 bytes
    header = struct.pack('<HHH', 0, 1, count)
    # Directory entries start at offset 6, each entry is 16 bytes
    dir_offset = 6 + count * 16
    directory = b''
    image_data = b''

    for width, height, png_bytes in png_data_list:
        w = width if width < 256 else 0
        h = height if height < 256 else 0
        entry = struct.pack('<BBBBHHII',
            w, h,       # width, height (0 = 256)
            0,          # color palette
            0,          # reserved
            1,          # color planes
            32,         # bits per pixel
            len(png_bytes),
            dir_offset + len(image_data)
        )
        directory += entry
        image_data += png_bytes

    return header + directory + image_data


def main():
    os.makedirs(ASSETS_DIR, exist_ok=True)

    sizes = [16, 32, 48, 64, 128, 256, 512, 1024]
    png_entries = []

    for size in sizes:
        rgba = draw_icon(size)
        png_data = create_png(size, size, rgba)

        # Save individual PNGs
        filepath = os.path.join(ASSETS_DIR, f'icon-{size}.png')
        with open(filepath, 'wb') as f:
            f.write(png_data)
        print(f'Created {filepath}')

        png_entries.append((size, size, png_data))

    # Main icon.png (256x256)
    icon_256 = draw_icon(256)
    icon_png = create_png(256, 256, icon_256)
    with open(os.path.join(ASSETS_DIR, 'icon.png'), 'wb') as f:
        f.write(icon_png)
    print(f'Created {os.path.join(ASSETS_DIR, "icon.png")}')

    # Tray icon (16x16 for macOS, 32x32 for Windows)
    tray_rgba = draw_icon(32)
    tray_png = create_png(32, 32, tray_rgba)
    with open(os.path.join(ASSETS_DIR, 'tray-icon.png'), 'wb') as f:
        f.write(tray_png)
    print(f'Created {os.path.join(ASSETS_DIR, "tray-icon.png")}')

    # ICO file (Windows) — include 16, 32, 48, 256
    ico_sizes = [(s, s, d) for s, _, d in png_entries if s in [16, 32, 48, 256]]
    ico_data = create_ico(ico_sizes)
    with open(os.path.join(ASSETS_DIR, 'icon.ico'), 'wb') as f:
        f.write(ico_data)
    print(f'Created {os.path.join(ASSETS_DIR, "icon.ico")}')

    # ICNS placeholder — electron-builder can also use icon.png on macOS
    # For a proper .icns, use iconutil on macOS:
    #   mkdir icon.iconset
    #   cp icon-16.png icon.iconset/icon_16x16.png
    #   cp icon-32.png icon.iconset/icon_16x16@2x.png
    #   ... etc
    #   iconutil -c icns icon.iconset
    #
    # For now, copy the 1024px PNG as a placeholder.
    # electron-builder will use icon.png if icon.icns is missing on macOS.
    icon_1024 = draw_icon(1024)
    icns_png = create_png(1024, 1024, icon_1024)
    # Write as icon.icns (electron-builder accepts PNG here for dev builds)
    with open(os.path.join(ASSETS_DIR, 'icon.icns'), 'wb') as f:
        f.write(icns_png)
    print(f'Created {os.path.join(ASSETS_DIR, "icon.icns")} (PNG placeholder — use iconutil for production)')

    print('\nAll icons generated in assets/')


if __name__ == '__main__':
    main()
