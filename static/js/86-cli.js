// ============================================================
// 86-cli.js — v3.15.0 命令控制台桥（page-agent CLI 通道的前端半边）
//
// 职责边界（Spec §8-P1）：本模块只做「转发 + 渲染 + 确认条」，
// **不裁决权限**——表E 矩阵在 cli_kernel 后端强制。前端即使被绕过
// （agent 直接 fetch /api/cli），裁决结果与从这里发起完全一致。
//
// 对 agent 的可见面：
//  · #cliInput 是 TEXTAREA —— vendor input_text 支持（isTextAreaElement 实证）
//  · #cliRunBtn 执行按钮；#cliResult 结果单 JSON 块（textContent 可被观察）
//  · #cliConfirmBar 确认条（standard 档 L2）：批准/取消都是普通按钮
//  · 说明区常显手册摘要 + vc help 动态全量
// ============================================================

// ── 状态（模块私有；window 面只挂 data-action 处理器）──
let _cliBusy = false;

async function cliRun() {
  if (_cliBusy) { showToast('上一条命令仍在执行', 'warning', 2000); return; }
  const input = document.getElementById('cliInput');
  const resultBox = document.getElementById('cliResult');
  const cmdline = (input.value || '').trim();
  if (!cmdline) { showToast('请输入 vc 命令（vc help 查看手册）', 'warning', 2500); return; }
  _cliBusy = true;
  const runBtn = document.getElementById('cliRunBtn');
  if (runBtn) runBtn.disabled = true;
  resultBox.style.display = 'block';
  resultBox.textContent = '执行中… ' + cmdline;   // 先落归属文本，agent 读到时不误认上一条
  try {
    const r = await fetch('/api/cli', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmdline: cmdline, source: 'agent-cli' }),
    });
    const env = await r.json();
    cliRenderEnvelope(env, cmdline);
  } catch (e) {
    resultBox.textContent = JSON.stringify({ ok: false, code: 'ERR_BACKEND',
      error: { kind: 'ERR_BACKEND', message: '网络/后端错误: ' + esc(e.message || String(e)), hint: '重试一次' } });
  } finally {
    _cliBusy = false;
    if (runBtn) runBtn.disabled = false;
  }
}

// 信封 → 单个 JSON 块（compact，键全保留——agent 按信封语义解析）
function cliRenderEnvelope(env, cmdline) {
  const box = document.getElementById('cliResult');
  // 归属校验字段：echo 命令与 seq，防 agent 把旧结果当新状态（Spec R2）
  const view = Object.assign({ echo_cmdline: cmdline }, env);
  box.textContent = JSON.stringify(view);
  box.dataset.echo = cmdline;
  if (env.code === 'ERR_PENDING_CONFIRM' && env.meta && env.meta.confirm_token) {
    cliShowConfirmBar(env.meta.confirm_token, env.meta.summary || cmdline);
  } else {
    cliHideConfirmBar();
  }
  // 同步一行进共享日志区（不扰动轮询游标：writeMetaScopeLog 直写模式）
  try { writeMetaScopeLog('[CLI] ' + cmdline + ' → ' + env.code, env.ok ? 'info' : 'warn'); } catch (e) {}
}

function cliShowConfirmBar(token, summary) {
  const bar = document.getElementById('cliConfirmBar');
  document.getElementById('cliConfirmSummary').textContent = summary;
  bar.dataset.token = token;
  bar.dataset.shownAt = String(Date.now());
  bar.style.display = 'flex';
}
function cliHideConfirmBar() {
  const bar = document.getElementById('cliConfirmBar');
  if (bar) { bar.style.display = 'none'; bar.dataset.token = ''; }
}

// 确认条延迟防护：出现后 <1.5s 的"批准/取消"视为可疑的非人类操作（agent 自动
// 点击的典型特征）。这是 UX 层防护（Spec §8-P1 前端不裁决的例外，仅防"助手自批
// 解锁"的越权体验）；安全边界仍在后端：full 档本就直通、readonly 本就全拒。
function cliHumanDelayOk(bar) {
  const shown = parseInt(bar.dataset.shownAt || '0', 10);
  return shown && (Date.now() - shown) >= 1500;
}

async function cliApprove() {
  const bar = document.getElementById('cliConfirmBar');
  const token = bar.dataset.token;
  if (!token) return;
  if (!cliHumanDelayOk(bar)) { showToast('请阅读待确认操作后再点击（此确认应由人工完成）', 'warning', 2500); return; }
  cliHideConfirmBar();
  await cliConfirmResolve(token, true);
}
async function cliDecline() {
  const bar = document.getElementById('cliConfirmBar');
  const token = bar.dataset.token;
  if (!token) return;
  if (!cliHumanDelayOk(bar)) { showToast('请稍候片刻再通过确认条操作', 'warning', 2000); return; }
  cliHideConfirmBar();
  await cliConfirmResolve(token, false);
}
async function cliConfirmResolve(token, approve) {
  const box = document.getElementById('cliResult');
  try {
    const r = await fetch('/api/cli_confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, approve: approve }),
    });
    const env = await r.json();
    box.style.display = 'block';
    box.textContent = JSON.stringify(Object.assign({ echo_cmdline: '(confirm ' + (approve ? 'approved' : 'declined') + ')' }, env));
  } catch (e) {
    showToast('确认提交失败: ' + (e.message || e), 'error', 3000);
  }
}

// 手册摘要常显（agent 不执行命令也能读到核心约定）
function cliInitHelp() {
  const el = document.getElementById('cliManualSummary');
  if (el && !el.textContent.trim()) {
    el.textContent = '编排五拍：探测(probe/file scan)→校验(config codec-check)→提交(job start-*)→轮询(job status --since-seq，每15s)→分支处置(失败项 skip/重提/上报)。'
      + '禁区：config set / preset delete / job cancel 对助手恒禁。幂等：提交带 --request-id。完整手册执行 vc help。';
  }
}

// 入口按钮与 AI 助手开关联动：agent 关闭时控制台也隐藏（零注入面）
function vcCliVisibilitySync(enabled) {
  const card = document.getElementById('cliConsoleCard');
  if (card) card.style.display = enabled ? '' : 'none';
}

// ── data-action 已在 00-core DELEGATED_ACTIONS 定义处登记（cli-run/cli-approve/
//    cli-decline），与 agent-toggle 同法——86 加载时运行时补注册对门禁 06 的
//    静态源码扫描不可见，故不在此重复。
// 手册摘要初始化（脚本位于 body 尾，DOM 已就绪）
cliInitHelp();
