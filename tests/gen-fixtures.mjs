/**
 * 生成测试用 PNG 图片（无需任何第三方依赖）。
 * 运行：node tests/gen-fixtures.mjs
 */
import { deflateSync } from 'node:zlib';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'fixtures');

/* ---------------- 最小 PNG 编码器 ---------------- */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, 'ascii');
  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

/** 生成 RGBA PNG，colorAt(x, y, w, h) 返回 [r, g, b, a] */
function encodePng(width, height, colorAt) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // 每行 filter type = None
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = colorAt(x, y, width, height);
      const pointer = rowStart + 1 + x * 4;
      raw[pointer] = r;
      raw[pointer + 1] = g;
      raw[pointer + 2] = b;
      raw[pointer + 3] = a;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 渐变背景 + 棋盘格，方便肉眼区分不同测试图 */
function gradient(seed) {
  return (x, y, width, height) => {
    const ratioX = x / Math.max(1, width - 1);
    const ratioY = y / Math.max(1, height - 1);
    const checker = (Math.floor(x / 32) + Math.floor(y / 32)) % 2 === 0 ? 0 : 28;
    return [
      Math.round(40 + ratioX * 180 + seed * 10 + checker),
      Math.round(60 + ratioY * 150 + checker),
      Math.round(200 - ratioX * 120 + seed * 8 + checker),
      255,
    ];
  };
}

const fixtures = [
  { name: 'large.png', width: 320, height: 240, seed: 1 },
  { name: 'tiny.png', width: 60, height: 60, seed: 2 },
  { name: 'dot.png', width: 1, height: 1, seed: 3 },
  { name: 'lazy.png', width: 400, height: 300, seed: 4 },
  { name: 'bg.png', width: 500, height: 400, seed: 5 },
  { name: 'bg-small.png', width: 600, height: 600, seed: 6 },
  { name: 'logo.png', width: 200, height: 200, seed: 7 },
  { name: 'placeholder-blank.png', width: 10, height: 10, seed: 8 },
  { name: 'small.png', width: 120, height: 120, seed: 9 },
  { name: 'big.png', width: 640, height: 480, seed: 10 },
];

await mkdir(outDir, { recursive: true });

for (const fixture of fixtures) {
  const png = encodePng(fixture.width, fixture.height, gradient(fixture.seed));
  await writeFile(join(outDir, fixture.name), png);
}

console.log(`已生成 ${fixtures.length} 张测试图片 -> ${outDir}`);
