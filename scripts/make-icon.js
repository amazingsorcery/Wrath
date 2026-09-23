'use strict';

/**
 * Generates assets/wrath.ico without any image libs.
 * Renders the icon, encodes a PNG with zlib and wraps it in an ICO.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 32, 48, 64, 128, 256];
const SUPERSAMPLE = 4;

// same colors as the terminal banner
const FIRE = [[120, 0, 12], [190, 18, 30], [225, 45, 35], [255, 105, 30]];
const BACKGROUND = [18, 10, 12];

function ramp(stops, position) {
    const clamped = Math.max(0, Math.min(1, position));
    const span = 1 / (stops.length - 1);
    const index = Math.min(stops.length - 2, Math.floor(clamped / span));
    const local = (clamped - index * span) / span;
    const [r1, g1, b1] = stops[index];
    const [r2, g2, b2] = stops[index + 1];
    return [
        r1 + (r2 - r1) * local,
        g1 + (g2 - g1) * local,
        b1 + (b2 - b1) * local
    ];
}

/** Shortest distance from a point to a line segment. */
function distanceToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSquared));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return Math.hypot(px - cx, py - cy);
}

// A W as four strokes, in a unit box with y increasing downwards.
const STROKES = [
    [0.13, 0.20, 0.31, 0.80],
    [0.31, 0.80, 0.50, 0.44],
    [0.50, 0.44, 0.69, 0.80],
    [0.69, 0.80, 0.87, 0.20]
];

/** Is this unit-space point inside the rounded background square? */
function insideRoundedSquare(x, y, radius) {
    const cx = Math.min(Math.max(x, radius), 1 - radius);
    const cy = Math.min(Math.max(y, radius), 1 - radius);
    return Math.hypot(x - cx, y - cy) <= radius;
}

/** Render one square RGBA bitmap. */
function renderRGBA(size) {
    const pixels = Buffer.alloc(size * size * 4);
    const thickness = 0.085;
    const radius = 0.22;

    for (let py = 0; py < size; py += 1) {
        for (let px = 0; px < size; px += 1) {
            let r = 0;
            let g = 0;
            let b = 0;
            let a = 0;

            // supersample, 16px is unreadable otherwise
            for (let sy = 0; sy < SUPERSAMPLE; sy += 1) {
                for (let sx = 0; sx < SUPERSAMPLE; sx += 1) {
                    const ux = (px + (sx + 0.5) / SUPERSAMPLE) / size;
                    const uy = (py + (sy + 0.5) / SUPERSAMPLE) / size;

                    if (!insideRoundedSquare(ux, uy, radius)) continue;

                    let onGlyph = false;
                    for (const [ax, ay, bx, by] of STROKES) {
                        if (distanceToSegment(ux, uy, ax, ay, bx, by) <= thickness / 2) {
                            onGlyph = true;
                            break;
                        }
                    }

                    const colour = onGlyph ? ramp(FIRE, uy) : BACKGROUND;
                    r += colour[0];
                    g += colour[1];
                    b += colour[2];
                    a += 255;
                }
            }

            const samples = SUPERSAMPLE * SUPERSAMPLE;
            const offset = (py * size + px) * 4;
            const alpha = a / samples;
            // un-premultiply edge pixels
            const scale = alpha > 0 ? samples / (a / 255) : 0;
            pixels[offset] = Math.round(Math.min(255, (r / samples) * scale));
            pixels[offset + 1] = Math.round(Math.min(255, (g / samples) * scale));
            pixels[offset + 2] = Math.round(Math.min(255, (b / samples) * scale));
            pixels[offset + 3] = Math.round(alpha);
        }
    }
    return pixels;
}

// --- PNG encoding -----------------------------------------------------------

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
        let c = n;
        for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buffer) {
    let c = 0xffffffff;
    for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
}

function encodePNG(size, rgba) {
    const header = Buffer.alloc(13);
    header.writeUInt32BE(size, 0);
    header.writeUInt32BE(size, 4);
    header[8] = 8; // bit depth
    header[9] = 6; // colour type: RGBA
    header[10] = 0;
    header[11] = 0;
    header[12] = 0;

    // Each scanline is prefixed with its filter type; 0 means none.
    const raw = Buffer.alloc(size * (size * 4 + 1));
    for (let y = 0; y < size; y += 1) {
        raw[y * (size * 4 + 1)] = 0;
        rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
    }

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk('IHDR', header),
        chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
        chunk('IEND', Buffer.alloc(0))
    ]);
}

// --- ICO container ----------------------------------------------------------

function encodeICO(images) {
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0); // reserved
    header.writeUInt16LE(1, 2); // type: icon
    header.writeUInt16LE(images.length, 4);

    const directory = Buffer.alloc(16 * images.length);
    let offset = header.length + directory.length;

    images.forEach((image, index) => {
        const entry = index * 16;
        // 256 is stored as 0
        directory[entry] = image.size >= 256 ? 0 : image.size;
        directory[entry + 1] = image.size >= 256 ? 0 : image.size;
        directory[entry + 2] = 0; // palette size
        directory[entry + 3] = 0; // reserved
        directory.writeUInt16LE(1, entry + 4); // colour planes
        directory.writeUInt16LE(32, entry + 6); // bits per pixel
        directory.writeUInt32LE(image.data.length, entry + 8);
        directory.writeUInt32LE(offset, entry + 12);
        offset += image.data.length;
    });

    return Buffer.concat([header, directory, ...images.map((i) => i.data)]);
}

function main() {
    const images = SIZES.map((size) => ({ size, data: encodePNG(size, renderRGBA(size)) }));
    const ico = encodeICO(images);

    const dir = path.join(__dirname, '..', 'assets');
    fs.mkdirSync(dir, { recursive: true });
    const target = path.join(dir, 'wrath.ico');
    fs.writeFileSync(target, ico);

    // also write a png
    fs.writeFileSync(path.join(dir, 'wrath.png'), images[images.length - 1].data);

    console.log(`Wrote ${target}`);
    console.log(`  ${images.length} sizes: ${SIZES.join(', ')}`);
    console.log(`  ${ico.length} bytes`);
}

main();
