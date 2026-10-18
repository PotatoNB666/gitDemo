/**
 * lib/image-utils.js 单元测试
 * 运行：npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildFileName,
  buildDedupeKey,
  formatDimensions,
  hasImageExtension,
  isNoiseImageUrl,
  normalizeImageUrl,
  padIndex,
  parseSrcset,
  pickLargestFromSrcset,
} from '../lib/image-utils.js';

const BASE = 'https://detail.tmall.com/item.htm?id=123456789';

test('相对路径会补全为绝对 URL', () => {
  const result = normalizeImageUrl('../images/a.jpg', BASE);
  assert.equal(result.url, 'https://detail.tmall.com/images/a.jpg');
});

test('协议相对路径升级为 https', () => {
  const result = normalizeImageUrl('//img.alicdn.com/imgextra/i1/a.jpg', BASE);
  assert.equal(result.url, 'https://img.alicdn.com/imgextra/i1/a.jpg');
});

test('淘宝 CDN 缩放后缀会被去掉，拿到原图', () => {
  const variants = [
    'https://img.alicdn.com/imgextra/i1/O1CN01abc_!!0-item_pic.jpg_430x430q90.jpg',
    'https://img.alicdn.com/imgextra/i1/O1CN01abc_!!0-item_pic.jpg_.webp',
    'https://img.alicdn.com/imgextra/i1/O1CN01abc_!!0-item_pic.jpg_q90.jpg',
  ];
  const expected = 'https://img.alicdn.com/imgextra/i1/O1CN01abc_!!0-item_pic.jpg';

  for (const variant of variants) {
    assert.equal(normalizeImageUrl(variant, BASE).url, expected, variant);
  }
});

test('同一张图的不同尺寸参数去重键相同', () => {
  const a = normalizeImageUrl(
    'https://img.alicdn.com/imgextra/i1/abc.jpg_430x430q90.jpg',
    BASE,
  );
  const b = normalizeImageUrl('https://img.alicdn.com/imgextra/i1/abc.jpg', BASE);
  assert.equal(a.key, b.key);
});

test('京东 CDN 去掉 n0 / s450x450 前缀与图片处理后缀', () => {
  const input = 'https://img14.360buyimg.com/n0/s450x450_jfs/t1/123/abc.jpg!/fw/450/fw/450/quality/70';
  const result = normalizeImageUrl(input, BASE);
  assert.equal(result.url, 'https://img14.360buyimg.com/jfs/t1/123/abc.jpg');
});

test('拼多多 CDN 去掉 imageMogr2 缩放参数', () => {
  const input =
    'https://img.pddpic.com/mms-material-img/2022-06-16/abc.jpeg?imageMogr2/thumbnail/430x430/format/webp';
  const result = normalizeImageUrl(input, BASE);
  assert.equal(result.url, 'https://img.pddpic.com/mms-material-img/2022-06-16/abc.jpeg');
});

test('data: / blob: / javascript: 地址会被忽略', () => {
  assert.equal(normalizeImageUrl('data:image/png;base64,AAAA', BASE), null);
  assert.equal(normalizeImageUrl('blob:https://x.com/123', BASE), null);
  assert.equal(normalizeImageUrl('javascript:void(0)', BASE), null);
});

test('带引号的 CSS 地址可以正确解析', () => {
  const result = normalizeImageUrl('"//img.alicdn.com/a.png"', BASE);
  assert.equal(result.url, 'https://img.alicdn.com/a.png');
});

test('图标 / Logo / 占位图会被判为噪音', () => {
  const noise = [
    'https://img.alicdn.com/bao/uploaded/i1/TB1/logo.png',
    'https://img.alicdn.com/bao/uploaded/icon-share.png',
    'https://img.alicdn.com/imgextra/i1/placeholder.jpg',
    'https://img.alicdn.com/imgextra/i1/1x1.gif',
    'https://cdn.example.com/assets/x.svg',
  ];
  for (const url of noise) {
    assert.equal(isNoiseImageUrl(url), true, url);
  }

  const valid = [
    'https://img.alicdn.com/imgextra/i1/O1CN01abc_!!0-item_pic.jpg',
    'https://img14.360buyimg.com/jfs/t1/123/abc.jpg',
    // logotype 不属于 logo 边界匹配，不应误杀
    'https://img.alicdn.com/imgextra/i1/logotype-print.jpg',
  ];
  for (const url of valid) {
    assert.equal(isNoiseImageUrl(url), false, url);
  }
});

test('文件名补零规则', () => {
  assert.equal(buildFileName(1, 8), '商品图_001.png');
  assert.equal(buildFileName(12, 120), '商品图_012.png');
  assert.equal(buildFileName(7, 1200), '商品图_0007.png');
  assert.equal(buildFileName(999, 999), '商品图_999.png');
});

test('padIndex 至少补到 3 位', () => {
  assert.equal(padIndex(3, 9), '003');
  assert.equal(padIndex(3, 100), '003');
  assert.equal(padIndex(3, 10000), '00003');
});

test('尺寸文案格式化', () => {
  assert.equal(formatDimensions(800, 800), '800 × 800');
  assert.equal(formatDimensions(0, 0), '尺寸未知');
  assert.equal(formatDimensions(799.6, 600.2), '800 × 600');
});

test('srcset 按宽度降序解析，取最大一张', () => {
  const srcset = 'a.jpg 400w, b.jpg 800w, c.jpg 200w';
  assert.deepEqual(
    parseSrcset(srcset).map((item) => item.url),
    ['b.jpg', 'a.jpg', 'c.jpg'],
  );
  assert.equal(pickLargestFromSrcset(srcset), 'b.jpg');
  assert.equal(pickLargestFromSrcset(''), null);
});

test('扩展名白名单', () => {
  assert.equal(hasImageExtension('https://a.com/x.jpg'), true);
  assert.equal(hasImageExtension('https://a.com/x.webp?x=1'), true);
  assert.equal(hasImageExtension('https://a.com/x.svg'), false);
  assert.equal(hasImageExtension('https://a.com/no-ext'), true);
});

test('去重键忽略 query 和 hash', () => {
  assert.equal(
    buildDedupeKey('https://a.com/img.jpg?x=1#frag'),
    'https://a.com/img.jpg',
  );
});
