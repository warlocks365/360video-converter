# -*- coding: utf-8 -*-
"""
v3.15.0 CLI 内核 —— page-agent 原生调用通道（Spec: docs/design/v3150_cli_command_set.md）

单一真源命令注册表：/api/cli（HTTP 桥）与 exe --cli（远期进程入口）共用本内核。
权限模型（docs/FEATURE_CATALOG.md 表E）在此**后端强制**——前端包装门只是 UX 层。

设计纪律：
- 内核不 import flask/app（由 app.py 注入 forward(settings_getter) 回调），可独立单测
- 所有返回统一信封 {ok, code, data, error:{kind,message,hint}, meta}
- hint 是给 agent 的处置指令（重试/换参/上报/中止），一等公民字段
- GUI 来源（source != 'agent-cli'）不受 agent 权限矩阵约束——本内核只为 agent 存在
"""

import json
import re
import shlex
import time
import uuid

# ── 权限级常量（表E）──────────────────────────────────────────
L0 = 'L0'; L1 = 'L1'; L2 = 'L2'; L3 = 'L3'; FORBIDDEN = 'FORBIDDEN'

# HTTP 状态码映射（§4.2）
HTTP_BY_CODE = {
    'OK': 200, 'OK_IDEMPOTENT': 200, 'ERR_PENDING_CONFIRM': 202,
    'ERR_USAGE': 400, 'ERR_VALIDATION': 422, 'ERR_NOT_FOUND': 404,
    'ERR_JOB_ACTIVE': 409, 'ERR_JOB_FINISHED': 410,
    'ERR_PERMISSION_READONLY': 403, 'ERR_PERMISSION_DECLINED': 406,
    'ERR_FORBIDDEN': 403, 'ERR_BACKEND': 502, 'ERR_FFMPEG': 500, 'ERR_TIMEOUT': 504,
}
EXIT_BY_CODE = {  # --cli 进程模式用（Phase 3 预留，本期单测断言用）
    'OK': 0, 'OK_IDEMPOTENT': 0, 'ERR_USAGE': 1, 'ERR_VALIDATION': 2, 'ERR_NOT_FOUND': 2,
    'ERR_JOB_ACTIVE': 4, 'ERR_JOB_FINISHED': 4, 'ERR_PERMISSION_READONLY': 3,
    'ERR_PERMISSION_DECLINED': 3, 'ERR_FORBIDDEN': 3, 'ERR_PENDING_CONFIRM': 7,
    'ERR_BACKEND': 5, 'ERR_FFMPEG': 6, 'ERR_TIMEOUT': 5,
}

# ── 命令注册表（name → 规格）────────────────────────────────
# 字段：level 权限级 | flags 参数 | help 一行说明（agent 手册即从此生成）
# exec 内部路由描述（kind+上游端点）——app.py 注入的 forward 执行
def _cmd(level, flags, help_text, kind, endpoint=None, note=''):
    return {'level': level, 'flags': flags, 'help': help_text, 'kind': kind,
            'endpoint': endpoint, 'note': note}

REGISTRY = {
    # ── vc help ──
    'vc help': _cmd(L0, {'group': 'str?'}, '命令手册（全量或按组/单条）', 'builtin_help'),

    # ── vc job：任务生命周期（9）──
    'vc job start-convert': _cmd(L2, {'mode': 'choice:single,merge,batch?', 'items': 'json', 'params': 'json?',
                                      'request-id': 'str?'}, '启动转码作业', 'forward', '/api/convert'),
    'vc job start-vr3d': _cmd(L2, {'left': 'path', 'right': 'path', 'output': 'path',
                                   'layout': 'choice:top-bottom,left-right?'}, '启动 VR3D 双目合成', 'forward', '/api/start_vr3d'),
    'vc job apply-metadata': _cmd(L2, {'items': 'json', 'params': 'json?', 'request-id': 'str?'}, '不重编码写入元数据', 'forward', '/api/apply_metadata'),
    'vc job status': _cmd(L0, {'id': 'str', 'since-seq': 'int?'}, '作业紧凑状态+增量日志', 'builtin_status'),
    'vc job log': _cmd(L0, {'id': 'str', 'since-seq': 'int?'}, '作业日志增量', 'builtin_log'),
    'vc job pause': _cmd(L2, {'id': 'str'}, '暂停作业', 'forward', '/api/pause/<id>'),
    'vc job resume': _cmd(L2, {'id': 'str'}, '恢复作业', 'forward', '/api/resume/<id>'),
    'vc job skip-item': _cmd(L2, {'id': 'str', 'index': 'int'}, '跳过指定条目', 'forward', '/api/item/<id>/<index>/skip'),
    'vc job add-items': _cmd(L2, {'id': 'str', 'items': 'json'}, '追加队列条目', 'forward', '/api/add_items/<id>'),

    # ── vc probe：媒体探测（7，全 L0）──
    'vc probe file': _cmd(L0, {'path': 'path'}, 'ffprobe 完整信息', 'forward', '/api/probe'),
    'vc probe source': _cmd(L0, {'path': 'path'}, 'GPS+拍摄时间提取', 'forward', '/api/probe-source'),
    'vc probe metadata': _cmd(L0, {'path': 'path'}, '元数据标签', 'forward', '/api/probe_metadata'),
    'vc probe date': _cmd(L0, {'path': 'path'}, '文件名日期提取', 'forward', '/api/extract_date'),
    'vc probe fs-time': _cmd(L0, {'path': 'path'}, '文件系统时间', 'forward', '/api/file_fs_time'),
    'vc probe insv-pair': _cmd(L0, {'path': 'path'}, 'Insta360 insv 配对检测', 'forward', '/api/insta360/detect_pair'),
    'vc probe vr3d-alignment': _cmd(L0, {'left': 'path', 'right': 'path'}, '左右眼对齐检查', 'forward', '/api/vr3d/check_alignment'),

    # ── vc file：目录与文件（3）──
    'vc file scan': _cmd(L0, {'dir': 'path', 'recursive': 'bool?'}, '扫描目录视频文件', 'forward', '/api/scan'),
    'vc file browse': _cmd(L0, {'dir': 'path?'}, '列目录', 'forward', '/api/browse'),
    'vc file drives': _cmd(L0, {}, '盘符列表', 'forward', '/api/drives'),

    # ── vc config：应用配置（6）──
    'vc config show': _cmd(L0, {}, '当前设置（密钥恒哨兵掩码）', 'forward', '/api/settings'),
    'vc config set': _cmd(FORBIDDEN, {'fields': 'json'}, '改设置——对 AI 助手恒禁（防自我改写端点）', 'forward', '/api/settings',
                          note='请由用户在 设置 面板手动完成'),
    'vc config codecs': _cmd(L0, {}, '编码器清单', 'forward', '/api/codecs'),
    'vc config codec-check': _cmd(L0, {'codec': 'str?'}, '编码器可用性检查', 'forward', '/api/codec_check'),
    'vc config test-ffmpeg': _cmd(L0, {'path': 'path?'}, 'ffmpeg 可执行性测试', 'forward', '/api/test_ffmpeg'),
    'vc config test-encoder': _cmd(L0, {'encoder': 'str', 'ffmpeg-path': 'path?'}, '单编码器详测', 'forward', '/api/test_encoder_detail'),

    # ── vc preset：预设（3）──
    'vc preset list': _cmd(L0, {}, '预设列表', 'forward', '/api/presets'),
    'vc preset save': _cmd(L2, {'name': 'str', 'params': 'json?'}, '保存预设（覆盖既有名=L3 拒绝）', 'forward', '/api/presets'),
    'vc preset delete': _cmd(FORBIDDEN, {'name': 'str'}, '删预设——AI 助手恒禁（表E L3）', 'forward', '/api/presets/<name>',
                             note='请由用户在 预设 下拉手动删除'),

    # ── vc task：任务文件（2）──
    'vc task save': _cmd(L2, {'name': 'str', 'items': 'json?', 'params': 'json?'}, '保存任务清单文件', 'forward', '/api/tasks/save'),
    'vc task list': _cmd(L0, {}, '已保存任务文件列表', 'builtin_tasklist'),

    # ── vc geo：地理（2）──
    'vc geo search': _cmd(L0, {'q': 'str', 'provider': 'choice:amap,osm?'}, '地点搜索（同源代理）', 'forward', '/api/geocode'),
    'vc geo reverse': _cmd(L0, {'lat': 'float', 'lon': 'float', 'provider': 'choice:amap,osm?'}, '逆地理（同源代理）', 'forward', '/api/geocode'),

    # ── vc report：报告（3）──
    'vc report generate': _cmd(L1, {'paths': 'json?', 'directory': 'path?', 'recursive': 'bool?'}, '生成元数据报告（作业制，无文件副作用）', 'forward', '/api/report'),
    'vc report save': _cmd(L2, {'path': 'path', 'content': 'str'}, '报告写盘', 'forward', '/api/save_report'),
    'vc report diagnostic': _cmd(L0, {}, '诊断报告', 'forward', '/api/diagnostic_report'),

    # ── vc sys：系统（2）──
    'vc sys version': _cmd(L0, {}, '版本信息', 'forward', '/api/version'),
    'vc sys monitor': _cmd(L0, {}, '资源占用快照', 'forward', '/api/sysmon'),

    # ── 确认流 ──
    'vc cli-confirm': _cmd(L0, {'token': 'str'}, '查询确认条状态（pending/approved/declined/done）', 'builtin_confirm_query'),
}

# start 类命令幂等表与确认 token 存储（进程内）
_IDEMPOTENCY = {}          # request_id -> {"job_id":..., "ts":...}
_IDEM_MAX = 64
PENDING_CONFIRMS = {}      # token -> {"cmdline","args","summary","created","state","result"}
_CONFIRM_TTL = 180.0


# ── 信封辅助 ─────────────────────────────────────────────────
def envelope(code, data=None, error=None, cmd='', **meta):
    ok = code == 'OK' or code == 'OK_IDEMPOTENT'
    env = {'ok': ok, 'code': code,
           'data': data if ok else None,
           'error': None if ok else error,
           'meta': {'cmd': cmd, 'ts': time.strftime('%Y-%m-%dT%H:%M:%S%z'), **{k: v for k, v in meta.items() if v is not None}}}
    return env


def _err(kind, message, hint=''):
    return {'kind': kind, 'message': message, 'hint': hint}


# ── 解析 ─────────────────────────────────────────────────────
def parse_commandline(cmdline):
    """返回 (name, args_dict) 或 (None, 错误信封)。"""
    try:
        toks = shlex.split(cmdline)
    except ValueError as e:
        return None, ('ERR_USAGE', '命令引号不闭合: %s' % e, '用单引号包裹 JSON 参数值，或改写命令')
    if not toks:
        return None, ('ERR_USAGE', '空命令', '输入 vc help 查看可用命令')
    if toks[0] != 'vc':
        return None, ('ERR_USAGE', "命令必须以 'vc' 开头", '输入 vc help 查看可用命令')
    # 贪心匹配最长命令名（vc job start-convert > vc job）
    name = None
    rest_i = 0
    for i in range(len(toks), 1, -1):
        cand = ' '.join(toks[:i])
        if cand in REGISTRY:
            name = cand; rest_i = i; break
    if name is None:
        return None, ('ERR_USAGE', '未知命令: %s' % ' '.join(toks[:3]), 'vc help 查看命令清单')
    spec = REGISTRY[name]
    args = {}
    t = toks[rest_i:]
    i = 0
    while i < len(t):
        flag = t[i]
        if not flag.startswith('--') or i + 1 >= len(t):
            return None, ('ERR_USAGE', '无法解析的参数: %s' % flag, '每个 --flag 后必须跟一个值')
        key = flag[2:]
        known = spec['flags'].get(key)
        if known is None:
            return None, ('ERR_USAGE', '命令 %s 无参数 --%s' % (name, key),
                          'vc help "%s" 查看该命令参数' % name)
        val = t[i + 1]; i += 2
        args[key] = val
    return (name, args), _validate(name, args)


def _validate(name, args):
    """类型与必填校验。返回 None=通过，否则 (code,message,hint)。"""
    spec = REGISTRY[name]
    for key, ty in spec['flags'].items():
        optional = ty.endswith('?')
        base = ty[:-1] if optional else ty
        v = args.get(key)
        if v is None:
            if not optional:
                return ('ERR_USAGE', '缺少必填参数 --%s' % key, 'vc help "%s"' % name)
            continue
        if base == 'json':
            try:
                parsed = json.loads(v)
                args[key] = parsed
            except Exception as e:
                return ('ERR_VALIDATION', '--%s 不是合法 JSON: %s' % (key, e), '用单引号包裹整个 JSON')
        elif base == 'int':
            try:
                args[key] = int(v)
            except Exception:
                return ('ERR_VALIDATION', '--%s 需要整数' % key, '')
        elif base == 'float':
            try:
                args[key] = float(v)
            except Exception:
                return ('ERR_VALIDATION', '--%s 需要数字' % key, '')
        elif base == 'bool':
            if v.lower() not in ('true', 'false', '1', '0', 'yes', 'no'):
                return ('ERR_VALIDATION', '--%s 需要 true/false' % key, '')
            args[key] = v.lower() in ('true', '1', 'yes')
        elif base.startswith('choice:'):
            choices = base[len('choice:'):].split(',')
            if args.get(key) is not None and v not in choices:
                return ('ERR_VALIDATION', '--%s 取值须为 %s' % (key, '|'.join(choices)), '')
    return None


# ── 权限裁决（表E × 会话档，后端强制）─────────────────────────
def check_permission(name, source, session_perm):
    """返回 None=放行，否则 (code,message,hint)。仅对 agent 会话生效。"""
    spec = REGISTRY[name]
    if source != 'agent-cli':
        return None  # GUI/进程直连不受 agent 矩阵约束
    level = spec['level']
    if level == FORBIDDEN:
        return ('ERR_FORBIDDEN', '命令 %s 对 AI 助手恒禁' % name,
                spec.get('note') or '请由用户手动操作')
    if level == L3:
        return ('ERR_PERMISSION_READONLY', '命令 %s 属破坏级(L3)，AI 助手各权限档均拒绝' % name,
                '请由用户手动操作后助手继续')
    if level == L2:
        if session_perm == 'readonly':
            return ('ERR_PERMISSION_READONLY', '当前权限为「只读」，已拦截 %s' % name,
                    '可把步骤文字化上报用户，或建议用户在 设置→AI助手 调至「标准」')
        if session_perm == 'standard':
            return 'CONFIRM'  # 交由执行层生成确认 token
    return None


# ── 确认流 ───────────────────────────────────────────────────
def create_confirm(name, args, cmdline):
    token = uuid.uuid4().hex[:16]
    summary = '%s %s' % (name, _redact_args(args))
    PENDING_CONFIRMS[token] = {'name': name, 'args': args, 'cmdline': cmdline,
                               'summary': summary, 'created': time.time(), 'state': 'pending', 'result': None}
    _gc_confirms()
    return token, summary


def _redact_args(args):
    out = {}
    for k, v in args.items():
        if k in ('items', 'params', 'content', 'paths'):
            out[k] = '<%d bytes json>' % len(json.dumps(v, ensure_ascii=False)) if isinstance(v, (dict, list)) else v
        else:
            out[k] = v
    return json.dumps(out, ensure_ascii=False)[:220]


def _gc_confirms():
    now = time.time()
    for tk in [k for k, v in PENDING_CONFIRMS.items() if now - v['created'] > _CONFIRM_TTL]:
        PENDING_CONFIRMS.pop(tk, None)
    while len(PENDING_CONFIRMS) > 32:
        oldest = min(PENDING_CONFIRMS, key=lambda k: PENDING_CONFIRMS[k]['created'])
        PENDING_CONFIRMS.pop(oldest, None)


def resolve_confirm(token, approve):
    rec = PENDING_CONFIRMS.get(token)
    if not rec:
        return None, envelope('ERR_NOT_FOUND', error=_err('ERR_NOT_FOUND', '确认 token 不存在或已过期', '重新提交命令'))
    if rec['state'] != 'pending':
        return rec, envelope('OK', data={'state': rec['state'], 'summary': rec['summary']}, cmd='cli-confirm')
    rec['state'] = 'approved' if approve else 'declined'
    return rec, envelope('OK', data={'state': rec['state'], 'summary': rec['summary']}, cmd='cli-confirm')


def finalize_confirm(token, ctx):
    """用户批准后执行滞留命令（确认流闭环；app 侧 /api/cli_confirm approve 调用）。"""
    rec = PENDING_CONFIRMS.get(token)
    if not rec:
        return envelope('ERR_NOT_FOUND', error=_err('ERR_NOT_FOUND', 'token 不存在/过期', '重新提交命令'), cmd='cli-confirm')
    if rec['state'] == 'declined':
        return envelope('ERR_PERMISSION_DECLINED', error=_err('ERR_PERMISSION_DECLINED', '用户已取消该操作', '尊重决定，中止该子任务并上报用户'), cmd=rec['name'])
    if rec['state'] in ('done', 'exec_failed'):
        return rec.get('result') or envelope('OK', data={'state': rec['state']}, cmd=rec['name'])
    if rec['state'] != 'approved':
        return envelope('ERR_PENDING_CONFIRM', error=_err('ERR_PENDING_CONFIRM', '用户尚未确认', 'wait 后用 vc cli-confirm 查询'), cmd=rec['name'])
    try:
        env = _run(rec['name'], rec['args'], ctx, rec['cmdline'])
    except Exception as e:
        env = envelope('ERR_BACKEND', error=_err('ERR_BACKEND', '确认后执行异常: %s' % str(e)[:200], '上报用户'), cmd=rec['name'])
    rec['state'] = 'done' if env['ok'] else 'exec_failed'
    rec['result'] = env
    return env


# ── help 自省（agent 手册即由此生成）──────────────────────────
def help_text(topic=None):
    if not topic or topic == 'all':
        lines = ['360VideoConverter CLI（v3.15.0，agent 命令手册）', '']
        groups = {}
        for name, spec in REGISTRY.items():
            if name == 'vc help':
                continue
            g = name.split(' ')[1]
            groups.setdefault(g, []).append((name, spec))
        for g in sorted(groups):
            lines.append('【vc %s】' % g)
            for name, spec in sorted(groups[g]):
                flags = ' '.join('--%s%s' % (k, '' if not v.endswith('?') else '(可省)') for k, v in spec['flags'].items())
                tag = {L0: '直接执行', L1: '直接执行', L2: '需权限(标准=用户确认)', L3: '拒绝', FORBIDDEN: '恒禁'}[spec['level']]
                lines.append('  %s %s —— %s（%s）' % (name, flags, spec['help'], tag))
        lines.append('')
        lines.append('编排五拍：探测(probe/file scan)→校验(config codec-check)→提交(job start-*)→轮询(job status --since-seq 每15s)→分支处置(失败项 skip/重提/上报)')
        lines.append('禁区：vc config set / vc preset delete / vc job cancel 对助手恒禁；output==input 原地覆盖拒绝。')
        lines.append('幂等：提交类命令带 --request-id，重试返回原 job_id。')
        return '\n'.join(lines)
    if topic in REGISTRY:
        spec = REGISTRY[topic]
        return '%s\n  说明: %s\n  权限: %s %s\n  参数: %s' % (
            topic, spec['help'], spec['level'], spec.get('note') or '',
            json.dumps(spec['flags'], ensure_ascii=False))
    g = 'vc ' + topic
    hit = [n for n in REGISTRY if n.startswith(g)]
    if hit:
        return help_text('all') if len(hit) < 2 else '\n'.join(help_text(n) for n in sorted(hit))
    return '未知主题: %s（vc help 看全表）' % topic


# ── 执行主入口 ───────────────────────────────────────────────
# ctx 由 app.py 注入:
#   ctx['forward'](method, endpoint, json_body=None, query=None) -> (status:int, data:dict)
#   ctx['job_status'](jid, since_seq) -> dict（读 jobs 字典）
#   ctx['job_log'](jid, since_seq) -> dict
#   ctx['permission']() -> str（settings.agent_permission）
#   ctx['task_list']() -> list
#   ctx['active_job']() -> jid|None（幂等/ERR_JOB_ACTIVE 判定辅助）
def execute(cmdline, source, ctx):
    res, verr = parse_commandline(cmdline)
    if res is None:
        code, msg, hint = verr
        return envelope(code, error=_err(code, msg, hint), cmd=cmdline[:80])
    name, args = res
    if verr is not None:  # 解析成功但 _validate 失败
        code, msg, hint = verr
        return envelope(code, error=_err(code, msg, hint), cmd=name)

    decision = check_permission(name, source, ctx['permission']() if source == 'agent-cli' else 'full')
    if isinstance(decision, str) and decision == 'CONFIRM':
        # 预校验：非法参数/原地覆盖等应在弹确认条**之前**拒绝（防垃圾确认条）
        if REGISTRY[name]['kind'] == 'forward':
            pre_body, _q = _map_payload(name, args)
            if isinstance(pre_body, tuple):
                return envelope(pre_body[0], error=_err(*pre_body), cmd=name)
        token, summary = create_confirm(name, args, cmdline)
        return envelope('ERR_PENDING_CONFIRM',
                        error=_err('ERR_PENDING_CONFIRM', '命令等待用户在控制台确认', 'wait 5s 后 vc cli-confirm --token %s；confirmed 前勿重复提交' % token),
                        cmd=name, confirm_token=token, summary=summary)
    if decision is not None:
        code, msg, hint = decision
        return envelope(code, error=_err(code, msg, hint), cmd=name)

    return _run(name, args, ctx, cmdline)


def _has_active_job(ctx):
    """提交类互斥查询：ctx['has_active_job']() -> (jid|None, mode|None)。"""
    fn = ctx.get('has_active_job')
    if not callable(fn):
        return None, None
    try:
        return fn()
    except Exception:
        return None, None

# 会创建新作业的命令：内核单活动互斥集合（GUI 的 ActiveJob 互斥在后端不可见，
# CLI 直连后端绕过前端门——本集合在内核补同一语义）
_SUBMIT_CMDS = {'vc job start-convert', 'vc job start-vr3d', 'vc job apply-metadata', 'vc report generate'}

def _run(name, args, ctx, cmdline=''):
    spec = REGISTRY[name]
    kind = spec['kind']

    # 幂等（提交类命令 + --request-id）——必须先于互斥：同 request-id 的重放
    # 返回**原结果**，不能被"当前有别的活动作业"误拒（agent 超时重试场景）。
    rid = args.get('request-id')
    if kind == 'forward' and rid and rid in _IDEMPOTENCY:
        hit = _IDEMPOTENCY[rid]
        if time.time() - hit['ts'] < 3600:
            return envelope('OK_IDEMPOTENT', data=hit['data'], cmd=name, request_id=rid)

    # v3.15.0：提交类命令内核互斥（apply-metadata/vr3d 后端端点本无并发防护，
    # CLI 统一补上；与 GUI ActiveJob 单活动语义一致，防并发提交互踩输出文件）
    if name in _SUBMIT_CMDS:
        busy, busy_mode = _has_active_job(ctx)
        if busy:
            return envelope('ERR_JOB_ACTIVE',
                            error=_err('ERR_JOB_ACTIVE', '已有活动作业占位（%s）' % busy_mode,
                                       '先 vc job status --id %s 跟踪它，或等其结束后重提' % busy),
                            cmd=name, job_id=busy)


    if kind == 'builtin_help':
        return envelope('OK', data={'manual': help_text(args.get('group'))}, cmd=name)

    if kind == 'builtin_forbidden':
        return envelope('ERR_FORBIDDEN', error=_err('ERR_FORBIDDEN', '命令 %s 对 AI 助手恒禁' % name,
                                                    spec.get('note') or '请由用户手动操作'), cmd=name)

    if kind == 'builtin_status':
        st, err = ctx['job_status'](args['id'], args.get('since-seq') or 0)
        if err:
            return envelope('ERR_NOT_FOUND', error=_err('ERR_NOT_FOUND', str(err), 'vc job status 前先确认 job_id；终态快照仅保留 1 小时'), cmd=name)
        return envelope('OK', data=st, cmd=name)

    if kind == 'builtin_log':
        lg, err = ctx['job_log'](args['id'], args.get('since-seq') or 0)
        if err:
            return envelope('ERR_NOT_FOUND', error=_err('ERR_NOT_FOUND', str(err), '确认 job_id 有效'), cmd=name)
        return envelope('OK', data=lg, cmd=name)

    if kind == 'builtin_confirm_query':
        rec = PENDING_CONFIRMS.get(args['token'])
        if not rec:
            return envelope('ERR_NOT_FOUND', error=_err('ERR_NOT_FOUND', 'token 不存在/过期', '重新提交命令获取新确认'), cmd=name)
        return envelope('OK', data={'state': rec['state'], 'summary': rec['summary'],
                                   'result': rec['result'] if rec['state'] in ('done', 'exec_failed') else None}, cmd=name)

    if kind == 'builtin_tasklist':
        return envelope('OK', data={'tasks': ctx['task_list']()}, cmd=name)

    # ── forward 类：按命令构造上游请求 ──
    endpoint = spec['endpoint']
    body, query = _map_payload(name, args)
    if isinstance(body, tuple):  # (code,msg,hint)
        return envelope(body[0], error=_err(*body), cmd=name)
    # geo provider 路由：amap→/api/geocode，osm→/api/nominatim（参数形态各异）
    if name.startswith('vc geo'):
        prov = args.get('provider', 'amap')
        if prov == 'osm':
            endpoint = '/api/nominatim'
            if name.endswith('search'):
                query = {'q': args['q']}
            else:
                query = {'reverse': '1', 'lat': str(args['lat']), 'lon': str(args['lon'])}
        else:
            endpoint = '/api/geocode'
    method = 'GET' if endpoint in ('/api/browse', '/api/drives', '/api/probe', '/api/probe-source',
                                   '/api/probe_metadata', '/api/file_fs_time', '/api/settings',
                                   '/api/presets', '/api/codecs', '/api/diagnostic_report',
                                   '/api/version', '/api/sysmon', '/api/geocode', '/api/nominatim') else 'POST'
    ep = endpoint
    if '<id>' in ep:
        ep = ep.replace('<id>', str(args.get('id', '')))
    if '<index>' in ep:
        ep = ep.replace('<index>', str(args.get('index', '')))
    if '<name>' in ep:
        import urllib.parse as _up
        ep = ep.replace('<name>', _up.quote(str(args.get('name', '')), safe=''))
    if name == 'vc preset delete':
        method = 'DELETE'
    try:
        status, data = ctx['forward'](method, ep, json_body=body, query=query)
    except Exception as e:
        return envelope('ERR_BACKEND', error=_err('ERR_BACKEND', '内部转发异常: %s' % e, '重试一次，仍失败上报用户'), cmd=name)

    if status == 200:
        code = 'OK'
    elif status in (400,):
        code = 'ERR_VALIDATION'
    elif status in (404,):
        code = 'ERR_NOT_FOUND'
    elif status in (409,):
        code = 'ERR_JOB_ACTIVE'
    elif status in (500, 502, 504):
        code = 'ERR_FFMPEG' if 'ffprobe' in str(data).lower() or 'ffmpeg' in str(data).lower() else 'ERR_BACKEND'
    else:
        code = 'ERR_BACKEND'

    if code == 'OK':
        # 收敛 job_id 入幂等表
        jid = data.get('job_id') if isinstance(data, dict) else None
        if rid:
            _IDEMPOTENCY[rid] = {'data': {'job_id': jid, 'name': name}, 'ts': time.time()}
            while len(_IDEMPOTENCY) > _IDEM_MAX:
                _IDEMPOTENCY.pop(min(_IDEMPOTENCY, key=lambda k: _IDEMPOTENCY[k]['ts']), None)
        return envelope('OK', data=data, cmd=name, job_id=jid)
    return envelope(code, error=_err(code, str(data.get('error') if isinstance(data, dict) else data)[:300],
                                     _hint_for(code, data)), cmd=name)


def _hint_for(code, data):
    msg = str(data).lower()
    if code == 'ERR_JOB_ACTIVE':
        return '已有活动作业——用 vc job status 跟踪它，勿重复提交'
    if code == 'ERR_VALIDATION' and '未启用任何功能' in str(data):
        return 'apply-metadata 需至少启用一项（apply_date/apply_location/apply_spherical），在 params 里给出'
    if code == 'ERR_VALIDATION' and 'No files' in str(data):
        return 'items 不能为空——先 vc file scan 获取文件清单'
    if code in ('ERR_FFMPEG', 'ERR_BACKEND'):
        return '重试一次；仍失败把 message 上报用户并给出 设置→诊断 建议'
    return ''


def _map_payload(name, args):
    """命令参数 → 上游端点请求体。白名单映射：只透传下列显式声明的键。"""
    a = args
    if name == 'vc job start-convert':
        items = a['items']
        if not isinstance(items, list) or not all(isinstance(i, dict) for i in items):
            return (('ERR_VALIDATION', '--items 必须是对象数组', '形如 [{"input":"...","output":"..."}] 或 merge 用 [{"inputs":[...],"output":"..."}]'), None)
        body = {'mode': a.get('mode', 'batch' if len(items) > 1 else 'single'), 'items': items}
        if a.get('params'):
            body['params'] = a['params']
        # 原地覆盖检测（表E L3：output==input 拒绝）
        for it in items:
            ins = [it.get('input')] if 'input' in it else it.get('inputs', [])
            outp = it.get('output')
            if outp and any(o and isinstance(o, str) and o.replace('\\', '/').lower() == str(outp).replace('\\', '/').lower() for o in ins):
                return (('ERR_PERMISSION_READONLY', '检测到输出与输入同路径（原地覆盖），AI 助手拒绝', '改输出目录，或由用户手动操作'), None)
        return body, None
    if name == 'vc job start-vr3d':
        body = {'items': [{'left_input': a['left'], 'right_input': a['right'], 'output': a['output']}],
                'params': {'vr3d_layout': a.get('layout', 'top-bottom')}}
        return body, None
    if name == 'vc job apply-metadata':
        if not isinstance(a['items'], list) or not a['items']:
            return (('ERR_VALIDATION', '--items 必须是非空对象数组', '形如 [{"input":"...","output":"...","params":{...}}]，per-item params 至少启用一项：apply_date(需配 manual_date)/apply_location(需 lat+lon)/apply_spherical'), None)
        body = {'items': a['items']}
        if a.get('params'):
            body['params'] = a['params']
        # 提交前预检（对齐 v3.13.3 判据）：至少一项功能可产出，否则快速失败
        def _usable(p):
            if not isinstance(p, dict):
                return False
            if p.get('apply_date') and (p.get('manual_date') or p.get('date_from_filename')):
                return True
            if p.get('apply_location') and p.get('location_lat') is not None and p.get('location_lon') is not None:
                return True
            if p.get('apply_spherical'):
                return True
            return False
        top = a.get('params') or {}
        if not any(_usable(it.get('params') if isinstance(it, dict) else None) for it in a['items']) and not _usable(top):
            return (('ERR_VALIDATION', '启用项无产出（后端会报 No actionable metadata）',
                    'apply_date 需带 manual_date 或 date_from_filename=true；apply_location 需 location_lat+location_lon；apply_spherical 单独可用'), None)
        return body, None
    if name == 'vc file scan':
        return {'directory': a['dir'], 'recursive': a.get('recursive', True)}, None
    if name == 'vc file browse':
        return None, {'path': a.get('dir', ''), 'isDir': 'true', 'filter': 'video'}
    if name in ('vc probe file', 'vc probe source', 'vc probe metadata', 'vc probe fs-time'):
        return None, {'path': a['path']}
    if name == 'vc probe date':
        return {'filename': a['path']}, None
    if name == 'vc probe insv-pair':
        return {'path': a['path']}, None
    if name == 'vc probe vr3d-alignment':
        return {'left': a['left'], 'right': a['right']}, None
    if name == 'vc config set':
        if not isinstance(a['fields'], dict):
            return (('ERR_VALIDATION', '--fields 必须是 JSON 对象', '如 \'{"custom_ffmpeg_path":"D:/ff"}\''), None)
        return a['fields'], None
    if name == 'vc preset delete':
        return {}, None
    if name == 'vc config show':
        return None, None
    if name == 'vc config codec-check':
        return ({'encoders': [a['codec']]} if a.get('codec') else {}), None
    if name == 'vc config test-ffmpeg':
        return {'path': a.get('path', '')}, None
    if name == 'vc config test-encoder':
        return {'encoder': a['encoder'], 'ffmpeg_path': a.get('ffmpeg-path', '')}, None
    if name == 'vc preset save':
        if a.get('params') and not isinstance(a['params'], dict):
            return (('ERR_VALIDATION', '--params 必须是 JSON 对象', ''), None)
        return {'name': a['name'], 'params': a.get('params', {})}, None
    if name == 'vc task save':
        import os
        p = a['name']
        if not (os.path.isabs(p) and p.lower().endswith('.json')):
            return (('ERR_VALIDATION', '--name 需为绝对路径 .json 文件（如 G:/tasks/x.json）', '任务文件保存不支持相对名/默认覆盖'), None)
        return {'mode': 'batch', 'items': a.get('items', []), 'params': a.get('params', {}), 'path': p}, None
    if name == 'vc geo search':
        return None, {'q': a['q']}
    if name == 'vc geo reverse':
        return None, {'q': '__regeo__', 'location': '%s,%s' % (a['lon'], a['lat'])}
    if name == 'vc report generate':
        if not a.get('paths') and not a.get('directory'):
            return (('ERR_USAGE', '--paths 或 --directory 至少给一个', '形如 --paths \'["G:/a.mp4"]\' 或 --directory G:/264'), None)
        return ({'paths': a.get('paths', [])} if a.get('paths') else {'directory': a['directory'], 'recursive': a.get('recursive', True)}), None
    if name == 'vc report save':
        return {'path': a['path'], 'content': a['content']}, None
    if name.startswith('vc job add-items'):
        return {'items': a['items']}, None
    if name.startswith('vc job pause') or name.startswith('vc job resume') or name.startswith('vc job skip-item'):
        return {}, None
    return {}, None


def _task_path(name):
    import os
    return name if os.path.isabs(name) else None
