/**
 * 图片通用工具（ES Module）
 *
 * 被 background.js（Service Worker）与 gallery.js（扩展页面）共享，
 * 同时可以被 Node 单元测试直接 import，保证"同一套规则只实现一次"。
 *
 * 注意：content.js 运行在内容脚本的隔离世界里，无法 import ES Module，
 * 因此那份 URL 归一化逻辑是等价的独立实现（详见 content.js 中的说明）。
 */

/** 淘宝 / 天猫图片 CDN 域名后缀 */
const TAOBAO_CDN_SUFFIXES = ['alicdn.com', 'tbcdn.cn', 'taobaocdn.com'];
/** 京东图片 CDN 域名后缀 */
const JD_CDN_SUFFIXES = ['360buyimg.com', 'jdimg.com'];
/** 拼多多图片 CDN 域名后缀 */
const PDD_CDN_SUFFIXES = ['pddpic.com', 'yangkeduo.com', 'pinduoduo.com'];

/** 允许的图片扩展名（svg 是矢量图标，canvas 转换不可靠，直接排除） */
const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp'];

/**
 * 噪音图片特征：图标、Logo、占位图、埋点像素、1x1 图等。
 * 使用"边界字符"匹配，避免把 logotype.jpg 这类正常商品图误杀。
 */
const NOISE_URL_PATTERN = new RegExp(
  [
    '(?:^|[/_.\\-])(?:logo|icon|sprite|spacer|blank|pixel|tracking|transparent|placeholder|lazyload|loading|avatar|qrcode|qr_code|noimage|no_image|no-image|default_img|default-img|defaultpic)(?:[/_.\\-]|$)',
    '(?:^|[/_.\\-])1x1(?:[/_.\\-]|$)',
    '\\.svg(?:$|[?#])',
  ].join('|'),
  'i',
);

/** 判断 hostname 是否命中域名后缀列表（支持子域名） */
export function hostMatches(hostname, suffixes) {
  const host = String(hostname || '').toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * 去掉淘宝 / 天猫 CDN 的缩放后缀，尽量拿到原图。
 * 例：
 *   xxx.jpg_430x430q90.jpg  -> xxx.jpg
 *   xxx.jpg_.webp           -> xxx.jpg
 *   xxx.jpg_q90.jpg         -> xxx.jpg
 */
function stripTaobaoSizeSuffix(pathname) {
  return pathname
    .replace(/(\.(?:jpe?g|png|gif|webp|avif))_\.(?:webp|avif)$/i, '$1')
    .replace(
      /(\.(?:jpe?g|png|gif|webp|avif))(?:_\d+x\d+[a-z0-9]*)?(?:_q\d+)?(?:\.(?:jpe?g|png|gif|webp|avif))?$/i,
      '$1',
    )
    .replace(/_q\d+\.(?:jpe?g|png|gif|webp|avif)$/i, '');
}

/**
 * 去掉京东 CDN 的尺寸前缀与图片处理参数。
 * 例：
 *   /n0/s450x450_jfs/t1/xxx.jpg -> /jfs/t1/xxx.jpg
 *   /jfs/t1/xxx.jpg!/fw/450/... -> /jfs/t1/xxx.jpg
 */
function stripJdSizeSuffix(url) {
  let pathname = url.pathname
    .replace(/\/n\d+\//g, '/')
    .replace(/\/s\d+x\d+_/g, '/');
  const bangIndex = pathname.indexOf('!');
  if (bangIndex > 0) pathname = pathname.slice(0, bangIndex);
  url.pathname = pathname;
}

/**
 * 去掉拼多多 CDN 的缩放参数。
 * 例：
 *   xxx.jpeg?imageMogr2/thumbnail/430x430/format/webp -> xxx.jpeg
 */
function stripPddSizeSuffix(url) {
  url.pathname = url.pathname.replace(/!\d+x\d+.*$/, '');
  url.search = '';
}

/**
 * 把页面里拿到的任意图片地址归一化为"绝对且尽量高清"的 URL。
 *
 * @param {string} raw 原始地址（可能带引号、协议相对、data: 等）
 * @param {string} baseUrl 相对路径的基准地址，通常是当前页面 URL
 * @returns {{ url: string, key: string } | null} key 用于去重
 */
export function normalizeImageUrl(raw, baseUrl = 'https://example.com/') {
  if (typeof raw !== 'string') return null;

  let value = raw.trim();
  if (!value) return null;

  // 去掉 CSS 中可能出现的包裹引号
  value = value.replace(/^['"]+|['"]+$/g, '');
  if (!value) return null;

  // 这些协议的图片无法用于 canvas 转换 / 下载，直接忽略
  if (/^(?:data|blob|javascript|about|file):/i.test(value)) return null;

  let url;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const host = url.hostname.toLowerCase();

  // 平台 CDN 都支持 https，统一升级可避免混合内容问题
  if (url.protocol === 'http:' && (
    hostMatches(host, TAOBAO_CDN_SUFFIXES) ||
    hostMatches(host, JD_CDN_SUFFIXES) ||
    hostMatches(host, PDD_CDN_SUFFIXES)
  )) {
    url.protocol = 'https:';
  }

  if (hostMatches(host, TAOBAO_CDN_SUFFIXES)) {
    url.pathname = stripTaobaoSizeSuffix(url.pathname);
  } else if (hostMatches(host, JD_CDN_SUFFIXES)) {
    stripJdSizeSuffix(url);
  } else if (hostMatches(host, PDD_CDN_SUFFIXES)) {
    stripPddSizeSuffix(url);
  }

  url.hash = '';

  return { url: url.href, key: buildDedupeKey(url) };
}

/**
 * 去重键：忽略 query 与 hash。
 * 同一个商品图常以不同尺寸参数出现多次，按路径去重即可。
 */
export function buildDedupeKey(urlOrString) {
  const url = urlOrString instanceof URL ? urlOrString : new URL(urlOrString);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

/** 是否是明显无用的图片（图标 / 占位图 / 埋点等） */
export function isNoiseImageUrl(urlString) {
  if (!urlString) return true;
  return NOISE_URL_PATTERN.test(urlString);
}

/** 扩展名是否在白名单内（无法判断扩展名时按可信处理，交给尺寸过滤兜底） */
export function hasImageExtension(urlString) {
  try {
    const { pathname } = new URL(urlString);
    const match = pathname.match(/\.([a-z0-9]+)$/i);
    if (!match) return true;
    return IMAGE_EXTENSIONS.includes(match[1].toLowerCase());
  } catch {
    return false;
  }
}

/** 序号补零：total 决定最小位数，至少 3 位 */
export function padIndex(index, total) {
  const width = Math.max(3, String(Math.max(total, index)).length);
  return String(index).padStart(width, '0');
}

/**
 * 生成下载文件名：商品图_001.png
 * @param {number} index 1 开始的序号
 * @param {number} total 本次下载总数
 */
export function buildFileName(index, total = index) {
  return `商品图_${padIndex(index, total)}.png`;
}

/** 尺寸展示文案，例如 "800 × 800" */
export function formatDimensions(width, height) {
  if (!width || !height) return '尺寸未知';
  return `${Math.round(width)} × ${Math.round(height)}`;
}

/** 文件大小展示文案 */
export function formatFileSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const digits = value >= 100 || unitIndex === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unitIndex]}`;
}

/**
 * 解析 srcset，按声明的宽度从大到小排序。
 * 例："a.jpg 400w, b.jpg 800w" -> [{url:'b.jpg', width:800}, {url:'a.jpg', width:400}]
 */
export function parseSrcset(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [url, descriptor = ''] = part.split(/\s+/);
      const widthMatch = descriptor.match(/^(\d+)w$/i);
      return { url, width: widthMatch ? Number(widthMatch[1]) : 0 };
    })
    .filter((item) => Boolean(item.url))
    .sort((a, b) => b.width - a.width);
}

/** 从 srcset 里挑出最大的一张 */
export function pickLargestFromSrcset(value) {
  const list = parseSrcset(value);
  return list.length ? list[0].url : null;
}
