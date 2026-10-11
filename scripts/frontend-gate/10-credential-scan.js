#!/usr/bin/env node
/**
 * 门禁 10：凭据泄漏扫描（仓库级安全检查）
 *
 * 起因（v3.13.18 收尾）：发布流程中曾在工作区落盘一枚明文 GitHub PAT
 * （`_cred_helper.sh`）。该文件最终未被提交，但暴露了两个问题：
 *   1) 人工清理不可靠——扫未跟踪文件时容易只看文件名不看内容；
 *   2) 仓库外（日志、团队消息）同样会扩散明文，git 扫描覆盖不到。
 *
 * 本门禁在「提交前」把关：命中即exit 1，且**只报 file:line，绝不回显凭据原文**，
 * 避免报错信息本身成为二次泄漏源。
 *
 * 用法：node scripts/frontend-gate/10-credential-scan.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');

// 凭据特征：GitHub PAT 各形态 / GitHub fine-grained / 常见云厂商 AK / 私钥头 / 通用高熵串
const PATTERNS = [
  { name: 'GitHub PAT (ghp_)', re: /\bghp_[A-Za-z0-9]{20,}/g },
  { name: 'GitHub OAuth (gho_)', re: /\bgho_[A-Za-z0-9]{20,}/g },
  { name: 'GitHub App/refresh (ghu_/ghs_)', re: /\bgh[us]_[A-Za-z0-9]{20,}/g },
  { name: 'GitHub fine-grained (github_pat_)', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'AWS Access Key (AKIA)', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: '私钥文件头', re: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
  { name: 'sk- 前缀高熵串', re: /\bsk-[A-Za-z0-9]{32,}\b/g },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'installer_output', '.workbuddy', '__pycache__']);
// 扫描文本：跳过明显是二进制/产物的文件
const SKIP_EXT = new Set(['.exe', '.dll', '.png', '.jpg', '.jpeg', '.gif', '.ico', '.mp4', '.zip', '.7z', '.pdf', '.woff', '.woff2', '.ttf']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.json', '.md', '.py', '.sh', '.html', '.css', '.txt', '.yml', '.yaml', '.iss', '.bat', '.ps1', '']);

function walk(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(full, out);
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (SKIP_EXT.has(ext) || !TEXT_EXT.has(ext)) continue;
      out.push(full);
    }
  }
  return out;
}

const files = walk(ROOT);
const hits = [];
for (const f of files) {
  let text;
  try { text = fs.readFileSync(f, 'utf8'); } catch (e) { continue; }
  for (const { name, re } of PATTERNS) {
    // 每次新建正则实例，避免 lastIndex 状态串扰
    const r = new RegExp(re.source, re.flags);
    let m;
    while ((m = r.exec(text)) !== null) {
      const line = text.slice(0, m.index).split('\n').length;
      hits.push({ file: path.relative(ROOT, f), line, name });
      break; // 同一文件同一类型只报一次，避免刷屏
    }
  }
}

console.log('门禁 10 — 凭据泄漏扫描');
console.log(`扫描文本文件 ${files.length} 个（已跳过二进制与产物目录）\n`);

if (!hits.length) {
  console.log('OK   未发现明文凭据特征');
  process.exit(0);
}

console.log('FAIL 发现疑似明文凭据：\n');
for (const h of hits) {
  console.log(`   ${h.file}:${h.line}  ${h.name}`);
}
console.log('\n处置要求：');
console.log('  1) 立即把该凭据视为「已暴露」——吊销并轮换（删除文件不等于凭据已处置，');
console.log('     日志/消息/备份等仓库外载体同样会扩散明文）；');
console.log('  2) 改用环境变量或stdin 注入，不要写进任何落盘文件；');
console.log('  3) 若曾被 commit，用 git filter-repo / BFG 改写历史并强推。');
console.log('\n（本输出刻意不回显凭据原文，避免报错信息成为二次泄漏源）');
process.exit(1);
