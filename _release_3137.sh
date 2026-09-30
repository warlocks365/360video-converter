#!/bin/sh
set -e
cd "G:/360video-converter/360video-converter"
fail() { echo "FAIL: $*"; exit 1; }
TOKEN=$(printf "protocol=https\nhost=github.com\n\n" | git credential fill 2>/dev/null | grep '^password=' | cut -d= -f2-)
[ -n "$TOKEN" ] || fail "no token"
export GH_PUSH_TOKEN="$TOKEN"
export GIT_TERMINAL_PROMPT=0
printf '#!/bin/sh\ncase "$1" in\n  Username*) echo "x-access-token" ;;\n  Password*) echo "$GH_PUSH_TOKEN" ;;\nesac\n' > _askpass_tmp.sh
chmod +x _askpass_tmp.sh
export GIT_ASKPASS="$(pwd)/_askpass_tmp.sh"
REPO_SLUG="warlocks365/360video-converter"
LOCAL_HEAD=$(git rev-parse HEAD)
LOCAL_HEAD12=$(echo "$LOCAL_HEAD" | cut -c1-12)
VER="3.13.7"
echo "local HEAD: $LOCAL_HEAD12"
echo "== push branch =="
git push origin v3.0.0-stabilization || fail "branch push failed"
echo "== push tag =="
if git rev-parse -q --verify "refs/tags/v$VER" > /dev/null; then
  echo "tag 已存在，跳过创建"
else
  git tag -a "v$VER" -m "360 Video Converter v$VER"
fi
git push origin "refs/tags/v$VER" || fail "tag push failed"
echo "== create release =="
python - "docs/releases/github_release_v$VER.md" > rel_payload.json <<'PYEOF'
import json, sys
md = open(sys.argv[1], encoding='utf-8').read()
title = next((l[2:].strip() for l in md.splitlines() if l.startswith('# ')), '360 Video Converter')
print(json.dumps({'tag_name': 'v' + '3.13.7', 'target_commitish': 'v3.0.0-stabilization',
                  'name': title, 'body': md, 'draft': False, 'prerelease': False},
                 ensure_ascii=False))
PYEOF
CREATE_RESP=$(curl -sS --retry 3 --retry-delay 2 -X POST \
  -H "Authorization: Bearer $GH_PUSH_TOKEN" \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  -d @rel_payload.json \
  "https://api.github.com/repos/$REPO_SLUG/releases")
REL_ID=$(echo "$CREATE_RESP" | python -c "import json,sys; print(json.load(sys.stdin).get('id',''))" 2>/dev/null)
HTML_URL=$(echo "$CREATE_RESP" | python -c "import json,sys; print(json.load(sys.stdin).get('html_url',''))" 2>/dev/null)
[ -n "$REL_ID" ] || fail "create release: $(echo "$CREATE_RESP" | head -c 300)"
echo "release id=$REL_ID"
echo "== upload asset =="
curl -sS --retry 3 --retry-delay 2 -X POST \
  -H "Authorization: Bearer $GH_PUSH_TOKEN" \
  -H "Content-Type: application/octet-stream" \
  --data-binary @"installer_output/360VideoConverter_Setup_v$VER.exe" \
  "https://uploads.github.com/repos/$REPO_SLUG/releases/$REL_ID/assets?name=360VideoConverter_Setup_v$VER.exe" \
  > rel_up.json
python -c "import json; d=json.load(open('rel_up.json')); print('asset:', d.get('name'), d.get('state'), round(d.get('size',0)/1048576,1), 'MB')"
echo "== SHA-level verify =="
TSHA=$(curl -sS -m 30 -H "Authorization: Bearer $GH_PUSH_TOKEN" "https://api.github.com/repos/$REPO_SLUG/git/ref/tags/v$VER" | python -c "import json,sys; print(json.load(sys.stdin)['object']['sha'])")
TC=$(curl -sS -m 30 -H "Authorization: Bearer $GH_PUSH_TOKEN" "https://api.github.com/repos/$REPO_SLUG/git/tags/$TSHA" | python -c "import json,sys; print(json.load(sys.stdin)['object']['sha'][:12])")
RB=$(curl -sS -m 30 -H "Authorization: Bearer $GH_PUSH_TOKEN" "https://api.github.com/repos/$REPO_SLUG/branches/v3.0.0-stabilization" | python -c "import json,sys; print(json.load(sys.stdin)['commit']['sha'][:12])")
echo "remote branch: $RB | remote tag->commit: $TC | local: $LOCAL_HEAD12"
[ "$RB" = "$LOCAL_HEAD12" ] || fail "branch SHA mismatch"
[ "$TC" = "$LOCAL_HEAD12" ] || fail "tag SHA mismatch"
rm -f rel_payload.json rel_up.json
echo "RELEASE-OK: $HTML_URL"
