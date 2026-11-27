/**
 * 「更多」弹窗（#/cost）的买入/卖出录入补丁。
 *
 * 背景：右键个股 →「更多」打开的就是 SetCostWindow，路由 /cost?key=<key>，
 *       页面由冻结产物 cost.f9800ae8.js 渲染，只有别名/成本价/数量/提醒，
 *       无法直接改源码。本脚本由 scripts/inject-renderer.mjs 注入到 index.html，
 *       是所有窗口共用的，所以必须先用 location.hash 限定只在 #/cost 生效。
 *
 * 数据口径（与 src/main/service/stock.ts 的 processData 保持一致）：
 *   - 买入：新数量 = 原数量 + 买入数量；
 *           新成本价 = (原成本*原数量 + 买入价*买入数量) / 新数量（加权均价）；
 *           同时传 price + amount 给 set_cost，主进程会把成本基准日刷新为今天，
 *           于是当日盈亏走「(现价 - 新均价) * 新数量」分支。
 *   - 卖出：新数量 = 原数量 - 卖出数量；成本价保持不变；
 *           只传 amount，不刷新基准日，当日盈亏继续用昨收近似。
 *           卖出价用于展示本次已实现盈亏，不改变剩余持仓的成本（本工具没有
 *           已实现盈亏字段，强行改成本会让总盈亏失真）。
 *
 * 同步：① 主面板——写入走 config 'set_cost'，主进程 save() 广播 onConfig 且 diffKeys 含 'cost'，
 *       stock.ts 的 configLister 收到后立即重算并推送 stock-update，总盈亏/当日盈亏/合计即时刷新；
 *       ② 弹窗自身——emit('reload') 触发弹窗 Vue 重新执行 R() 读回 config，
 *       「股票数量(股)」「成本价」按钮立即显示新值（否则要下次打开弹窗才更新）。
 */
(function () {
  var req = window.require || (typeof require !== 'undefined' ? require : null);
  if (!req) return;
  var ipc;
  try { ipc = req('electron').ipcRenderer; } catch (e) { return; }

  // 只在「更多」弹窗运行；主面板 / 设置页 / 曲线窗口完全不受影响
  if (location.hash.indexOf('#/cost') !== 0) return;

  var m = /[?&]key=([^&]+)/.exec(location.hash);
  var key = m ? decodeURIComponent(m[1]) : null;
  var side = 'buy';
  var busy = false;

  // 复用窗口换股票时，Vue 内部变量 s 更新但路由 hash 不变，靠 reload 事件同步 key
  ipc.on('reload', function (_, k) { key = k; updateHolding(); });

  var css = document.createElement('style');
  css.textContent =
    // 「更多」窗口固定 460px 高，追加表单后可能超出；允许内容区滚动，不切掉输入框
    '.content[data-v-4f2a3fc4]{overflow-y:auto;padding-bottom:8px;box-sizing:border-box}' +
    '#sm-trade-box{font-size:10px;color:#222}' +
    '#sm-trade-box .sm-row{display:flex;align-items:center;gap:6px;margin:4px 0}' +
    '#sm-trade-box .sm-label{width:64px;flex:none;text-align:right}' +
    '#sm-trade-box input{flex:1;height:20px;font-size:10px;box-sizing:border-box}' +
    '#sm-trade-box button{height:20px;font-size:10px;padding:0 8px;cursor:pointer}' +
    '#sm-trade-box .sm-side-on{background:#238CF7;color:#fff;border-color:#238CF7}' +
    '#sm-trade-box .sm-msg{min-height:14px;color:#666}';
  document.head.appendChild(css);

  function build(host) {
    var box = document.createElement('div');
    box.id = 'sm-trade-box';
    box.innerHTML =
      '<div class="sm-title" style="margin-top:8px;border-top:1px solid #e0e0e0;padding-top:8px;font-weight:bold">交易录入（买入 / 卖出）</div>' +
      '<div class="sm-row">' +
        '<span class="sm-label">方向</span>' +
        '<button type="button" id="sm-side-buy">买入</button>' +
        '<button type="button" id="sm-side-sell">卖出</button>' +
      '</div>' +
      '<div class="sm-row">' +
        '<span class="sm-label">数量(股)</span>' +
        '<input id="sm-trade-qty" type="number" min="0" step="1" placeholder="成交数量">' +
      '</div>' +
      '<div class="sm-row">' +
        '<span class="sm-label">价格(元)</span>' +
        '<input id="sm-trade-price" type="number" min="0" step="0.01" placeholder="成交价格">' +
      '</div>' +
      '<div class="sm-row">' +
        '<span class="sm-label"></span>' +
        '<button type="button" id="sm-trade-ok">确定</button>' +
        '<span id="sm-trade-msg" class="sm-msg"></span>' +
      '</div>' +
      '<div style="color:#999;line-height:1.3">买入按加权均价更新成本；卖出只减少持仓、成本价不变。</div>';
    // 「更多」窗口固定 460px 高，追加到末尾会落在可视区下方、必须滚动才看得到。
    // 插到「股票数量」项之后，打开弹窗即可见；找不到锚点时退回到内容区开头。
    var anchor = null;
    var items = host.querySelectorAll('.item');
    for (var i = 0; i < items.length; i++) {
      if ((items[i].textContent || '').indexOf('股票数量') >= 0) { anchor = items[i]; break; }
    }
    if (anchor && anchor.nextSibling) host.insertBefore(box, anchor.nextSibling);
    else host.insertBefore(box, host.firstChild);
    document.getElementById('sm-side-buy').addEventListener('click', function () { setSide('buy'); });
    document.getElementById('sm-side-sell').addEventListener('click', function () { setSide('sell'); });
    document.getElementById('sm-trade-ok').addEventListener('click', submit);
    setSide('buy');
    updateHolding();
  }

  function setSide(s) {
    side = s;
    var b = document.getElementById('sm-side-buy');
    var l = document.getElementById('sm-side-sell');
    if (!b || !l) return;
    b.className = s === 'buy' ? 'sm-side-on' : '';
    l.className = s === 'sell' ? 'sm-side-on' : '';
  }

  function msg(text) {
    var el = document.getElementById('sm-trade-msg');
    if (el) el.textContent = text || '';
  }

  /** 从配置读取当前持仓，显示在消息栏，让用户录入前有个参照 */
  function updateHolding() {
    if (!key || !ipc || typeof ipc.invoke !== 'function') return;
    ipc.invoke('config', 'get').then(function (cfg) {
      var c = cfg && cfg.cost && cfg.cost[key];
      if (c && Number(c.amount) > 0) {
        msg('当前持仓 ' + c.amount + ' 股，成本 ' + Number(c.price).toFixed(3));
      } else {
        msg('当前无持仓');
      }
    }).catch(function () {});
  }

  async function submit() {
    if (busy) return;
    var qtyEl = document.getElementById('sm-trade-qty');
    var priceEl = document.getElementById('sm-trade-price');
    if (!qtyEl || !priceEl) return;
    var qty = parseFloat(qtyEl.value);
    var price = parseFloat(priceEl.value);
    if (!key) { msg('未获取到股票代码'); return; }
    if (!(qty > 0)) { msg('请填写有效数量'); return; }
    if (!(price > 0)) { msg('请填写有效价格'); return; }

    busy = true;
    try {
      var cfg = await ipc.invoke('config', 'get');
      var old = (cfg && cfg.cost && cfg.cost[key]) || {};
      var oldAmount = Number(old.amount) || 0;
      var oldPrice = Number(old.price) || 0;
      var newAmount, newPrice, extra = '';

      if (side === 'buy') {
        newAmount = oldAmount + qty;
        newPrice = (oldPrice * oldAmount + price * qty) / newAmount;
        // 同时传价格与数量：setCost 会把基准日刷成今天，当日盈亏立即按新均价计算
        await ipc.invoke('config', 'set_cost', { key: key, price: newPrice, amount: newAmount });
      } else {
        if (qty > oldAmount) { msg('卖出数量不能超过持仓 ' + oldAmount); return; }
        newAmount = oldAmount - qty;
        newPrice = oldPrice;
        // 只传数量：保留成本价与成本基准日；卖出价只用来估算本次盈亏
        await ipc.invoke('config', 'set_cost', { key: key, amount: newAmount });
        if (oldPrice > 0) {
          extra = '，本次约' + ((price - oldPrice) * qty >= 0 ? '盈利' : '亏损') +
            Math.abs((price - oldPrice) * qty).toFixed(2);
        }
      }
      qtyEl.value = '';
      priceEl.value = '';
      // 弹窗的「股票数量/成本价」是 Vue ref，只在 R() 里从 config 读取；set_cost 保存后
      // 它不会自己刷新。这里 emit 一个 reload（与主进程 SetCostWindow.reload() 同通道），
      // 触发弹窗 Vue 重新执行 R() 读回最新配置，让按钮上的数量/成本价立即同步。
      ipc.emit('reload', {}, key);
      msg((side === 'buy' ? '买入' : '卖出') + '已录入：' + newAmount + ' 股，成本 ' +
        Number(newPrice).toFixed(3) + extra + '（主面板盈亏与弹窗数量已同步）');
    } catch (e) {
      msg('保存失败：' + (e && e.message ? e.message : e));
    } finally {
      busy = false;
    }
  }

  // Vue 挂载比本脚本晚，且 cost 字段重新编辑时根节点会 patch；轮询保证表单一直在
  setInterval(function () {
    if (document.getElementById('sm-trade-box')) return;
    var host = document.querySelector('.content');
    if (host) build(host);
  }, 200);
})();
