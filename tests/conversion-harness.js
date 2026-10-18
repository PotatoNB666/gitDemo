/**
 * 在真实浏览器中验证 background.js 的核心逻辑：
 * - 图片转 PNG（WebP / JPEG -> PNG、PNG 透传）
 * - 文件名规则
 * - chrome.downloads.download 调用参数与 blob URL / data URL 回退
 */
import { blobToDataUrl, convertBlobToPng, downloadBlob, fetchAsPng } from '../background.js';
import { buildFileName } from '../lib/image-utils.js';

const results = [];

function record(name, pass, detail = '') {
  results.push({ name, pass: Boolean(pass), detail: String(detail) });
}

async function makeImageBlob(type) {
  const canvas = new OffscreenCanvas(240, 160);
  const context = canvas.getContext('2d');
  context.fillStyle = '#ff5a1f';
  context.fillRect(0, 0, 240, 160);
  context.fillStyle = '#123456';
  context.fillRect(40, 40, 80, 60);
  context.fillStyle = '#ffffff';
  context.font = '28px sans-serif';
  context.fillText('TEST', 140, 110);
  return canvas.convertToBlob({ type });
}

async function main() {
  try {
    const fixtureUrl = new URL('fixtures/large.png', location.href).href;
    const pngBlob = await (await fetch(fixtureUrl)).blob();

    // 1. PNG 透传
    const passedThrough = await convertBlobToPng(pngBlob);
    record(
      'PNG 原图直接透传（不重复编码）',
      passedThrough.type === 'image/png' && passedThrough.size === pngBlob.size,
      `${passedThrough.type}, ${passedThrough.size}B`,
    );

    // 2. WebP -> PNG
    const webpBlob = await makeImageBlob('image/webp');
    record('测试素材确实编码为 WebP', webpBlob.type === 'image/webp', webpBlob.type);

    const pngFromWebp = await convertBlobToPng(webpBlob);
    const webpBitmap = await createImageBitmap(pngFromWebp);
    record('WebP 转换为 PNG 成功', pngFromWebp.type === 'image/png', pngFromWebp.type);
    record(
      'WebP 转换后尺寸保持不变',
      webpBitmap.width === 240 && webpBitmap.height === 160,
      `${webpBitmap.width}×${webpBitmap.height}`,
    );
    webpBitmap.close();

    // 3. JPEG -> PNG
    const jpegBlob = await makeImageBlob('image/jpeg');
    const pngFromJpeg = await convertBlobToPng(jpegBlob);
    const jpegBitmap = await createImageBitmap(pngFromJpeg);
    record(
      'JPEG 转换为 PNG 且尺寸不变',
      pngFromJpeg.type === 'image/png' && jpegBitmap.width === 240 && jpegBitmap.height === 160,
      `${pngFromJpeg.type}, ${jpegBitmap.width}×${jpegBitmap.height}`,
    );
    jpegBitmap.close();

    // 4. 文件名规则
    record('文件名规则：商品图_001.png', buildFileName(1, 8) === '商品图_001.png', buildFileName(1, 8));
    record('文件名规则：超过 3 位自动扩展', buildFileName(7, 1200) === '商品图_0007.png', buildFileName(7, 1200));

    // 5. fetchAsPng 走真实网络请求（同源素材）
    const fetched = await fetchAsPng(fixtureUrl);
    record('fetchAsPng 成功返回 PNG', fetched.type === 'image/png', fetched.type);

    // 6. downloadBlob 正常路径
    window.__downloadCalls.length = 0;
    const downloadId = await downloadBlob(fetched, '商品图_001.png');
    const firstCall = window.__downloadCalls[0];
    record('downloadBlob 返回 downloadId', downloadId === 1, String(downloadId));
    record('downloadBlob 使用 blob URL', Boolean(firstCall?.url?.startsWith('blob:')), (firstCall?.url || '').slice(0, 24));
    record('下载文件名正确', firstCall?.filename === '商品图_001.png', firstCall?.filename);
    record('冲突策略为 uniquify', firstCall?.conflictAction === 'uniquify', firstCall?.conflictAction);

    // 7. blob URL 不可用时回退 data URL
    window.__downloadCalls.length = 0;
    window.__failNextBlobDownload = true;
    await downloadBlob(fetched, '商品图_002.png');
    const fallbackCall = window.__downloadCalls[0];
    record(
      'blob URL 失败时回退 data URL',
      Boolean(fallbackCall?.url?.startsWith('data:image/png;base64,')),
      (fallbackCall?.url || '').slice(0, 30),
    );
    record('回退时文件名仍然正确', fallbackCall?.filename === '商品图_002.png', fallbackCall?.filename);

    // 8. 模拟 Service Worker 环境：没有 URL.createObjectURL
    const createObjectUrlDescriptor = Object.getOwnPropertyDescriptor(URL, 'createObjectURL');
    try {
      Object.defineProperty(URL, 'createObjectURL', { value: undefined, configurable: true, writable: true });
      window.__downloadCalls.length = 0;
      await downloadBlob(fetched, '商品图_003.png');
      const swCall = window.__downloadCalls[0];
      record(
        '无 createObjectURL 时直接使用 data URL（Service Worker 路径）',
        Boolean(swCall?.url?.startsWith('data:image/png;base64,')),
        (swCall?.url || '').slice(0, 28),
      );
      record('该路径下文件名仍然正确', swCall?.filename === '商品图_003.png', swCall?.filename);
    } finally {
      if (createObjectUrlDescriptor) {
        Object.defineProperty(URL, 'createObjectURL', createObjectUrlDescriptor);
      }
    }

    // 9. blobToDataUrl
    const dataUrl = await blobToDataUrl(fetched);
    record('blobToDataUrl 前缀正确', dataUrl.startsWith('data:image/png;base64,'), dataUrl.slice(0, 26));

    window.__conversionResult = { pass: results.every((item) => item.pass), results };
  } catch (error) {
    window.__conversionResult = {
      pass: false,
      error: String(error?.stack || error),
      results,
    };
  }
}

void main();
