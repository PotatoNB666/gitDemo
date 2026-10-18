/**
 * 画廊页逻辑
 *
 * 流程：
 *   1. 从 URL 的 ?id= 读取后台保存的提取结果（chrome.storage.session）；
 *   2. 网格化渲染缩略图，支持全选 / 反选 / 已选计数；
 *   3. 点击「下载选中」后，把勾选项发给 Service Worker；
 *   4. 监听 Service Worker 广播的进度消息，实时更新卡片状态与进度条。
 */

import { buildFileName, formatDimensions } from './lib/image-utils.js';

/* ------------------------------------------------------------------ *
 * 状态
 * ------------------------------------------------------------------ */
const state = {
  images: [],
  /** @type {Set<number>} 已勾选的图片下标 */
  selected: new Set(),
  /** @type {Map<number, {phase: string, message: string}>} 下载状态 */
  status: new Map(),
  running: false,
  taskId: null,
  gallery: null,
};

const dom = {};

/* ------------------------------------------------------------------ *
 * 基础工具
 * ------------------------------------------------------------------ */
function $(id) {
  return document.getElementById(id);
}

function cacheDom() {
  dom.meta = $('page-meta');
  dom.grid = $('grid');
  dom.empty = $('empty');
  dom.emptyTitle = $('empty-title');
  dom.emptyDesc = $('empty-desc');
  dom.latestBtn = $('latest-btn');
  dom.selectAll = $('select-all');
  dom.invert = $('invert-btn');
  dom.count = $('selected-count');
  dom.download = $('download-btn');
  dom.progress = $('progress');
  dom.progressFill = $('progress-fill');
  dom.progressText = $('progress-text');
  dom.banner = $('banner');
}

/** 与 Service Worker 通信（callback 形式转 Promise，方便 await） */
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
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */
function renderMeta() {
  const { gallery, images } = state;
  dom.meta.textContent = '';

  if (!gallery) return;

  const summary = document.createElement('span');
  const parts = [`共 ${images.length} 张图片`];
  if (gallery.platform) parts.push(gallery.platform);
  summary.textContent = `${parts.join(' · ')} · `;
  dom.meta.append(summary);

  if (gallery.pageUrl) {
    const link = document.createElement('a');
    link.href = gallery.pageUrl;
    link.target = '_blank';
    link.rel = 'noreferrer noopener';
    link.textContent = gallery.pageTitle ? truncate(gallery.pageTitle, 60) : '查看来源页面';
    dom.meta.append(link);
  } else if (gallery.pageTitle) {
    dom.meta.append(document.createTextNode(truncate(gallery.pageTitle, 60)));
  }

  if (gallery.createdAt) {
    dom.meta.append(document.createTextNode(` · ${formatTime(gallery.createdAt)}`));
  }
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

function createCard(image, index) {
  const total = state.images.length;
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.index = String(index);
  if (state.selected.has(index)) card.classList.add('is-selected');

  // 勾选框
  const checkLabel = document.createElement('label');
  checkLabel.className = 'card__check';
  const checkbox = document.createElement('input');
  checkbox.type = 'checkbox';
  checkbox.dataset.index = String(index);
  checkbox.checked = state.selected.has(index);
  checkbox.setAttribute('aria-label', `选择第 ${index + 1} 张图片`);
  checkLabel.append(checkbox);

  // 缩略图
  const thumb = document.createElement('div');
  thumb.className = 'card__thumb';
  const img = document.createElement('img');
  img.src = image.url;
  img.alt = `商品图 ${index + 1}`;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener(
    'error',
    () => {
      thumb.classList.add('is-broken');
    },
    { once: true },
  );
  thumb.append(img);

  // 信息区
  const body = document.createElement('div');
  body.className = 'card__body';

  const name = document.createElement('span');
  name.className = 'card__name';
  name.textContent = buildFileName(index + 1, total);

  const dim = document.createElement('span');
  dim.className = 'card__dim';
  const dims = formatDimensions(image.width, image.height);
  dim.textContent = dims === '尺寸未知' ? dims : `${dims} px`;

  const status = document.createElement('span');
  status.className = 'card__status';
  const current = state.status.get(index);
  if (current) {
    status.dataset.phase = current.phase;
    status.textContent = statusText(current.phase, current.message);
  }

  body.append(name, dim, status);
  card.append(checkLabel, thumb, body);
  return card;
}

function statusText(phase, message) {
  switch (phase) {
    case 'start':
      return '转换中…';
    case 'saving':
      return '保存中…';
    case 'done':
      return '已完成';
    case 'error':
      return `失败：${message || '未知原因'}`;
    default:
      return '';
  }
}

function renderGrid() {
  const fragment = document.createDocumentFragment();
  state.images.forEach((image, index) => {
    fragment.append(createCard(image, index));
  });
  dom.grid.replaceChildren(fragment);
}

function updateToolbar() {
  const total = state.images.length;
  const selectedCount = state.selected.size;

  dom.count.textContent = `已选 ${selectedCount} / ${total}`;
  dom.selectAll.checked = total > 0 && selectedCount === total;
  dom.selectAll.indeterminate = selectedCount > 0 && selectedCount < total;
  dom.download.disabled = state.running || selectedCount === 0;
  dom.download.textContent = state.running ? '下载中…' : '下载选中';
}

function showEmpty(title, desc, options = {}) {
  dom.empty.hidden = false;
  dom.grid.replaceChildren();
  dom.emptyTitle.textContent = title;
  dom.emptyDesc.textContent = desc;
  dom.latestBtn.hidden = !options.showLatest;
  dom.meta.textContent = title;
  dom.selectAll.disabled = true;
  dom.invert.disabled = true;
  dom.download.disabled = true;
  dom.count.textContent = '已选 0 / 0';
}

function showBanner(message, tone) {
  dom.banner.hidden = false;
  dom.banner.className = `banner banner--${tone}`;
  dom.banner.textContent = message;
}

function hideBanner() {
  dom.banner.hidden = true;
  dom.banner.textContent = '';
}

function setProgress(done, total, text, force = false) {
  const shouldShow = force || done > 0 || Boolean(text);
  dom.progress.hidden = !shouldShow;
  const percent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
  dom.progressFill.style.width = `${percent}%`;
  dom.progressText.textContent = text || '';
}

/* ------------------------------------------------------------------ *
 * 交互
 * ------------------------------------------------------------------ */
function applyGallery(gallery) {
  state.gallery = gallery;
  state.images = Array.isArray(gallery.images) ? gallery.images : [];
  state.selected = new Set(state.images.map((_, index) => index)); // 默认全选，方便直接下载
  state.status.clear();

  dom.empty.hidden = true;
  dom.selectAll.disabled = false;
  dom.invert.disabled = false;

  renderMeta();
  renderGrid();
  updateToolbar();
}

function toggleItem(index, checked) {
  if (!Number.isInteger(index)) return;

  if (checked) state.selected.add(index);
  else state.selected.delete(index);

  const card = dom.grid.querySelector(`.card[data-index="${index}"]`);
  card?.classList.toggle('is-selected', checked);
  updateToolbar();
}

function bindEvents() {
  dom.grid.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
    toggleItem(Number(target.dataset.index), target.checked);
  });

  dom.selectAll.addEventListener('change', () => {
    const checked = dom.selectAll.checked;
    state.selected = checked ? new Set(state.images.map((_, index) => index)) : new Set();

    dom.grid.querySelectorAll('.card').forEach((card) => {
      const index = Number(card.dataset.index);
      const checkbox = card.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = checked;
      card.classList.toggle('is-selected', checked);
    });

    updateToolbar();
  });

  dom.invert.addEventListener('click', () => {
    const next = new Set();
    state.images.forEach((_, index) => {
      if (!state.selected.has(index)) next.add(index);
    });
    state.selected = next;

    dom.grid.querySelectorAll('.card').forEach((card) => {
      const index = Number(card.dataset.index);
      const checked = state.selected.has(index);
      const checkbox = card.querySelector('input[type="checkbox"]');
      if (checkbox) checkbox.checked = checked;
      card.classList.toggle('is-selected', checked);
    });

    updateToolbar();
  });

  dom.download.addEventListener('click', () => {
    void startDownload();
  });

  dom.latestBtn.addEventListener('click', () => {
    void loadGallery(null);
  });

  chrome.runtime.onMessage.addListener(handleRuntimeMessage);
}

/* ------------------------------------------------------------------ *
 * 下载
 * ------------------------------------------------------------------ */
async function startDownload() {
  if (state.running) return;

  const items = [...state.selected]
    .sort((a, b) => a - b)
    .map((index) => ({ id: index, url: state.images[index].url }));

  if (!items.length) return;

  state.running = true;
  state.taskId = crypto.randomUUID();
  state.status.clear();
  items.forEach((item) => state.status.set(item.id, { phase: 'queued', message: '' }));

  hideBanner();
  renderGrid();
  updateToolbar();
  setProgress(0, items.length, `准备下载 ${items.length} 张图片…`, true);

  try {
    const response = await sendMessage({
      type: 'START_DOWNLOAD',
      taskId: state.taskId,
      items,
    });

    if (!response?.ok) throw new Error(response?.error || '下载任务启动失败');
  } catch (error) {
    state.running = false;
    state.taskId = null;
    updateToolbar();
    setProgress(0, 0, '');
    showBanner(`下载失败：${error?.message || error}`, 'error');
  }
}

/** 更新单张卡片的下载状态 */
function setItemStatus(itemId, phase, message = '') {
  state.status.set(itemId, { phase, message });

  const card = dom.grid.querySelector(`.card[data-index="${itemId}"]`);
  const statusEl = card?.querySelector('.card__status');
  if (!statusEl) return;

  if (phase === 'done' || phase === 'error' || phase === 'start' || phase === 'saving') {
    statusEl.dataset.phase = phase;
  } else {
    delete statusEl.dataset.phase;
  }
  statusEl.textContent = statusText(phase, message);
}

function handleRuntimeMessage(message) {
  if (!message || typeof message.type !== 'string') return;
  if (!state.taskId || message.taskId !== state.taskId) return;

  if (message.type === 'DOWNLOAD_PROGRESS') {
    const { itemId, index, total, phase, message: detail } = message;

    setItemStatus(itemId, phase, detail);

    const finished = phase === 'done' || phase === 'error' ? index : index - 1;
    setProgress(
      Math.max(0, finished),
      total,
      `${phase === 'error' ? '处理失败，继续下一张' : '正在处理'} ${index}/${total}`,
    );
    return;
  }

  if (message.type === 'DOWNLOAD_FINISHED') {
    state.running = false;

    const { total, success, failed } = message;

    if (failed > 0) {
      showBanner(`下载完成：成功 ${success} 张，失败 ${failed} 张。失败项已在卡片上标注原因。`, 'error');
    } else {
      showBanner(`全部完成：${success} 张图片已保存为 PNG，可在浏览器默认下载目录中查看。`, 'success');
    }

    setProgress(total, total, `已完成 ${total} 张`, true);
    updateToolbar();
  }
}

/* ------------------------------------------------------------------ *
 * 启动
 * ------------------------------------------------------------------ */
async function loadGallery(id) {
  try {
    const response = id
      ? await sendMessage({ type: 'GET_GALLERY', id })
      : await sendMessage({ type: 'GET_LATEST_GALLERY' });

    if (response?.ok && response.gallery) {
      applyGallery(response.gallery);
      return;
    }

    if (!id) {
      // 直接打开 gallery.html（没有 id）且后台也没有历史记录
      showEmpty('没有可用的提取记录', '请先到商品详情页点击「获取图片」按钮。');
      return;
    }

    showEmpty(
      '提取结果已失效',
      '提取结果保存在浏览器会话中，浏览器重启后会清空。请回到商品详情页重新提取。',
      { showLatest: true },
    );
  } catch (error) {
    showEmpty('读取提取结果失败', error?.message || String(error), { showLatest: Boolean(id) });
  }
}

async function init() {
  cacheDom();
  bindEvents();

  const id = new URLSearchParams(location.search).get('id');
  await loadGallery(id);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void init(), { once: true });
} else {
  void init();
}
