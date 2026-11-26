/**
 * 极简纯透明补丁的运行时开关。
 *
 * 背景：设置页的「背景透明度」只能改 #table 面板自身的 background，
 *       Element Plus 表格行/表头写死了 --el-fill-color-blank:#fff，
 *       因此光拉滑条仍会残留一行行白底。本脚本负责在透明度拉到最低时
 *       给 <html> 加 sm-transparent 类，让 transparent.css 生效。
 *
 * 设计：不新增配置项、不新增托盘开关，完全跟随用户熟悉的 backAlpha：
 *   - backAlpha <= THRESHOLD → 加类（纯透明，只显示文字和图标）
 *   - 其它值                → 移除类（界面 100% 恢复原样）
 *
 * 触发时机：
 *   1. 页面初始化时读一次配置；
 *   2. 用 MutationObserver 监听 #table 的 style 变化（Vue 改 backAlpha 会改内联 background），
 *      这样在设置页拉动滑条后无需重启即可即时生效；
 *   3. 低频兜底轮询，防止 observer 因 DOM 重建漏掉事件。
 *
 * 只在主面板（存在 #table）时挂类，设置页/其它窗口不会受到影响。
 */
(function () {
  var THRESHOLD = 10; // backAlpha 0~255，<=10 视为「背景透明度拉到最低」
  var cls = 'sm-transparent';
  var req = window.require || (typeof require !== 'undefined' ? require : null);
  if (!req) return;
  var ipc;
  try { ipc = req('electron').ipcRenderer; } catch (e) { return; }

  var lastAlpha = null;

  function apply(alpha) {
    if (typeof alpha !== 'number' || isNaN(alpha)) return;
    // 关键：必须先确认主面板存在，再更新 lastAlpha。
    // 若页面刚加载、#table 尚未挂载时就把读到的 alpha 记进 lastAlpha，
    // 等表格出现后再读到同一个值会被「值未变」去重直接跳过，导致类永远加不上。
    var table = document.getElementById('table');
    if (!table) return; // 设置页等没有主面板的窗口：不记录、不挂类
    if (alpha === lastAlpha) return;
    lastAlpha = alpha;
    if (alpha <= THRESHOLD) document.documentElement.classList.add(cls);
    else document.documentElement.classList.remove(cls);
  }

  // 从 #table 的内联 background 解析 alpha（hex8 或 rgba），用作即时判断
  function alphaFromStyle() {
    var table = document.getElementById('table');
    if (!table || !table.style) return null;
    var bg = table.style.background || table.style.backgroundColor || '';
    var m = /^#([0-9a-f]{8})$/i.exec(bg.trim());
    if (m) return Math.round(parseInt(m[1].slice(6, 8), 16) / 255 * 255);
    m = /rgba?\(([^)]+)\)/i.exec(bg);
    if (m) {
      var parts = m[1].split(',');
      var a = parts.length > 3 ? parseFloat(parts[3]) : 1;
      return isNaN(a) ? null : Math.round(a * 255);
    }
    return null;
  }

  function syncFromConfig() {
    if (!ipc || typeof ipc.invoke !== 'function') return;
    ipc.invoke('config', 'get').then(function (cfg) {
      if (cfg && typeof cfg.backAlpha === 'number') apply(cfg.backAlpha);
    }).catch(function () {});
  }

  // 1. 初始化：配置读取 + 内联样式双保险
  syncFromConfig();
  apply(alphaFromStyle());

  // 2. 即时响应滑条：监听 body 子树与 style 属性变化
  try {
    var observer = new MutationObserver(function () {
      var a = alphaFromStyle();
      if (a !== null) apply(a);
    });
    observer.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['style']
    });
  } catch (e) {}

  // 3. 兜底轮询：DOM 重建或 observer 漏事件时，最多 2 秒后自动纠正
  setInterval(syncFromConfig, 2000);
})();
