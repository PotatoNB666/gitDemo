/**
 * Content Script 测试断言
 * 结果写入 window.__harnessResult，供自动化脚本读取。
 */
(function runHarness() {
  const results = [];

  function record(name, pass, detail = '') {
    results.push({ name, pass: Boolean(pass), detail: String(detail) });
  }

  function waitFor(predicate, timeout = 15000, interval = 80) {
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
      // 1. 按钮是否注入（FORCE_ENABLE 模式下应无条件显示）
      const host = await waitFor(() => document.querySelector('#ecom-img-extractor-host'));
      record('悬浮按钮 host 已注入', Boolean(host));

      const shadow = host.shadowRoot;
      record('使用 Shadow DOM 隔离样式', Boolean(shadow));

      const button = shadow.querySelector('.ecom-extractor__btn');
      record('按钮存在', Boolean(button));
      record('按钮文案为「获取图片」', button?.textContent.trim() === '获取图片', button?.textContent.trim());

      const link = shadow.querySelector('link[rel="stylesheet"]');
      record('已引入 content.css', Boolean(link) && link.href.endsWith('/content.css'), link?.href);

      // 等待样式表加载完成后校验样式是否真正生效
      await waitFor(() => link.sheet, 5000);
      const buttonStyle = getComputedStyle(button);
      record('按钮样式已生效（圆角）', buttonStyle.borderRadius === '999px', buttonStyle.borderRadius);
      record('按钮样式已生效（阴影）', buttonStyle.boxShadow !== 'none', buttonStyle.boxShadow);
      record('按钮固定定位在右下角', buttonStyle.position === 'fixed' || getComputedStyle(host).position === 'fixed', getComputedStyle(host).position);

      // 2. 点击按钮，等待内容脚本把结果发给后台
      button.click();
      const message = await waitFor(() => window.__lastMessage, 20000);
      record('点击后发送 OPEN_GALLERY 消息', message?.type === 'OPEN_GALLERY', message?.type);
      record('消息携带来源页面 URL', typeof message?.data?.pageUrl === 'string' && message.data.pageUrl.includes('harness.html'), message?.data?.pageUrl);

      const images = message?.data?.images || [];
      const urls = images.map((item) => item.url);
      const find = (file) => images.filter((item) => item.url.includes(file));

      record('至少提取到 3 张图片', images.length >= 3, `共 ${images.length} 张`);

      // 3. 正常大图（含去重）
      const large = find('/large.png');
      record('large.png 被提取', large.length === 1, `命中 ${large.length} 次`);
      record(
        'large.png 尺寸为 320×240',
        large[0]?.width === 320 && large[0]?.height === 240,
        large[0] ? `${large[0].width}×${large[0].height}` : '未找到',
      );

      // 4. 懒加载
      const lazy = find('/lazy.png');
      record('data-src 懒加载图片被提取', lazy.length === 1, `命中 ${lazy.length} 次`);
      record(
        '懒加载图片尺寸为 400×300',
        lazy[0]?.width === 400 && lazy[0]?.height === 300,
        lazy[0] ? `${lazy[0].width}×${lazy[0].height}` : '未找到',
      );

      // 5. 背景图
      const background = find('/bg.png');
      record('CSS 背景图被提取', background.length === 1, `命中 ${background.length} 次`);
      record(
        '背景图尺寸为 500×400',
        background[0]?.width === 500 && background[0]?.height === 400,
        background[0] ? `${background[0].width}×${background[0].height}` : '未找到',
      );

      // 6. srcset 取最大
      record('srcset 取最大尺寸图 big.png', find('/big.png').length === 1, `命中 ${find('/big.png').length} 次`);

      // 7. 过滤规则
      const excluded = [
        ['/tiny.png', '小于 100×100'],
        ['/dot.png', '1x1 像素图'],
        ['/logo.png', 'Logo 噪音'],
        ['/placeholder-blank.png', '占位图'],
        ['/bg-small.png', '过小的背景图容器'],
      ];
      for (const [file, reason] of excluded) {
        record(`已过滤 ${file}（${reason}）`, find(file).length === 0, `命中 ${find(file).length} 次`);
      }

      // 8. URL 归一化
      record('所有图片地址均为绝对地址', urls.every((url) => /^https?:\/\//.test(url)), urls.slice(0, 3).join(' , '));
      record('图片地址互不重复', new Set(urls).size === urls.length, `${urls.length} -> ${new Set(urls).size}`);

      window.__harnessResult = { pass: results.every((item) => item.pass), results };
    } catch (error) {
      window.__harnessResult = {
        pass: false,
        error: String(error?.stack || error),
        results,
      };
    }
  }

  main();
})();
