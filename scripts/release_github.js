#!/usr/bin/env node
/**
 * GitHub 发布脚本（可复用）
 *
 * 用法：
 *   node scripts/release_github.js <版本号> [--dry-run]
 *   例：node scripts/release_github.js 3.12.2
 *
 * 它会依次完成：
 *   1. 校验 VERSION 文件、安装包存在性
 *   2. 推送当前分支（快进；分叉时提示，不强制覆盖）
 *   3. 打注释 tag 并推送
 *   4. 创建 GitHub Release 并上传安装包
 *
 * 设计要点（都是踩坑得来的）：
 *   - Token 从 Windows 凭据管理器（wincred）读取，经**环境变量**注入 git，
 *     不写入命令行参数，避免出现在进程列表与日志中。
 *   - 凭据助手用 `!f(){...}; f` 形式临时覆盖，绕过 GCM ——
 *     非交互环境下 GCM 可能挂起或崩溃（本项目历史上遇到过 segfault）。
 *   - 推送前检查本地与远端的分叉状态；**只在可快进时推送**，
 *     不擅自 --force，避免覆盖远端提交。
 *   - 发布说明优先用 docs/releases/github_release_<版本>.md（面向用户的完整变更集），
 *     回退到 docs/releases/release_notes_<版本>.md。
 */
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

// FIX（2026-09-30 迁移）：勿硬编码用户名 —— 从主目录推导，跨机器可用
// FIX（2026-10-15）：勿硬编码 PortableGit 版本号 —— 1.2.0 已升级到 1.3.0 导致
// spawnSync 返回 undefined.stdout 崩溃。改为：优先读 versions/current 指针文件
// （内容=当前版本号）；指针缺失/失效则扫描 versions/ 目录取存在的版本兜底。
const PG_ROOT = path.join(require('os').homedir(), '.workbuddy', 'binaries', 'PortableGit', 'versions');
function resolvePortableGit() {
  const cand = [];
  try {
    const cur = fs.readFileSync(path.join(PG_ROOT, 'current'), 'utf8').trim();
    if (cur) cand.push(path.join(PG_ROOT, cur));
  } catch (e) { /* 指针不存在，走目录扫描 */ }
  try {
    fs.readdirSync(PG_ROOT)
      .filter(n => /^\d+\.\d+\.\d+$/.test(n))
      .sort()
      .forEach(n => cand.push(path.join(PG_ROOT, n)));
  } catch (e) { /* 目录不可读 */ }
  for (const c of cand) {
    if (fs.existsSync(path.join(c, 'cmd', 'git.exe'))) return c;
  }
  return null;
}
const PG = resolvePortableGit();
if (!PG) {
  console.error('✗ 未找到 PortableGit（尝试 ' + PG_ROOT + '）。请确认 WorkBuddy 运行时已安装。');
  process.exit(1);
}
const GIT = PG + '/cmd/git.exe';
const WINCRED = PG + '/mingw64/bin/git-credential-wincred.exe';
const GH = 'C:/Program Files/GitHub CLI/gh.exe';
const REPO = path.resolve(__dirname, '..');
const REPO_SLUG = 'warlocks365/360video-converter';

const version = (process.argv[2] || '').trim();
const dryRun = process.argv.includes('--dry-run');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('用法: node scripts/release_github.js <版本号，如 3.12.2> [--dry-run]');
  process.exit(1);
}

const tag = 'v' + version;
const fail = (m) => { console.error('\n✗ ' + m); process.exit(1); };
const sh = (cmd, args, opts = {}) => cp.spawnSync(cmd, args, { cwd: REPO, encoding: 'utf8', windowsHide: true, ...opts });

// ── 1. 前置校验 ──
const verFile = fs.readFileSync(path.join(REPO, 'VERSION'), 'utf8').trim();
if (verFile !== version) fail(`VERSION 文件为 ${verFile}，与请求的 ${version} 不一致。请先更新 VERSION。`);

const installer = path.join(REPO, 'installer_output', `360VideoConverter_Setup_v${version}.exe`);
if (!fs.existsSync(installer)) fail(`未找到安装包 ${installer}。请先运行 build_exe.py 与 ISCC。`);
const sizeMB = (fs.statSync(installer).size / 1048576).toFixed(1);

const notesCandidates = [
  path.join(REPO, 'docs', 'releases', `github_release_v${version}.md`),
  path.join(REPO, 'docs', 'releases', `release_notes_v${version}.md`),
];
const notesFile = notesCandidates.find(p => fs.existsSync(p));
if (!notesFile) fail(`未找到发布说明，尝试过：\n   ${notesCandidates.join('\n   ')}`);

const branch = sh(GIT, ['branch', '--show-current']).stdout.trim();
console.log(`版本    : ${version}`);
console.log(`分支    : ${branch}`);
console.log(`安装包  : ${path.basename(installer)}  ${sizeMB} MB`);
console.log(`发布说明: ${path.relative(REPO, notesFile).replace(/\\/g, '/')}`);
console.log(`目标仓库: ${REPO_SLUG}`);

// 工作区必须干净（否则发布的代码与预期不符）
const dirty = sh(GIT, ['status', '--porcelain']).stdout.trim();
if (dirty) {
  console.log('\n⚠️  工作区存在未提交改动：');
  console.log(dirty.split('\n').map(l => '   ' + l).join('\n'));
  fail('请先提交或清理后再发布，避免发布的代码与本地不一致。');
}

if (dryRun) { console.log('\n--dry-run：前置校验通过，未执行任何写操作。'); process.exit(0); }

// ── 2. 取 token（仅经环境变量传递）──
let TOKEN;
try {
  const out = cp.execFileSync(WINCRED, ['get'],
    { input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8', windowsHide: true });
  TOKEN = (out.match(/^password=(.+)$/m) || [])[1];
  if (TOKEN) TOKEN = TOKEN.trim();
} catch (e) { /* 下方统一报错 */ }
if (!TOKEN) fail('未能从 Windows 凭据管理器取到 github.com 的 token（git-credential-wincred）。');

const helper = '!f() { test "$1" = get && { echo username=x-access-token; echo password="$GH_PUSH_TOKEN"; }; }; f';
const gitAuth = (args) => sh(GIT, ['-c', 'credential.helper=', '-c', 'credential.helper=' + helper, ...args],
  { env: { ...process.env, GH_PUSH_TOKEN: TOKEN } });
const gh = (args) => sh(GH, args, { env: { ...process.env, GH_TOKEN: TOKEN, NO_COLOR: '1' } });

// ── 3. 推送前检查分叉（只允许快进）──
sh(GIT, ['fetch', 'origin', '--tags', '--prune']);
const lr = sh(GIT, ['rev-list', '--left-right', '--count', `origin/${branch}...HEAD`]).stdout.trim().split(/\s+/);
const behind = Number(lr[0]), ahead = Number(lr[1]);
console.log(`\n分叉检查: 落后远端 ${behind} 个提交，领先 ${ahead} 个`);
if (Number.isNaN(behind)) console.log('  （远端分支不存在，将作为新分支推送）');
if (behind > 0) fail(`本地落后远端 ${behind} 个提交，直接推送会失败。请先 pull/rebase。`);

// ── 4. 推送分支 ──
console.log('\n[1/3] 推送分支…');
const pushB = gitAuth(['push', 'origin', branch]);
if (pushB.stderr) process.stdout.write('   ' + pushB.stderr.trim().split('\n').slice(-2).join('\n   ') + '\n');
if (pushB.status !== 0) fail('分支推送失败。');

// ── 5. 打 tag 并推送 ──
console.log('\n[2/3] 打 tag 并推送…');
const existing = sh(GIT, ['tag', '--list', tag]).stdout.trim();
if (existing) {
  console.log(`   tag ${tag} 已存在，跳过创建`);
} else {
  const t = sh(GIT, ['tag', '-a', tag, '-m', `${tag} — 见 docs/releases/${path.basename(notesFile)}`]);
  if (t.status !== 0) fail('创建 tag 失败：' + (t.stderr || '').trim());
}
const pushT = gitAuth(['push', 'origin', tag]);
if (pushT.status !== 0) fail('tag 推送失败：' + (pushT.stderr || '').trim());
console.log('   ' + (pushT.stderr || '').trim().split('\n').slice(-1)[0]);

// ── 6. 创建 Release 并上传安装包 ──
// ⚠️ 必须显式传 target=<当前分支>。tag 已存在时若省略，GitHub 会把
// targetCommitish 默认成仓库**默认分支**（本仓库为 main），于是新发行的这一项
// 与历史发行不一致 —— v3.12.2 首次发布时即出现该问题（显示 main 而非
// v3.0.0-stabilization），事后用 `gh release edit --target` 补救。
// FIX（2026-10-15）：本机无 GitHub CLI（gh.exe 路径失效）→ 增加 REST API
// 回退通道（Node 内置 https，token 仍只经环境变量/内存传递，不落盘不上命令行）。
const notesBody = fs.readFileSync(notesFile, 'utf8');
const h1 = notesBody.split('\n').find(l => l.startsWith('# '));
const title = h1 ? h1.replace(/^#\s*/, '').trim() : tag;

console.log('\n[3/3] 创建 Release 并上传安装包（大文件，请稍候）…');
console.log(`   标题: ${title}`);
console.log(`   目标: ${branch}`);

const ghExists = fs.existsSync(GH);
let ok = false;

if (ghExists) {
  const rel = gh(['release', 'view', tag, '--repo', REPO_SLUG, '--json', 'tagName']);
  if (rel.status === 0 && rel.stdout.includes(tag)) {
    console.log(`   Release ${tag} 已存在，改为上传（覆盖同名资源）…`);
    gh(['release', 'edit', tag, '--repo', REPO_SLUG, '--target', branch]);   // 顺带纠正 target
    const up = gh(['release', 'upload', tag, installer, '--repo', REPO_SLUG, '--clobber']);
    if (up.status !== 0) fail('上传失败：' + (up.stderr || '').trim());
  } else {
    const cr = gh(['release', 'create', tag,
      '--repo', REPO_SLUG,
      '--target', branch,
      '--title', title,
      '--notes-file', path.relative(REPO, notesFile).replace(/\\/g, '/'),
      installer]);
    if (cr.status !== 0) fail('创建 Release 失败：' + (cr.stderr || '').trim());
    console.log('   ' + cr.stdout.trim());
  }

  // ── 7. 结果校验 ──
  const chk = gh(['release', 'view', tag, '--repo', REPO_SLUG, '--json', 'targetCommitish,assets']);
  try {
    const j = JSON.parse(chk.stdout);
    ok = j.targetCommitish === branch
      && j.assets.some(a => a.name === path.basename(installer) && a.state === 'uploaded');
    console.log(`\n校验: targetCommitish=${j.targetCommitish}（期望 ${branch}）` +
      `  资产=${j.assets.map(a => a.name + ' ' + (a.size / 1048576).toFixed(1) + 'MB').join(', ')}`);
  } catch (e) { /* 下面统一报错 */ }
} else {
  // ── REST API 回退通道（无 gh.exe 时）──
  console.log('   （未检测到 gh.exe，走 GitHub REST API 通道）');
  const https = require('https');
  const api = (method, p, body) => new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.github.com', path: p, method,
      headers: Object.assign(
        { 'User-Agent': 'release-script', 'Authorization': 'Bearer ' + TOKEN,
          'Accept': 'application/vnd.github+json' },
        body ? { 'Content-Type': 'application/json' } : {}),
    }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let j = null; try { j = JSON.parse(text); } catch (e) { /* 非 JSON 响应 */ }
        resolve({ status: r.statusCode, body: j, text });
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
  const upload = (uploadUrl, file) => new Promise((resolve, reject) => {
    const data = fs.readFileSync(file);
    const u = new URL(uploadUrl);
    const req = https.request({
      host: u.host, path: u.pathname + u.search, method: 'POST',
      headers: { 'User-Agent': 'release-script', 'Authorization': 'Bearer ' + TOKEN,
                'Content-Type': 'application/octet-stream', 'Content-Length': data.length },
    }, r => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
        resolve({ status: r.statusCode, body: j });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });

  (async () => {
    // 查询 Release 是否已存在（按 tag）
    const view = await api('GET', `/repos/${REPO_SLUG}/releases/tags/${tag}`);
    let releaseId;
    if (view.status === 200 && view.body && view.body.id) {
      releaseId = view.body.id;
      console.log(`   Release ${tag} 已存在（id=${releaseId}），纠正 target 并覆盖上传…`);
      const ed = await api('PATCH', `/repos/${REPO_SLUG}/releases/${releaseId}`,
        { target_commitish: branch, make_latest: 'true' });
      if (ed.status !== 200) fail('更新 Release 失败：HTTP ' + ed.status + ' ' + (ed.text || '').slice(0, 200));
      // 删除同名旧资产（等效 --clobber）
      const assetName = path.basename(installer);
      for (const a of (view.body.assets || [])) {
        if (a.name === assetName) {
          const del = await api('DELETE', `/repos/${REPO_SLUG}/releases/assets/${a.id}`);
          if (del.status !== 204) console.log(`   ⚠ 旧资产删除失败 HTTP ${del.status}，继续尝试上传`);
        }
      }
    } else if (view.status === 404) {
      const cr = await api('POST', `/repos/${REPO_SLUG}/releases`, {
        tag_name: tag, target_commitish: branch, name: title,
        body: notesBody, draft: false, prerelease: false, make_latest: 'true',
      });
      if (cr.status !== 201 || !cr.body || !cr.body.id) {
        fail('创建 Release 失败：HTTP ' + cr.status + ' ' + (cr.text || '').slice(0, 300));
      }
      releaseId = cr.body.id;
      console.log(`   Release 已创建（id=${releaseId}）`);
    } else {
      fail('查询 Release 失败：HTTP ' + view.status + ' ' + (view.text || '').slice(0, 200));
    }

    // 上传安装包
    const assetName = path.basename(installer);
    const upUrl = `https://uploads.github.com/repos/${REPO_SLUG}/releases/${releaseId}/assets?name=${encodeURIComponent(assetName)}`;
    const up = await upload(upUrl, installer);
    if (up.status !== 201) fail('上传安装包失败：HTTP ' + up.status + ' ' + JSON.stringify(up.body || {}).slice(0, 300));
    console.log(`   资产已上传: ${up.body.name} ${(up.body.size / 1048576).toFixed(1)}MB state=${up.body.state}`);

    // ── 7. 结果校验 ──
    const chk = await api('GET', `/repos/${REPO_SLUG}/releases/${releaseId}`);
    if (chk.status === 200 && chk.body) {
      const j = chk.body;
      ok = j.target_commitish === branch
        && (j.assets || []).some(a => a.name === assetName && a.state === 'uploaded');
      console.log(`\n校验: targetCommitish=${j.target_commitish}（期望 ${branch}）` +
        `  资产=${(j.assets || []).map(a => a.name + ' ' + (a.size / 1048576).toFixed(1) + 'MB').join(', ')}`);
    }
    if (!ok) fail('发布后校验未通过，请到 Releases 页面人工确认。');

    console.log('\n✓ 发布完成');
    console.log(`   https://github.com/${REPO_SLUG}/releases/tag/${tag}`);
  })().catch(e => fail('REST 通道异常：' + (e.message || e)));
  return;   // 异步通道自行收尾，跳过下方同步输出
}
if (!ok) fail('发布后校验未通过，请到 Releases 页面人工确认。');

console.log('\n✓ 发布完成');
console.log(`   https://github.com/${REPO_SLUG}/releases/tag/${tag}`);
