# v3.15.0 CLI 冒烟：test_client 级真实链路（含确认流与真实作业）
import os, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import app, json, time
c = app.app.test_client()
def post(url, b): return c.post(url, json=b)
t=0; f=0
def ck(n,cond,d=''):
    global t,f; t+=1
    if not cond: f+=1; print('FAIL',n,d)
    else: print('OK  ',n)

r = post('/api/cli', {'cmdline':'vc help','source':'agent-cli'})
ck('help 200', r.status_code==200 and 'vc job start-convert' in r.get_json()['data']['manual'])
r = post('/api/cli', {'cmdline':'vc config set --fields \'{"x":1}\'','source':'agent-cli'})
ck('forbidden 403', r.status_code==403 and r.get_json()['code']=='ERR_FORBIDDEN')
r = post('/api/cli', {'cmdline':'vc sys version','source':'agent-cli'})
ck('sys version real', r.status_code==200 and r.get_json()['data'].get('version')=='3.14.3', json.dumps(r.get_json())[:140])
r = post('/api/cli', {'cmdline':'vc probe file --path G:/264/_acceptance_v3132/out_t1.mp4','source':'agent-cli'})
j=r.get_json(); ck('probe real', j['ok'] and (j['data'].get('format') or j['data'].get('streams')), json.dumps(j)[:140])
r = post('/api/cli', {'cmdline':'vc file scan --dir G:/264/_acceptance_v3132','source':'agent-cli'})
j=r.get_json(); ck('scan real', j['ok'] and j['data']['count']>0, json.dumps(j)[:120])

# 真作业走确认流（standard 档）
c.post('/api/settings', json={'agent_permission':'standard'})
cmdline = ("vc job apply-metadata --items "
 "'[{\"input\":\"G:/264/_acceptance_v3132/clean_src5s.mp4\","
 "\"output\":\"G:/264/_acceptance_v3132/cli_meta_out.mp4\","
 "\"params\":{\"apply_date\":true,\"manual_date\":\"2026-01-01T00:00:00\"}}]'")
r = post('/api/cli', {'cmdline': cmdline, 'source':'agent-cli'})
j = r.get_json()
ck('pending confirm 202', r.status_code==202 and j['code']=='ERR_PENDING_CONFIRM', json.dumps(j, ensure_ascii=False)[:200])
tok = j['meta']['confirm_token']
r = post('/api/cli', {'cmdline':'vc cli-confirm --token '+tok,'source':'agent-cli'})
ck('confirm still pending', r.get_json()['data']['state']=='pending')
r = post('/api/cli_confirm', {'token':tok,'approve':True})
j=r.get_json(); ck('approved executed job', j['ok'] and j['data'].get('job_id'), json.dumps(j)[:200])
jid = j['data']['job_id']
for _ in range(12):
    time.sleep(1)
    r = post('/api/cli', {'cmdline':'vc job status --id %s --since-seq 0'%jid,'source':'agent-cli'})
    j=r.get_json()
    if j['ok'] and j['data']['finished']: break
ck('job terminal', j['ok'] and j['data']['status'] in ('completed','failed'), json.dumps(j, ensure_ascii=False)[:300])
seq1=j['data']['seq']
r = post('/api/cli', {'cmdline':'vc job status --id %s --since-seq %d'%(jid,seq1),'source':'agent-cli'})
j2=r.get_json(); ck('increment cursor no-repeat', j2['ok'] and len(j2['data']['log']['lines'])==0, json.dumps(j2['data']['log'])[:120])
p='G:/264/_acceptance_v3132/cli_meta_out.mp4'
ck('output file exists', os.path.isfile(p))
if os.path.isfile(p):
    fp = os.popen(r'G:/360video-converter/360video-converter/ffmpeg-static/ffprobe.exe -v error -show_entries format_tags -of json "%s"' % p).read()
    # 既定语义（v3.13.4 场景4）：manual_date 按本地 naive 解析，tag 写其对应 UTC 时刻
    # （本地 2026-01-01 00:00 @UTC+8 → tag 2025-12-31T16:00Z）。动态算期望，时区无关：
    from datetime import datetime, timezone
    expected = datetime(2026, 1, 1, 0, 0, 0).astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M')
    ck('creation_time written', '"creation_time"' in fp and expected in fp, fp[:200])
    os.remove(p)

# 幂等真链路
c.post('/api/settings', json={'agent_permission':'full'})
cmd2 = ("vc job apply-metadata --request-id ' + str(int(time.time())) + ' --items "
 "'[{\"input\":\"G:/264/_acceptance_v3132/clean_src5s.mp4\","
 "\"output\":\"G:/264/_acceptance_v3132/cli_idem_out.mp4\","
 "\"params\":{\"apply_date\":true,\"manual_date\":\"2026-02-02T00:00:00\"}}]'")
r1 = post('/api/cli', {'cmdline':cmd2,'source':'agent-cli'})
r2 = post('/api/cli', {'cmdline':cmd2,'source':'agent-cli'})
j1=r1.get_json(); j2=r2.get_json()
ck('idem first OK', j1['ok'], json.dumps(j1)[:160])
ck('idem second IDMPOTENT', j2['code']=='OK_IDEMPOTENT', json.dumps(j2)[:160])
if j1['data'].get('job_id'):
    time.sleep(3)
    c.post('/api/cancel/%s' % j1['data']['job_id'])  # GUI 直连端点清理（cancel 不暴露给 agent）
for f_ in ('cli_idem_out.mp4',):
    pp='G:/264/_acceptance_v3132/'+f_
    if os.path.isfile(pp): os.remove(pp)

print(f'\napp 冒烟: {t-f}/{t} PASS')
raise SystemExit(0 if f==0 else 1)
