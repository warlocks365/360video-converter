// 门禁 12：CLI 内核与命令控制台架构锁定（v3.15.0）
// Spec: docs/design/v3150_cli_command_set.md §8-P1
// 断言面：注册表不变量 / 信封一致 / 禁区 level / 路由存在 / 前端 DOM 契约 / 源标
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const R = path.resolve(__dirname, '..', '..');
const PY = path.join(process.env.USERPROFILE || os_home(), '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe');
function os_home() { return process.env.USERPROFILE || process.env.HOME; }

const results = [];
const check = (n, ok, d) => { results.push({ n, ok: !!ok, d: d || '' }); };

const appPy = fs.readFileSync(path.join(R, 'app.py'), 'utf8');
const html = fs.readFileSync(path.join(R, 'static/index.html'), 'utf8');
const core = fs.readFileSync(path.join(R, 'static/js/00-core.js'), 'utf8');
const cli86 = fs.readFileSync(path.join(R, 'static/js/86-cli.js'), 'utf8');

// 1) 内核注册表不变量（python 内省）
let reg;
try {
  reg = JSON.parse(execFileSync(PY, ['-c', `
import sys; sys.path.insert(0, r'${R}')
import json, cli_kernel as K
bad = []
for name, spec in K.REGISTRY.items():
    if spec['level'] not in ('L0','L1','L2','L3','FORBIDDEN'): bad.append(name+':level')
    if not spec['help']: bad.append(name+':help')
    for k, ty in spec['flags'].items():
        base = ty[:-1] if ty.endswith('?') else ty
        if base not in ('json','int','float','bool','str','path') and not base.startswith('choice:'):
            bad.append(name+':'+k+':'+ty)
# 信封键一致（执行一条必败命令与一条 L0 内置命令的键集）
def ctx(): return {'permission': lambda:'full','forward': lambda m,e,json_body=None,query=None:(200,{}),
  'job_status': lambda j,s:({},None),'job_log': lambda j,s:({},None),'task_list': lambda:[]}
e1 = K.execute('vc nope','agent-cli',ctx()); e2 = K.execute('vc help','agent-cli',ctx())
keys = sorted(e1.keys())
if keys != sorted(e2.keys()): bad.append('envelope-keys')
if e2['ok'] is not True or e1['ok'] is not False: bad.append('ok-semantics')
print(json.dumps({'count': len(K.REGISTRY), 'bad': bad,
  'forbidden': sorted([n for n,s in K.REGISTRY.items() if s['level']=='FORBIDDEN'])}))
`], { encoding: 'utf8', timeout: 30000 }));
} catch (e) { reg = null; }
check('12.1 内核注册表可加载且规格全合法', !!reg && reg.bad.length === 0,
  reg ? (reg.bad.join(',') || reg.count + ' 条命令') : 'python 执行失败');
check('12.2 命令数 ≥38（Spec §3）', !!reg && reg.count >= 38, reg && reg.count);
const FORBIDDEN_SET = ['vc config set', 'vc preset delete'];
check('12.3 禁区集合正确（config set / preset delete =FORBIDDEN）',
  !!reg && FORBIDDEN_SET.every(f => reg.forbidden.includes(f)) && reg.forbidden.length === 2,
  reg && reg.forbidden.join(' | '));
check('12.4 job cancel 未暴露为 agent 命令', !/'vc job cancel':/.test(fs.readFileSync(path.join(R, 'cli_kernel.py'), 'utf8')));

// 2) 后端挂载
check('12.5 /api/cli 路由存在（POST-only）', /@app\.route\('\/api\/cli', methods=\['POST'\]\)/.test(appPy));
check('12.6 /api/cli_confirm 路由存在', /@app\.route\('\/api\/cli_confirm', methods=\['POST'\]\)/.test(appPy));
check('12.7 cmdline 超长拒绝(>200KB)', /200000/.test(appPy) && /cmdline\.encode/.test(appPy));
check('12.8 log_line 带 seq 游标', /'_seq'\] = j\.get\('_seq', 0\) \+ 1/.test(appPy));

// 3) 前端契约
for (const id of ['cliConsoleCard', 'cliInput', 'cliRunBtn', 'cliConfirmBar', 'cliConfirmSummary', 'cliResult', 'cliManualSummary']) {
  check('12.9 DOM 契约 #' + id, html.includes('id="' + id + '"'));
}
check('12.10 cliInput 是 TEXTAREA（vendor input_text 支持面）', /<textarea[^>]+id="cliInput"/.test(html));
check('12.11 data-action 三注册进 DELEGATED_ACTIONS', /'cli-run':\s*\(\)\s*=>\s*cliRun\(\)/.test(core) && /'cli-approve':\s*\(\)\s*=>\s*cliApprove\(\)/.test(core) && /'cli-decline':\s*\(\)\s*=>\s*cliDecline\(\)/.test(core));
check('12.12 前端恒带 source=agent-cli', /source:\s*'agent-cli'/.test(cli86));
check('12.13 结果区含 echo_cmdline 归属校验（R2 陈旧防误读）', /echo_cmdline/.test(cli86));
check('12.14 前端零权限裁决逻辑（裁决只在后端内核）', !/readonly|standard|full/.test(cli86.replace(/\/\/.*$/gm, '')));

// 4) 控制台不进手风琴计数（门禁08 param-group=9 断言的兼容前提）
check('12.15 控制台用 card 不用 param-group', !/param-group[^"]*id="cli/.test(html));

const bad = results.filter(r => !r.ok);
console.log('══ 门禁 12：CLI 内核与控制台架构锁定 ══');
results.forEach(r => console.log((r.ok ? 'OK   ' : 'FAIL ') + r.n + (r.d ? '  → ' + r.d : '')));
console.log(`合计 ${results.length} 项，通过 ${results.length - bad.length}，失败 ${bad.length}`);
process.exit(bad.length ? 1 : 0);
