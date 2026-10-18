/**
 * 电商图片提取下载助手 · Content Script
 *
 * 职责：
 *   1. 仅在淘宝 / 天猫 / 京东 / 拼多多的"商品详情页"注入右下角悬浮按钮；
 *   2. 点击后扫描页面所有商品图片（img、srcset、懒加载属性、CSS 背景图）；
 *   3. 过滤噪音图（图标 / Logo / 占位图 / 小于 100×100）；
 *   4. 把结果通过 chrome.runtime.sendMessage 交给后台，由后台打开画廊页。
 *
 * 说明：内容脚本运行在隔离世界（Isolated World），不能使用 ES Module import，
 *      因此这里内置了一份与 lib/image-utils.js 等价的 URL 归一化实现。
 */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 0. 环境守卫
   * ------------------------------------------------------------------ */
  if (!globalThis.chrome?.runtime?.id) return; // 非扩展环境（普通网页）直接退出
  if (window.__ECOM_IMG_EXTRACTOR_LOADED__) return; // 防止重复注入
  window.__ECOM_IMG_EXTRACTOR_LOADED__ = true;

  /* ------------------------------------------------------------------ *
   * 1. 可调参数
   * ------------------------------------------------------------------ */
  const MIN_WIDTH = 100; // 小于该宽度的图片视为图标 / 占位图
  const MIN_HEIGHT = 100;
  const MAX_CANDIDATES = 300; // 单页最多处理多少个候选，防止超大页面卡死
  const MEASURE_CONCURRENCY = 6; // 并发探测图片真实尺寸的数量
  const MEASURE_TIMEOUT = 8000; // 单张图片探测超时
  const MEASURE_BUDGET = 20000; // 整体探测预算，超时后只保留已探测完成的
  const MAX_BG_ELEMENTS = 800; // 背景图扫描的元素上限
  const SYNC_INTERVAL = 1200; // 轮询检测 URL 变化 / 按钮是否被移除

  // 仅用于本地测试页（tests/harness.html）。隔离世界中页面脚本无法设置该标记，线上不受影响。
  const FORCE_ENABLE = (() => {
    try {
      return window.__ECOM_IMG_FORCE__ === true;
    } catch {
      return false;
    }
  })();

  /* ------------------------------------------------------------------ *
   * 2. 平台规则：域名 + 详情页 URL 特征 + 详情页 DOM 特征（商家后台 SPA 兜底）
   * ------------------------------------------------------------------ */
  const PLATFORM_RULES = [
    {
      key: 'taobao',
      label: '淘宝 / 天猫',
      hosts: ['taobao.com', 'tmall.com'],
      urlPatterns: [
        /\/item\.htm/i,
        /\/item\/\d+/i,
        /[?&](?:id|itemId)=\d{5,}/i,
        /#\/(?:[\w-]+\/)*(?:item|product|goods)(?:\/|\?|$)/i,
        /\/product\/detail/i,
      ],
      detailSelectors: [
        '#J_ImgBooth',
        '#J_UlThumb img',
        '.tb-gallery img',
        '[class*="PicGallery"] img',
        '[class*="picGallery"] img',
      ],
    },
    {
      key: 'jd',
      label: '京东',
      hosts: ['jd.com'],
      urlPatterns: [
        /\/\d{6,}\.html/i,
        /[?&](?:sku|skuId|wareId)=\d+/i,
        /#\/(?:[\w-]+\/)*(?:product|goods|item|ware)(?:\/|\?|$)/i,
        /\/product\/(?:detail|edit)/i,
      ],
      detailSelectors: ['#spec-img', '#spec-list img', '.preview-wrap', '[class*="sku-preview"] img'],
    },
    {
      key: 'pdd',
      label: '拼多多',
      hosts: ['pinduoduo.com', 'yangkeduo.com'],
      urlPatterns: [
        /\/goods(?:\d+)?\.html/i,
        /[?&](?:goods_id|goodsId|goodsID)=\d+/i,
        /\/goods\/(?:goods_)?detail/i,
        /#\/(?:[\w-]+\/)*(?:goods|product|item)(?:\/|\?|$)/i,
      ],
      detailSelectors: [
        '[class*="goods-detail"] img',
        '[class*="goodsDetail"] img',
        '[class*="GoodsDetail"] img',
        '[class*="detail-swiper"] img',
        '[class*="goodsSwiper"] img',
      ],
    },
  ];

  function findPlatformByHost() {
    const host = location.hostname.toLowerCase();
    return (
      PLATFORM_RULES.find((rule) =>
        rule.hosts.some((suffix) => host === suffix || host.endsWith(`.${suffix}`)),
      ) || null
    );
  }

  function queryAny(selectors) {
    for (const selector of selectors) {
      try {
        if (document.querySelector(selector)) return true;
      } catch {
        /* 忽略非法选择器 */
      }
    }
    return false;
  }

  /** 当前页面是否是受支持的商品详情页 */
  function isProductDetailPage() {
    if (FORCE_ENABLE) return true;

    const platform = findPlatformByHost();
    if (!platform) return false;

    if (platform.urlPatterns.some((pattern) => pattern.test(location.href))) return true;

    // 商家后台多为 hash 路由（如 mms.pinduoduo.com/goods/goods_detail?goods_id=xxx），
    // URL 规则覆盖不到时，用详情页独有的 DOM 结构兜底。
    return queryAny(platform.detailSelectors);
  }

  /* ------------------------------------------------------------------ *
   * 3. URL 归一化与噪音过滤（与 lib/image-utils.js 保持一致）
   * ------------------------------------------------------------------ */
  const TAOBAO_CDN_SUFFIXES = ['alicdn.com', 'tbcdn.cn', 'taobaocdn.com'];
  const JD_CDN_SUFFIXES = ['360buyimg.com', 'jdimg.com'];
  const PDD_CDN_SUFFIXES = ['pddpic.com', 'yangkeduo.com', 'pinduoduo.com'];

  const NOISE_URL_PATTERN = new RegExp(
    [
      '(?:^|[/_.\\-])(?:logo|icon|sprite|spacer|blank|pixel|tracking|transparent|placeholder|lazyload|loading|avatar|qrcode|qr_code|noimage|no_image|no-image|default_img|default-img|defaultpic)(?:[/_.\\-]|$)',
      '(?:^|[/_.\\-])1x1(?:[/_.\\-]|$)',
      '\\.svg(?:$|[?#])',
    ].join('|'),
    'i',
  );

  function hostBelongsTo(hostname, suffixes) {
    const host = hostname.toLowerCase();
    return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  }

  function stripTaobaoSizeSuffix(pathname) {
    return pathname
      .replace(/(\.(?:jpe?g|png|gif|webp|avif))_\.(?:webp|avif)$/i, '$1')
      .replace(
        /(\.(?:jpe?g|png|gif|webp|avif))(?:_\d+x\d+[a-z0-9]*)?(?:_q\d+)?(?:\.(?:jpe?g|png|gif|webp|avif))?$/i,
        '$1',
      )
      .replace(/_q\d+\.(?:jpe?g|png|gif|webp|avif)$/i, '');
  }

  function normalizeImageUrl(raw) {
    if (typeof raw !== 'string') return null;

    let value = raw.trim();
    if (!value) return null;

    value = value.replace(/^['"]+|['"]+$/g, '');
    if (!value) return null;
    if (/^(?:data|blob|javascript|about|file):/i.test(value)) return null;

    let url;
    try {
      url = new URL(value, location.href);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

    const host = url.hostname.toLowerCase();

    if (
      url.protocol === 'http:' &&
      (hostBelongsTo(host, TAOBAO_CDN_SUFFIXES) ||
        hostBelongsTo(host, JD_CDN_SUFFIXES) ||
        hostBelongsTo(host, PDD_CDN_SUFFIXES))
    ) {
      url.protocol = 'https:';
    }

    if (hostBelongsTo(host, TAOBAO_CDN_SUFFIXES)) {
      url.pathname = stripTaobaoSizeSuffix(url.pathname);
    } else if (hostBelongsTo(host, JD_CDN_SUFFIXES)) {
      let pathname = url.pathname.replace(/\/n\d+\//g, '/').replace(/\/s\d+x\d+_/g, '/');
      const bangIndex = pathname.indexOf('!');
      if (bangIndex > 0) pathname = pathname.slice(0, bangIndex);
      url.pathname = pathname;
    } else if (hostBelongsTo(host, PDD_CDN_SUFFIXES)) {
      url.pathname = url.pathname.replace(/!\d+x\d+.*$/, '');
      url.search = '';
    }

    url.hash = '';

    // 去重键忽略 query，避免同一张图的缩放参数造成重复
    return { url: url.href, key: `${url.protocol}//${url.host}${url.pathname}` };
  }

  function isNoiseUrl(urlString) {
    return NOISE_URL_PATTERN.test(urlString);
  }

  /* ------------------------------------------------------------------ *
   * 4. 图片收集
   * ------------------------------------------------------------------ */
  const LAZY_ATTRIBUTES = [
    'data-src',
    'data-lazy-src',
    'data-original',
    'data-ks-lazyload', // 京东常用
    'data-lazyload',
    'data-lazy',
    'data-lazy-img',
    'data-url',
    'data-img',
    'data-image',
    'data-actualsrc',
    'data-origin-src',
    'data-original-src',
    'data-lazysrc',
    'data-echo',
    'data-srcset', // 懒加载 srcset
  ];

  /** 解析 srcset，返回按宽度降序的列表 */
  function parseSrcset(value) {
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

  function pickLargestSrcset(value) {
    const list = parseSrcset(value);
    return list.length ? list[0].url : null;
  }

  /** 从 CSS background-image 值中提取所有 url(...) */
  function extractCssUrls(backgroundImage) {
    const urls = [];
    const pattern = /url\((['"]?)([^'")]+)\1\)/gi;
    let match;
    while ((match = pattern.exec(backgroundImage))) {
      if (match[2]) urls.push(match[2]);
    }
    return urls;
  }

  /** 用 Image 对象加载一次，拿到真实像素尺寸（懒加载图也能处理） */
  function measureImageSize(url) {
    return new Promise((resolve) => {
      const image = new Image();
      let settled = false;

      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        image.onload = null;
        image.onerror = null;
        resolve(value);
      };

      const timer = setTimeout(() => finish(null), MEASURE_TIMEOUT);

      image.onload = () => {
        const width = image.naturalWidth;
        const height = image.naturalHeight;
        finish(width > 0 && height > 0 ? { width, height } : null);
      };
      image.onerror = () => finish(null);
      image.src = url;
    });
  }

  /** 带并发上限的任务池，budgetMs 到期后停止派发新任务 */
  async function runWithConcurrency(items, limit, worker, budgetMs) {
    let cursor = 0;
    let stopped = false;
    const timer = budgetMs ? setTimeout(() => { stopped = true; }, budgetMs) : null;

    const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (!stopped) {
        const index = cursor;
        cursor += 1;
        if (index >= items.length) break;
        try {
          await worker(items[index], index);
        } catch {
          /* 单张失败不影响整体 */
        }
      }
    });

    await Promise.all(runners);
    if (timer) clearTimeout(timer);
  }

  /**
   * 扫描页面图片，返回 { images, candidates }。
   * images 已按尺寸 / 噪音规则过滤，可直接交给画廊页。
   */
  async function extractImages(onProgress) {
    /** @type {Map<string, {url:string,width:number,height:number,source:string}>} */
    const candidates = new Map();

    const addCandidate = (rawUrl, extra = {}) => {
      if (candidates.size >= MAX_CANDIDATES) return;
      const normalized = normalizeImageUrl(rawUrl);
      if (!normalized) return;
      if (isNoiseUrl(normalized.url)) return;

      const existing = candidates.get(normalized.key);
      if (existing) {
        // 同图不同尺寸参数：补全缺失的尺寸信息
        if (!existing.width && extra.width) {
          existing.width = extra.width;
          existing.height = extra.height || 0;
        }
        return;
      }

      candidates.set(normalized.key, {
        url: normalized.url,
        width: extra.width || 0,
        height: extra.height || 0,
        source: extra.source || 'unknown',
      });
    };

    // ---- 4.1 <img>：currentSrc / src / srcset / 各类懒加载属性 ----
    document.querySelectorAll('img').forEach((image) => {
      const loaded =
        image.complete && image.naturalWidth > 0
          ? { width: image.naturalWidth, height: image.naturalHeight }
          : {};

      if (image.currentSrc) addCandidate(image.currentSrc, { ...loaded, source: 'img.currentSrc' });

      const src = image.getAttribute('src');
      if (src) addCandidate(src, { ...loaded, source: 'img.src' });

      const srcset = image.getAttribute('srcset');
      if (srcset) {
        const largest = pickLargestSrcset(srcset);
        if (largest) addCandidate(largest, { ...loaded, source: 'img.srcset' });
      }

      for (const attribute of LAZY_ATTRIBUTES) {
        const value = image.getAttribute(attribute);
        if (!value) continue;
        if (attribute.endsWith('srcset')) {
          const largest = pickLargestSrcset(value);
          if (largest) addCandidate(largest, { source: `img.${attribute}` });
        } else {
          addCandidate(value, { source: `img.${attribute}` });
        }
      }
    });

    // ---- 4.2 <picture><source srcset> ----
    document.querySelectorAll('picture source[srcset]').forEach((source) => {
      const largest = pickLargestSrcset(source.getAttribute('srcset') || '');
      if (largest) addCandidate(largest, { source: 'picture.source' });
    });

    // ---- 4.3 CSS 背景图（商品图轮播、主图容器常用背景图实现） ----
    const bgSelector = [
      '[style*="background"]',
      '[class*="img"]',
      '[class*="pic"]',
      '[class*="photo"]',
      '[class*="thumb"]',
      '[class*="banner"]',
      '[class*="gallery"]',
      '[class*="swiper"]',
      '[class*="slide"]',
      '[class*="carousel"]',
    ].join(',');

    const bgNodes = document.querySelectorAll(bgSelector);
    const bgLimit = Math.min(bgNodes.length, MAX_BG_ELEMENTS);

    for (let index = 0; index < bgLimit; index += 1) {
      const node = bgNodes[index];
      if (node.tagName === 'IMG') continue;
      const elementWidth = node.offsetWidth;
      const elementHeight = node.offsetHeight;
      // 容器本身太小，多半是图标 / 装饰
      if (elementWidth < MIN_WIDTH || elementHeight < MIN_HEIGHT) continue;

      const backgroundImage = getComputedStyle(node).backgroundImage;
      if (!backgroundImage || backgroundImage === 'none') continue;

      for (const cssUrl of extractCssUrls(backgroundImage)) {
        addCandidate(cssUrl, { source: 'css.background' });
      }
    }

    // ---- 4.4 探测真实尺寸（已加载的 img 直接复用 naturalWidth） ----
    const list = [...candidates.values()];
    const total = list.length;
    let finished = 0;
    onProgress?.(0, total);

    await runWithConcurrency(
      list,
      MEASURE_CONCURRENCY,
      async (item) => {
        if (!item.width || !item.height) {
          const size = await measureImageSize(item.url);
          if (size) {
            item.width = size.width;
            item.height = size.height;
          }
        }
        finished += 1;
        onProgress?.(finished, total);
      },
      MEASURE_BUDGET,
    );

    // ---- 4.5 尺寸过滤：去掉图标 / 占位图 / 1x1 像素 ----
    const images = list
      .filter((item) => item.width >= MIN_WIDTH && item.height >= MIN_HEIGHT)
      .map((item) => ({ url: item.url, width: item.width, height: item.height }));

    return { images, candidates: list.length };
  }

  /* ------------------------------------------------------------------ *
   * 5. 悬浮按钮（Shadow DOM，避免被页面全局样式污染）
   * ------------------------------------------------------------------ */
  const BUTTON_LABEL = '获取图片';
  let ui = null;
  let busy = false;

  function createUI() {
    if (ui) return ui;

    const host = document.createElement('div');
    host.id = 'ecom-img-extractor-host';
    host.style.cssText = [
      'all: initial',
      'position: fixed',
      'right: 24px',
      'bottom: 96px', // 抬高一点，避开页面右下角的"回到顶部"等操作
      'z-index: 2147483646',
      'pointer-events: auto',
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });

    // 通过 web_accessible_resources 引入样式，保证与页面样式完全隔离
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL('content.css');

    const wrap = document.createElement('div');
    wrap.className = 'ecom-extractor';
    wrap.innerHTML = `
      <button type="button" class="ecom-extractor__btn" title="提取当前页面的商品图片">
        <svg class="ecom-extractor__icon" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <rect x="3" y="4" width="18" height="16" rx="3" stroke="currentColor" stroke-width="1.8"/>
          <circle cx="8.5" cy="9.5" r="1.8" fill="currentColor"/>
          <path d="M4 17.5l4.6-4.6a1.5 1.5 0 0 1 2.1 0l2.5 2.5 1.9-1.9a1.5 1.5 0 0 1 2.1 0L20 16"
                stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="ecom-extractor__text">${BUTTON_LABEL}</span>
      </button>
      <div class="ecom-extractor__toast" role="status" aria-live="polite" hidden></div>
    `;

    shadow.append(link, wrap);

    const button = wrap.querySelector('.ecom-extractor__btn');
    const buttonText = wrap.querySelector('.ecom-extractor__text');
    const toast = wrap.querySelector('.ecom-extractor__toast');

    button.addEventListener('click', (event) => {
      // 阻止事件冒泡，避免触发商品页自身的点击逻辑
      event.preventDefault();
      event.stopPropagation();
      void handleExtractClick();
    });

    ui = { host, shadow, button, buttonText, toast, toastTimer: 0 };
    return ui;
  }

  function setButton(text, disabled) {
    const { button, buttonText } = createUI();
    buttonText.textContent = text;
    button.disabled = Boolean(disabled);
  }

  function showToast(message, tone = 'info', duration = 2600) {
    const { toast } = createUI();
    toast.textContent = message;
    toast.className = `ecom-extractor__toast ecom-extractor__toast--${tone}`;
    toast.hidden = false;
    clearTimeout(ui.toastTimer);
    ui.toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, duration);
  }

  /* ------------------------------------------------------------------ *
   * 6. 与后台通信
   * ------------------------------------------------------------------ */
  function sendMessage(message) {
    return new Promise((resolve, reject) => {
      try {
        chrome.runtime.sendMessage(message, (response) => {
          const error = chrome.runtime.lastError;
          if (error) {
            reject(new Error(error.message));
            return;
          }
          resolve(response);
        });
      } catch (error) {
        // 扩展被重新加载后，旧的内容脚本上下文会失效
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /* ------------------------------------------------------------------ *
   * 7. 点击"获取图片"
   * ------------------------------------------------------------------ */
  async function handleExtractClick() {
    if (busy) return;
    busy = true;
    setButton('准备提取…', true);

    try {
      const platform = findPlatformByHost();
      const result = await extractImages((done, total) => {
        if (total > 0 && done < total) setButton(`提取中 ${done}/${total}`, true);
      });

      if (!result.images.length) {
        showToast('未找到符合条件的商品图片，请等页面图片加载完成后再试', 'warn', 4200);
        return;
      }

      const response = await sendMessage({
        type: 'OPEN_GALLERY',
        data: {
          images: result.images,
          pageUrl: location.href,
          pageTitle: document.title,
          platform: platform ? platform.label : '',
        },
      });

      if (!response?.ok) throw new Error(response?.error || '打开图片面板失败');

      showToast(`已提取 ${result.images.length} 张图片`, 'ok');
    } catch (error) {
      showToast(`提取失败：${error?.message || error}`, 'error', 5200);
    } finally {
      busy = false;
      setButton(BUTTON_LABEL, false);
    }
  }

  /* ------------------------------------------------------------------ *
   * 8. 生命周期：SPA 路由变化时同步按钮显隐
   * ------------------------------------------------------------------ */
  function syncVisibility() {
    try {
      if (!isProductDetailPage()) {
        if (ui?.host.isConnected) ui.host.remove();
        return;
      }
      const { host } = createUI();
      if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    } catch {
      /* 页面结构异常时静默忽略，下一轮轮询会重试 */
    }
  }

  syncVisibility();
  setInterval(syncVisibility, SYNC_INTERVAL);
  window.addEventListener('popstate', syncVisibility);
  window.addEventListener('hashchange', syncVisibility);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncVisibility, { once: true });
  }

  // 点击扩展图标时，由后台转发该消息，直接触发一次提取
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'TRIGGER_EXTRACT') return false;

    if (!isProductDetailPage()) {
      sendResponse({ ok: false, error: '当前页面不是支持的商品详情页' });
      return false;
    }

    handleExtractClick()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error?.message || error) }));
    return true; // 异步响应
  });
})();
