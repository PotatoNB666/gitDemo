# 电商图片提取下载助手（Chrome Extension / Manifest V3）

在淘宝 / 天猫、京东、拼多多的**商品详情页**右下角注入一个悬浮按钮，一键提取页面内所有商品图片，
在新标签页中网格化展示，勾选后批量下载为 **PNG**（文件名 `商品图_001.png`、`商品图_002.png` …）。

---

## 一、文件结构

```
gitDemo/
├── manifest.json          # MV3 清单：权限、匹配域名、内容脚本、Service Worker
├── content.js             # 内容脚本：注入悬浮按钮 + 扫描提取图片
├── content.css            # 悬浮按钮样式（注入到 Shadow DOM，与页面样式隔离）
├── background.js          # Service Worker：打开画廊页、fetch 图片、转 PNG、批量下载、进度广播
├── gallery.html           # 画廊页结构
├── gallery.css            # 画廊页样式（响应式 + 深色模式）
├── gallery.js             # 画廊页逻辑：渲染、全选/反选、下载、进度
├── lib/
│   └── image-utils.js     # 共享工具：URL 归一化、去重键、噪音过滤、文件名规则
├── tests/                 # 开发期测试（不会影响扩展运行）
│   ├── harness.html       # 内容脚本端到端测试页（模拟商品详情页）
│   ├── harness-blocked.html
│   ├── conversion-harness.html
│   ├── gallery-harness.html
│   ├── gen-fixtures.mjs   # 生成测试 PNG
│   └── serve.mjs          # 本地静态服务器
├── docs/                  # 产品官网（纯静态，可直接双击打开）
│   ├── index.html
│   ├── css/style.css
│   ├── js/main.js
│   └── assets/logo.svg
├── package.json           # 仅用于开发脚本（npm test / npm run serve）
└── README.md
```

---

## 二、实现思路

### 1. 只在这个页面显示按钮

`content.js` 用三层判断，避免在列表页、首页误显示：

1. **域名白名单**：`taobao.com` / `tmall.com` / `jd.com` / `pinduoduo.com` / `yangkeduo.com`（含子域名）。
2. **URL 特征**：`item.htm?id=`、`item.jd.com/xxx.html`、`goods.html?goods_id=`、`/goods/goods_detail` 等。
3. **DOM 兜底**：商家后台大量使用 hash 路由（如 `mms.pinduoduo.com/goods/goods_detail`），URL 规则覆盖不到时，
   用详情页独有的结构（`#J_ImgBooth`、`#spec-img`、`[class*="GoodsDetail"]`）确认。

因为拼多多商家后台、千牛工作台是 SPA，内容脚本每 1.2 秒对比一次页面状态：路由变化时自动显示/移除按钮。

### 2. 图片提取

| 来源 | 处理方式 |
| --- | --- |
| `<img>` | `currentSrc`、`src`、`srcset`（取最大一份） |
| 懒加载属性 | `data-src`、`data-lazy-src`、`data-original`、`data-ks-lazyload`、`data-lazyload`、`data-actualsrc`、`data-srcset` 等 |
| `<picture><source srcset>` | 同样取最大一份 |
| CSS 背景图 | 扫描内联 style 与常见图片类容器（img/pic/thumb/swiper/gallery…），只接受容器 ≥100×100 的元素 |

提取后：

- **URL 归一化**：相对路径补全为绝对 URL，`//` 升级为 `https://`；
- **拿原图**：去掉各 CDN 的缩放后缀
  - 淘宝：`xxx.jpg_430x430q90.jpg` → `xxx.jpg`、`xxx.jpg_.webp` → `xxx.jpg`
  - 京东：`/n0/s450x450_jfs/...` → `/jfs/...`，去掉 `!/fw/450/...`
  - 拼多多：去掉 `?imageMogr2/thumbnail/...`
- **去重**：按 `协议 + 域名 + 路径` 生成去重键，与尺寸参数无关；
- **尺寸探测**：已加载的 `<img>` 直接读 `naturalWidth`；懒加载图用 `new Image()` 预加载（并发 6，单张 8 秒超时，整体 20 秒预算）；
- **过滤**：小于 100×100、1×1 像素、SVG 图标、文件名含 logo/icon/sprite/placeholder 等的图片。

### 3. 画廊页

- 结果通过 `chrome.runtime.sendMessage` 交给 Service Worker，存入 `chrome.storage.session`（只保留最近 10 份），
  再打开 `gallery.html?id=xxx`；
- 网格使用 `auto-fill + minmax(190px, 1fr)`，卡片显示缩略图、像素尺寸、PNG 文件名、下载状态；
- 顶部支持全选 / 反选 / 已选计数，默认全选；
- 下载时按「页面上勾选的顺序」依次生成 `商品图_001.png`、`商品图_002.png`…

### 4. 下载与 PNG 转换

1. Service Worker 用 `fetch` 取图片字节（`host_permissions` 已覆盖各平台图片 CDN，不受 CORS 限制；
   `credentials: 'omit'` + `referrerPolicy: 'no-referrer'` 兼顾隐私与防盗链兼容）；
2. `createImageBitmap` 解码 → `OffscreenCanvas.drawImage` → `convertToBlob({ type: 'image/png' })`；
3. 已是 PNG 的图片直接透传，避免重复编码、体积变大；
4. `chrome.downloads.download({ filename: '商品图_001.png', conflictAction: 'uniquify' })` 保存到默认下载目录；
5. 每张图处理完通过 `chrome.runtime.sendMessage` 广播进度，画廊页实时更新卡片状态、进度条与最终结果；
6. **下载地址的选择**：Chrome 的 MV3 Service Worker 里没有 `URL.createObjectURL`（只在普通页面 / Dedicated Worker 中可用），
   因此会先做能力探测——支持时用 `blob:` URL（内存占用低），不支持时直接把 PNG 编码成 `data:` URL 交给
   `chrome.downloads.download`；下载被中断时也会用 `data:` URL 重试一次。

---

## 三、安装与使用

### 安装（加载未打包扩展）

1. 打开 Chrome，地址栏输入 `chrome://extensions/`；
2. 右上角打开「开发者模式」；
3. 点击「加载已解压的扩展程序」，选择本目录（包含 `manifest.json` 的那一层）；
4. 建议把扩展固定到工具栏，方便查看。

> 无需构建、无需安装依赖，所有代码都是原生 JS / CSS / HTML。

### 使用

1. 打开淘宝 / 天猫、京东或拼多多的商品详情页（例如 `https://item.jd.com/100012043978.html`）；
2. 页面右下角出现橙色「获取图片」按钮；
3. 点击后按钮显示扫描进度，完成后自动打开新标签页展示提取结果；
4. 在画廊页勾选需要的图片（默认全选），点击「下载选中」；
5. 下载完成后，PNG 文件保存在浏览器默认下载目录，文件名形如 `商品图_001.png`。

补充：点击工具栏中的扩展图标，会对当前商品页直接触发一次提取；如果当前页不支持，则打开最近一次提取结果。

### 权限说明

| 权限 | 用途 |
| --- | --- |
| `activeTab` | 点击扩展图标时向当前标签页发送提取指令 |
| `scripting` | MV3 内容脚本能力预留（本版本通过 manifest 静态注入） |
| `downloads` | 保存 PNG 文件 |
| `storage` | 用 `chrome.storage.session` 在内容脚本 → 画廊页之间传递提取结果 |
| `host_permissions` | 覆盖三个平台的页面域名与图片 CDN 域名，使跨域 fetch 图片、转换 PNG 成为可能 |

---

## 四、已知限制

1. **提取结果只存在当前浏览器会话**：`chrome.storage.session` 在浏览器重启后清空，重新打开画廊需要重新提取。
2. **页面上没加载出来的图片提取不到**：懒加载图片依赖页面本身触发加载，建议先把主图 / 详情图滚动浏览一遍。
3. **平台改版可能导致选择器失效**：商家后台 DOM 结构变化时，按钮可能不再显示；此时可在 `content.js` 的
   `PLATFORM_RULES` 中补充 `urlPatterns` / `detailSelectors`。
4. **个别 CDN 有防盗链**：若某张图下载失败，卡片上会标出具体原因（如 `HTTP 403`）。
5. **图片尺寸判断依赖真实加载**：超时或无法访问的图片会被过滤掉。

---

## 五、可调参数

`content.js` 顶部的常量可以直接调整：

```js
const MIN_WIDTH = 100;          // 最小宽度阈值
const MIN_HEIGHT = 100;         // 最小高度阈值
const MAX_CANDIDATES = 300;     // 单页最多处理的候选图片数
const MEASURE_CONCURRENCY = 6;  // 尺寸探测并发数
```

文件名规则在 `lib/image-utils.js` 的 `buildFileName()` 中（默认 `商品图_001.png`，至少补 3 位）。

---

## 六、开发与测试

```bash
# 1. 生成测试图片（tests/fixtures/）
npm run fixtures

# 2. 单元测试：URL 归一化、去重、噪音过滤、文件名、srcset 解析
npm test

# 3. 浏览器端到端测试
npm run serve        # 启动 http://127.0.0.1:8777
# 依次打开：
#   http://127.0.0.1:8777/tests/harness.html           -> 内容脚本（按钮注入、提取、过滤）
#   http://127.0.0.1:8777/tests/harness-blocked.html   -> 非详情页不注入按钮
#   http://127.0.0.1:8777/tests/conversion-harness.html-> WebP/JPEG 转 PNG、下载与回退
#   http://127.0.0.1:8777/tests/gallery-harness.html   -> 画廊渲染、全选/反选、下载与进度
# 每个测试页会把断言结果写进 window.__harnessResult / __conversionResult / __galleryResult
```

本版本已执行上述测试：单元测试 15 项、浏览器端到端断言 64 项，全部通过。

---

## 七、产品官网（docs/）

`docs/` 是插件的单页宣传网站，纯 HTML / CSS / 原生 JS，没有构建步骤和外部依赖。

- **本地预览**：直接双击 `docs/index.html`，浏览器会用 `file://` 打开；也可以用
  `npx serve docs` 或任意静态服务器预览。页面中的锚点、移动端菜单、滚动动画在两种方式下都可用。
- **修改主色**：打开 `docs/css/style.css`，改 `:root` 里的 `--primary` 与 `--primary-2`，
  全站渐变、按钮、图标底色会一起变化。
- **修改文案**：所有文案都写在 `docs/index.html` 里，按区块注释（首屏 / 产品介绍 / 核心功能 /
  安装步骤 / 底部 CTA）定位即可。
- **响应式断点**：`<768px` 手机单列 + 汉堡菜单，`768–1023px` 平板两列，`≥1024px` 桌面三列。
