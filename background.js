/**
 * Service Worker（Manifest V3 后台）
 *
 * 职责：
 *   1. 接收内容脚本的图片列表，写入 chrome.storage.session 并打开画廊页；
 *   2. 接收画廊页的批量下载请求；
 *   3. 在后台 fetch 图片 -> createImageBitmap -> OffscreenCanvas 转 PNG；
 *   4. 通过 chrome.downloads.download 触发下载，并把进度广播回画廊页。
 *
 * 之所以把"转换 PNG"放在 Service Worker：
 *   扩展页面直接 fetch 图片受页面 CORS 限制较少，而 host_permissions 下的 fetch
 *   可以拿到图片字节，再交给 createImageBitmap 解码就不会产生 canvas 污染问题。
 */

import { buildFileName } from './lib/image-utils.js';

/** 画廊数据在 session storage 中的 key 前缀 */
const GALLERY_KEY_PREFIX = 'gallery:';
/** 最多保留多少份提取结果 */
const MAX_GALLERY_RECORDS = 10;

/**
 * 已提交给 chrome.downloads 的 blob 下载。
 * 下载结束后需要释放 blob URL；若下载被中断则用 data URL 兜底重试一次。
 * @type {Map<number, {objectUrl: string, blob: Blob, filename: string, retried: boolean}>}
 */
const pendingDownloads = new Map();

/* ------------------------------------------------------------------ *
 * 工具函数
 * ------------------------------------------------------------------ */

/** 向所有扩展上下文（画廊页）广播消息 */
function broadcast(message) {
  // 没有接收方时会 reject，这里忽略即可
  chrome.runtime.sendMessage(message).catch(() => {});
}

/** Blob -> data URL（Service Worker 中没有 FileReader，需要手动 base64） */
export async function blobToDataUrl(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`;
}

/**
 * 把任意图片 Blob 转成 PNG Blob。
 * 已经是 PNG 的图片直接透传，避免无意义的重新编码（体积和清晰度都不会变化）。
 */
export async function convertBlobToPng(blob) {
  if (!blob || !blob.size) throw new Error('图片内容为空');
  if (blob.type === 'image/png') return blob;

  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new Error('图片解码失败（可能是不支持的图片格式）');
  }

  try {
    const width = bitmap.width;
    const height = bitmap.height;
    if (!width || !height) throw new Error('无法读取图片尺寸');

    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('无法创建画布上下文');

    // 保持透明通道：不额外填充背景色
    context.drawImage(bitmap, 0, 0);

    const pngBlob = await canvas.convertToBlob({ type: 'image/png' });
    if (!pngBlob || pngBlob.type !== 'image/png') throw new Error('PNG 编码失败');
    return pngBlob;
  } finally {
    bitmap.close?.();
  }
}

/** 拉取图片并转成 PNG Blob */
export async function fetchAsPng(url) {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) {
    throw new Error('图片地址无效');
  }

  // credentials: omit 避免把平台登录态 cookie 带到图片 CDN；
  // referrerPolicy: no-referrer 避免部分 CDN 的防盗链策略拒绝扩展来源的 referer；
  // host_permissions 已覆盖各平台 CDN，所以跨域读取不会被 CORS 拦截。
  const response = await fetch(url, {
    credentials: 'omit',
    cache: 'force-cache',
    referrerPolicy: 'no-referrer',
  });
  if (!response.ok) throw new Error(`图片请求失败：HTTP ${response.status}`);

  const blob = await response.blob();
  return convertBlobToPng(blob);
}

/** 用 data URL 触发下载（blob URL 不可用时的方案） */
async function downloadViaDataUrl(blob, filename) {
  const dataUrl = await blobToDataUrl(blob);
  return chrome.downloads.download({
    url: dataUrl,
    filename,
    conflictAction: 'uniquify',
    saveAs: false,
  });
}

/** Service Worker 环境不一定支持 URL.createObjectURL，先做能力探测 */
function canUseObjectUrl() {
  return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
}

/** 安全释放 blob URL（部分运行环境没有 revokeObjectURL） */
function safeRevokeObjectUrl(objectUrl) {
  if (!objectUrl) return;
  try {
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    /* 释放失败不影响下载结果 */
  }
}

/**
 * 触发一次下载，返回 chrome.downloads 的 downloadId。
 *
 * 注意：Chrome 的 MV3 Service Worker 里没有 URL.createObjectURL（它只在普通页面 /
 * Dedicated Worker 中可用），直接调用会抛 "URL.createObjectURL is not a function"。
 * 因此这里先探测能力：
 *   - 支持 blob URL：优先使用（内存占用更低）；
 *   - 不支持：编码为 data URL 后交给 chrome.downloads.download。
 */
export async function downloadBlob(blob, filename) {
  let objectUrl = '';

  if (canUseObjectUrl()) {
    try {
      objectUrl = URL.createObjectURL(blob);
    } catch {
      objectUrl = '';
    }
  }

  // Service Worker 的常规路径：直接使用 data URL
  if (!objectUrl) {
    return downloadViaDataUrl(blob, filename);
  }

  try {
    const downloadId = await chrome.downloads.download({
      url: objectUrl,
      filename,
      conflictAction: 'uniquify',
      saveAs: false,
    });
    pendingDownloads.set(downloadId, { objectUrl, blob, filename, retried: false });
    return downloadId;
  } catch {
    safeRevokeObjectUrl(objectUrl);
    return downloadViaDataUrl(blob, filename);
  }
}

/* ------------------------------------------------------------------ *
 * 画廊数据存取
 * ------------------------------------------------------------------ */

function getGalleryKey(id) {
  return `${GALLERY_KEY_PREFIX}${id}`;
}

/** 清理过期的提取记录，只保留最近的若干份 */
async function pruneGalleries() {
  const all = await chrome.storage.session.get(null);
  const records = Object.entries(all)
    .filter(([key]) => key.startsWith(GALLERY_KEY_PREFIX))
    .map(([key, value]) => ({ key, createdAt: Number(value?.createdAt) || 0 }))
    .sort((a, b) => b.createdAt - a.createdAt);

  if (records.length <= MAX_GALLERY_RECORDS) return;

  const staleKeys = records.slice(MAX_GALLERY_RECORDS).map((item) => item.key);
  if (staleKeys.length) await chrome.storage.session.remove(staleKeys);
}

async function saveGallery(record) {
  await chrome.storage.session.set({ [getGalleryKey(record.id)]: record });
  await pruneGalleries();
}

async function readGallery(id) {
  if (!id) return null;
  const key = getGalleryKey(id);
  const result = await chrome.storage.session.get(key);
  return result?.[key] || null;
}

async function readLatestGallery() {
  const all = await chrome.storage.session.get(null);
  const latest = Object.entries(all)
    .filter(([key]) => key.startsWith(GALLERY_KEY_PREFIX))
    .map(([, value]) => value)
    .sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0))[0];
  return latest || null;
}

/* ------------------------------------------------------------------ *
 * 业务处理
 * ------------------------------------------------------------------ */

/** 内容脚本调用：保存图片列表并打开画廊页 */
async function handleOpenGallery(message) {
  const data = message?.data || {};
  const images = Array.isArray(data.images)
    ? data.images
        .filter((item) => item && typeof item.url === 'string' && /^https?:/i.test(item.url))
        .slice(0, 500)
        .map((item) => ({
          url: item.url,
          width: Number(item.width) || 0,
          height: Number(item.height) || 0,
        }))
    : [];

  if (!images.length) return { ok: false, error: '没有可展示的图片' };

  const id = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const record = {
    id,
    createdAt: Date.now(),
    pageUrl: typeof data.pageUrl === 'string' ? data.pageUrl : '',
    pageTitle: typeof data.pageTitle === 'string' ? data.pageTitle : '',
    platform: typeof data.platform === 'string' ? data.platform : '',
    images,
  };

  await saveGallery(record);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`gallery.html?id=${encodeURIComponent(id)}`) });

  return { ok: true, id, count: images.length };
}

/**
 * 逐个处理下载任务。
 * 串行执行可以保证：文件名序号与用户的选择顺序一致、内存占用可控、进度条平滑。
 */
async function runDownloadTask(taskId, items) {
  const total = items.length;
  let success = 0;
  const errors = [];

  for (let index = 0; index < total; index += 1) {
    const item = items[index];
    const order = index + 1;

    broadcast({
      type: 'DOWNLOAD_PROGRESS',
      taskId,
      itemId: item.id,
      url: item.url,
      index: order,
      total,
      phase: 'start',
    });

    try {
      const pngBlob = await fetchAsPng(item.url);

      broadcast({
        type: 'DOWNLOAD_PROGRESS',
        taskId,
        itemId: item.id,
        url: item.url,
        index: order,
        total,
        phase: 'saving',
      });

      const filename = buildFileName(order, total);
      await downloadBlob(pngBlob, filename);
      success += 1;

      broadcast({
        type: 'DOWNLOAD_PROGRESS',
        taskId,
        itemId: item.id,
        url: item.url,
        index: order,
        total,
        phase: 'done',
        filename,
      });
    } catch (error) {
      const reason = error?.message || String(error);
      errors.push({ url: item.url, message: reason });
      broadcast({
        type: 'DOWNLOAD_PROGRESS',
        taskId,
        itemId: item.id,
        url: item.url,
        index: order,
        total,
        phase: 'error',
        message: reason,
      });
    }
  }

  broadcast({
    type: 'DOWNLOAD_FINISHED',
    taskId,
    total,
    success,
    failed: errors.length,
    errors,
  });
}

/** 画廊页调用：启动批量下载 */
function handleStartDownload(message) {
  const taskId = typeof message?.taskId === 'string' && message.taskId ? message.taskId : `t${Date.now()}`;
  const items = Array.isArray(message?.items)
    ? message.items
        .filter((item) => item && typeof item.url === 'string' && /^https?:/i.test(item.url))
        .map((item, index) => ({ id: item.id ?? index, url: item.url }))
    : [];

  if (!items.length) return { ok: false, error: '没有选中任何图片' };

  // 先返回 taskId，后台继续执行，进度通过广播推送
  void runDownloadTask(taskId, items).catch((error) => {
    broadcast({
      type: 'DOWNLOAD_FINISHED',
      taskId,
      total: items.length,
      success: 0,
      failed: items.length,
      errors: [{ url: '', message: error?.message || String(error) }],
    });
  });

  return { ok: true, taskId, total: items.length };
}

/* ------------------------------------------------------------------ *
 * 消息路由
 * ------------------------------------------------------------------ */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  const type = message?.type;

  if (type === 'OPEN_GALLERY') {
    handleOpenGallery(message)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (type === 'START_DOWNLOAD') {
    try {
      sendResponse(handleStartDownload(message));
    } catch (error) {
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return false;
  }

  if (type === 'GET_GALLERY') {
    readGallery(message?.id)
      .then((gallery) => sendResponse({ ok: Boolean(gallery), gallery }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  if (type === 'GET_LATEST_GALLERY') {
    readLatestGallery()
      .then((gallery) => sendResponse({ ok: Boolean(gallery), gallery }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }

  return false;
});

/* ------------------------------------------------------------------ *
 * 下载状态跟踪：释放 blob URL，失败时用 data URL 重试一次
 * ------------------------------------------------------------------ */
chrome.downloads.onChanged.addListener((delta) => {
  const record = pendingDownloads.get(delta.id);
  if (!record) return;

  const state = delta.state?.current;
  if (!state) return;

  if (state === 'complete') {
    safeRevokeObjectUrl(record.objectUrl);
    pendingDownloads.delete(delta.id);
    return;
  }

  if (state === 'interrupted') {
    pendingDownloads.delete(delta.id);
    safeRevokeObjectUrl(record.objectUrl);

    if (record.retried) return;

    downloadViaDataUrl(record.blob, record.filename)
      .then((newId) => {
        pendingDownloads.set(newId, { ...record, objectUrl: '', retried: true });
      })
      .catch(() => {
        /* 兜底也失败时不再重试，画廊页会显示失败原因 */
      });
  }
});

/* ------------------------------------------------------------------ *
 * 点击扩展图标：优先让当前标签页触发一次提取，否则打开最近一次结果
 * ------------------------------------------------------------------ */
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.id) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'TRIGGER_EXTRACT' });
      if (response?.ok) return;
    } catch {
      /* 当前页面没有内容脚本，走下面的兜底逻辑 */
    }
  }

  const latest = await readLatestGallery();
  if (latest?.id) {
    await chrome.tabs.create({
      url: chrome.runtime.getURL(`gallery.html?id=${encodeURIComponent(latest.id)}`),
    });
    return;
  }

  if (tab?.id) {
    // 没有历史数据时，用徽标提示用户先到商品页操作
    try {
      await chrome.action.setBadgeText({ tabId: tab.id, text: '?' });
      await chrome.action.setBadgeBackgroundColor({ color: '#ff5a1f' });
      setTimeout(() => chrome.action.setBadgeText({ tabId: tab.id, text: '' }).catch(() => {}), 3000);
    } catch {
      /* 忽略徽标设置失败 */
    }
  }
});
