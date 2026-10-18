/**
 * 画廊页交互断言：渲染、全选/反选、计数、下载消息、进度与结果提示。
 */
(function runGalleryHarness() {
  const results = [];

  function record(name, pass, detail = '') {
    results.push({ name, pass: Boolean(pass), detail: String(detail) });
  }

  function waitFor(predicate, timeout = 10000, interval = 60) {
    return new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const timer = setInterval(() => {
        let value;
        try {
          value = predicate();
        } catch {
          value = null;
        }
        if (value) {
          clearInterval(timer);
          resolve(value);
          return;
        }
        if (Date.now() - startedAt > timeout) {
          clearInterval(timer);
          reject(new Error('等待超时'));
        }
      }, interval);
    });
  }

  async function main() {
    try {
      const grid = document.getElementById('grid');
      await waitFor(() => grid.querySelectorAll('.card').length === 3);

      let cards = [...grid.querySelectorAll('.card')];
      const countEl = document.getElementById('selected-count');
      const selectAll = document.getElementById('select-all');
      const downloadBtn = document.getElementById('download-btn');
      const meta = document.getElementById('page-meta');

      record('渲染 3 张图片卡片', cards.length === 3, cards.length);
      record('顶部显示平台与数量', meta.textContent.includes('3 张') && meta.textContent.includes('淘宝'), meta.textContent);
      record(
        '卡片显示尺寸信息',
        cards[0].querySelector('.card__dim').textContent.includes('320'),
        cards[0].querySelector('.card__dim').textContent,
      );
      record(
        '卡片显示 PNG 文件名',
        cards[0].querySelector('.card__name').textContent === '商品图_001.png',
        cards[0].querySelector('.card__name').textContent,
      );
      record('缩略图使用原图地址', cards[0].querySelector('img').src.includes('large.png'), cards[0].querySelector('img').src);
      record('默认全选', [...grid.querySelectorAll('input[type=checkbox]')].every((box) => box.checked));
      record('已选计数正确', countEl.textContent === '已选 3 / 3', countEl.textContent);
      record('全选框为选中态', selectAll.checked === true);

      // 取消全选
      selectAll.checked = false;
      selectAll.dispatchEvent(new Event('change', { bubbles: true }));
      record('取消全选后计数归零', countEl.textContent === '已选 0 / 3', countEl.textContent);
      record('取消全选后下载按钮禁用', downloadBtn.disabled === true);
      record('取消全选后卡片取消高亮', !cards[0].classList.contains('is-selected'));

      // 反选
      document.getElementById('invert-btn').click();
      record('反选后恢复全选', countEl.textContent === '已选 3 / 3', countEl.textContent);

      // 单独取消一张
      const firstCheckbox = cards[0].querySelector('input[type=checkbox]');
      firstCheckbox.checked = false;
      firstCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      record('单独取消一张后计数为 2', countEl.textContent === '已选 2 / 3', countEl.textContent);
      record('全选框进入半选状态', selectAll.indeterminate === true);

      // 恢复并下载
      firstCheckbox.checked = true;
      firstCheckbox.dispatchEvent(new Event('change', { bubbles: true }));
      downloadBtn.click();

      await waitFor(() => window.__sentMessages.some((item) => item.type === 'START_DOWNLOAD'));
      const startMessage = window.__sentMessages.find((item) => item.type === 'START_DOWNLOAD');

      record('下载时发送 START_DOWNLOAD', Boolean(startMessage));
      record('下载项数量为 3', startMessage.items.length === 3, startMessage.items.length);
      record('任务 ID 已生成', typeof startMessage.taskId === 'string' && startMessage.taskId.length > 0, startMessage.taskId);
      record('下载项顺序与页面一致', startMessage.items[0].url.includes('large.png'), startMessage.items[0].url);

      // 下载后卡片会被重新渲染，需要重新取引用
      const taskId = startMessage.taskId;
      cards = [...grid.querySelectorAll('.card')];

      window.__galleryListener({
        type: 'DOWNLOAD_PROGRESS',
        taskId,
        itemId: 0,
        index: 1,
        total: 3,
        phase: 'done',
        filename: '商品图_001.png',
      });
      record(
        '进度消息更新卡片状态',
        cards[0].querySelector('.card__status').textContent === '已完成',
        cards[0].querySelector('.card__status').textContent,
      );
      record(
        '进度条文本随进度更新',
        document.getElementById('progress-text').textContent.includes('1/3'),
        document.getElementById('progress-text').textContent,
      );

      window.__galleryListener({
        type: 'DOWNLOAD_PROGRESS',
        taskId,
        itemId: 1,
        index: 2,
        total: 3,
        phase: 'error',
        message: 'HTTP 404',
      });
      record(
        '失败状态显示具体原因',
        cards[1].querySelector('.card__status').textContent.includes('HTTP 404'),
        cards[1].querySelector('.card__status').textContent,
      );

      window.__galleryListener({ type: 'DOWNLOAD_FINISHED', taskId, total: 3, success: 2, failed: 1 });
      const banner = document.getElementById('banner');
      record('完成后显示结果横幅', !banner.hidden && banner.textContent.includes('成功 2'), banner.textContent);
      record(
        '完成后按钮恢复可用',
        downloadBtn.disabled === false && downloadBtn.textContent === '下载选中',
        downloadBtn.textContent,
      );

      window.__galleryResult = { pass: results.every((item) => item.pass), results };
    } catch (error) {
      window.__galleryResult = {
        pass: false,
        error: String(error?.stack || error),
        results,
      };
    }
  }

  main();
})();
