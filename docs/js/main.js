/**
 * 图提取 ImageGrab · 宣传页交互脚本
 *
 * 包含四部分：
 *   1. 导航栏滚动状态（毛玻璃 + 阴影）
 *   2. 移动端汉堡菜单的展开 / 收起
 *   3. 滚动时高亮当前所在区块
 *   4. 元素进入视口时的淡入上移动画（IntersectionObserver）
 *
 * 纯原生 JS，无任何依赖，可直接以 file:// 打开运行。
 */
(function () {
  'use strict';

  /* ---------------- DOM 引用 ---------------- */
  const header = document.getElementById('site-header');
  const nav = document.getElementById('nav-links');
  const toggle = document.getElementById('nav-toggle');
  const navLinks = Array.from(document.querySelectorAll('[data-nav]'));
  const revealElements = Array.from(document.querySelectorAll('[data-reveal]'));
  const yearElement = document.getElementById('current-year');

  /** 导航项对应的区块（顺序与页面一致） */
  const sections = navLinks
    .map((link) => document.getElementById(link.dataset.nav))
    .filter(Boolean);

  /* ---------------- 1. 页脚年份 ---------------- */
  if (yearElement) {
    yearElement.textContent = String(new Date().getFullYear());
  }

  /* ---------------- 2. 汉堡菜单 ---------------- */
  /** 展开 / 收起移动端菜单 */
  function setMenu(open) {
    if (!nav || !toggle) return;
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '关闭导航菜单' : '打开导航菜单');
    nav.classList.toggle('is-open', open);
  }

  function isMenuOpen() {
    return toggle?.getAttribute('aria-expanded') === 'true';
  }

  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      setMenu(!isMenuOpen());
    });

    // 点击任意导航链接后自动收起菜单
    nav.addEventListener('click', (event) => {
      if (event.target instanceof Element && event.target.closest('a')) {
        setMenu(false);
      }
    });

    // Esc 关闭菜单，并把焦点还给按钮
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && isMenuOpen()) {
        setMenu(false);
        toggle.focus();
      }
    });

    // 点击导航区域之外时收起
    document.addEventListener('click', (event) => {
      if (!isMenuOpen()) return;
      const target = event.target;
      if (target instanceof Element && !target.closest('.nav')) {
        setMenu(false);
      }
    });

    // 视口变宽到桌面尺寸时，强制收起折叠菜单
    const desktopQuery = window.matchMedia('(min-width: 768px)');
    const handleViewportChange = (event) => {
      if (event.matches) setMenu(false);
    };
    if (typeof desktopQuery.addEventListener === 'function') {
      desktopQuery.addEventListener('change', handleViewportChange);
    } else if (typeof desktopQuery.addListener === 'function') {
      desktopQuery.addListener(handleViewportChange); // 兼容旧版浏览器
    }
  }

  /* ---------------- 3. 滚动状态 + 区块高亮 ---------------- */
  /** 计算当前所在区块，并同步导航高亮 */
  function updateActiveSection() {
    if (!sections.length) return;

    const navHeight = header ? header.offsetHeight : 68;
    const threshold = navHeight + 100;
    let currentId = '';

    for (const section of sections) {
      if (section.getBoundingClientRect().top <= threshold) {
        currentId = section.id;
      }
    }

    // 滚动到底部时，强制高亮最后一个区块（否则较短的 CTA 可能无法命中）
    const reachedBottom =
      window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
    if (reachedBottom) {
      currentId = sections[sections.length - 1].id;
    }

    for (const link of navLinks) {
      const isActive = link.dataset.nav === currentId;
      link.classList.toggle('is-active', isActive);
      if (isActive) {
        link.setAttribute('aria-current', 'page');
      } else {
        link.removeAttribute('aria-current');
      }
    }
  }

  let ticking = false;

  function handleScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(() => {
      if (header) {
        header.classList.toggle('is-scrolled', window.scrollY > 8);
      }
      updateActiveSection();
      ticking = false;
    });
  }

  window.addEventListener('scroll', handleScroll, { passive: true });
  window.addEventListener('resize', handleScroll, { passive: true });

  /* ---------------- 4. 滚动淡入动画 ---------------- */
  function showAllReveals() {
    revealElements.forEach((element) => element.classList.add('is-visible'));
  }

  if ('IntersectionObserver' in window && revealElements.length) {
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target); // 只播放一次
        });
      },
      {
        threshold: 0.12,
        rootMargin: '0px 0px -6% 0px',
      },
    );

    revealElements.forEach((element) => observer.observe(element));
  } else {
    // 老浏览器或禁用 IntersectionObserver 时直接显示，保证内容可读
    showAllReveals();
  }

  /* ---------------- 初始化 ---------------- */
  handleScroll();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', handleScroll, { once: true });
  }
})();
