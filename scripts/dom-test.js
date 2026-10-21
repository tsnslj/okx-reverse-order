/**
 * DOM 级回归测试：验证「点启动反手」在没有任何原生对话框的环境下也有反应。
 *
 * 背景：内置预览面板会静默拦掉 confirm()，导致点击后直接 return，表现成「点了没反应」。
 * 这个脚本把 confirm/alert 换成会记仇的探针，一旦被调用就判定失败。
 *
 *   用法：node scripts/dom-test.js [http://127.0.0.1:8787]
 */
const path = require('path');
const NM = 'C:/Users/tfsnswlj/.workbuddy/binaries/node/workspace/node_modules';
const { JSDOM } = require(path.join(NM, 'jsdom'));

const BASE = process.argv[2] || 'http://127.0.0.1:8787';

const results = [];
function check(name, ok, extra) {
  results.push({ name, ok, extra });
  console.log(`${ok ? '  ✓' : '  ✗'} ${name}${extra ? ' — ' + extra : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('拉取页面 ' + BASE);
  const html = await (await fetch(BASE + '/')).text();
  console.log('HTML ' + html.length + ' 字符\n');

  const nativeDialogs = [];

  const dom = new JSDOM(html, {
    url: BASE + '/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(win) {
      // Node 的 fetch 借给页面用，相对路径按 BASE 解析
      win.fetch = (u, o) => fetch(new URL(u, BASE + '/').href, o);
      // 页面用 SSE 推日志，jsdom 没有，给个空壳
      win.EventSource = class {
        constructor() {}
        addEventListener() {}
        close() {}
      };
      // 原生对话框探针：被调用就说明我们还没改干净
      win.confirm = (m) => { nativeDialogs.push('confirm: ' + m); return false; };
      win.alert = (m) => { nativeDialogs.push('alert: ' + m); };
      win.prompt = (m) => { nativeDialogs.push('prompt: ' + m); return null; };
    },
  });

  const win = dom.window;
  const doc = win.document;
  const $ = (s) => doc.querySelector(s);
  const waitFor = async (fn, ms = 8000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      try { if (fn()) return true; } catch { /* 元素可能还没渲染 */ }
      await sleep(100);
    }
    return false;
  };

  // ── 1. 开关布局：label.switch 必须是 flex，否则滑轨塌成 0 宽、圆点压字 ──
  const swLabel = $('.field label.switch');
  check('找到实盘开关', !!swLabel);
  if (swLabel) {
    const d = win.getComputedStyle(swLabel).display;
    check('开关 label 是 flex（不再被 .field label{display:block} 覆盖）', d === 'flex', 'display=' + d);
    const track = swLabel.querySelector('.track');
    const td = track && win.getComputedStyle(track);
    check('滑轨是 flex 子项而非塌陷的 inline',
      !!td && td.flexBasis !== undefined, td ? `flex=${td.flex} basis=${td.flexBasis}` : '无 .track');
  }

  // ── 2. 等 init 跑完 ──
  const ready = await waitFor(() => $('#btnStart') && $('#btnStart').textContent.length > 0);
  check('页面初始化完成', ready, '按钮文字=' + ($('#btnStart') && $('#btnStart').textContent));

  const startBtn = $('#btnStart');
  startBtn.disabled = false; // 若引擎正在跑，测试里强制可点

  // ── 3. 点击启动：应弹出自绘弹窗，且不碰原生 confirm ──
  startBtn.click();
  const modalShown = await waitFor(() => !$('#modal').hidden, 3000);
  check('点击「启动反手」后弹出了确认框', modalShown,
    modalShown ? '' : '弹窗没出现');
  check('没有调用原生 confirm/alert', nativeDialogs.length === 0, nativeDialogs.join(' | '));
  if (modalShown) {
    check('弹窗标题是实盘确认', /实盘/.test($('#modalTitle').textContent), $('#modalTitle').textContent);
    check('弹窗正文说明了后果', /反手|持仓/.test($('#modalBody').textContent));
    check('主按钮文字为「以实盘启动」', /实盘启动/.test($('#modalOk').textContent));
  }

  // ── 4. 点「取消」：弹窗关闭，引擎不应启动 ──
  $('#modalCancel').click();
  await sleep(200);
  check('点取消后弹窗关闭', $('#modal').hidden === true);
  let st = await (await fetch(BASE + '/api/engine')).json();
  check('取消后引擎未启动', st.running === false, 'running=' + st.running);

  // ── 5. 切到演练模式（关掉实盘开关）再启动：不弹窗，直接起 ──
  const live = $('#fLive');
  live.checked = false;
  live.dispatchEvent(new win.Event('change', { bubbles: true }));
  await sleep(100);
  check('关闭实盘后按钮变成「启动演练」',
    /演练/.test($('#btnStart').textContent), $('#btnStart').textContent);

  $('#btnStart').click();
  const started = await waitFor(() => /运行中/.test($('#btnStart').textContent), 15000);
  check('点「启动演练」后引擎真的起来了', started, '按钮=' + $('#btnStart').textContent);
  const toastText = $('#toast').textContent;
  check('界面给出了可见提示', /启动/.test(toastText), toastText);

  st = await (await fetch(BASE + '/api/engine')).json();
  check('后端状态为运行中且是演练模式',
    st.running === true && st.args && st.args.live === false,
    `running=${st.running} live=${st.args && st.args.live}`);

  // ── 清理 ──
  await fetch(BASE + '/api/engine/stop', { method: 'POST' });
  await sleep(300);
  st = await (await fetch(BASE + '/api/engine')).json();
  check('测试结束已停止引擎', st.running === false);

  const bad = results.filter((r) => !r.ok);
  console.log(`\n${results.length - bad.length}/${results.length} 通过`);
  dom.window.close();
  process.exit(bad.length ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本异常：', e);
  process.exit(2);
});
