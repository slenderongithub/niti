#!/bin/zsh
# Headless CLI checks against the fake model. Usage: zsh scripts/e2e/cli.sh
NITI=${0:A:h:h:h}
SP=${0:A:h}
LLM=$((48600 + RANDOM % 300))
P=$(mktemp -d); P=${P:A}; S=$(mktemp -d)
export NITI_AUTH_FILE=$S/auth.json NITI_TRUST_FILE=$S/trust.json
bun $SP/fakellm.ts $LLM $S >/dev/null 2>&1 &
LPID=$!
sleep 0.6
mkdir -p $P/.niti
cat > $P/.niti/agents.yaml <<Y
agents:
  - id: backend
    provider: custom
    model: fake
    role: backend
    baseURL: http://127.0.0.1:$LLM/v1
    systemPrompt: You build.
    lead: true
    allowedTools: [read_file, write_file, shell]
  - id: frontend
    provider: custom
    model: fake
    role: frontend
    baseURL: http://127.0.0.1:$LLM/v1
    systemPrompt: You build.
    allowedTools: [read_file, write_file, shell]
verify: false
Y
pass=0; fail=0
trap "kill $LPID 2>/dev/null" EXIT
ck(){ if eval "$2"; then pass=$((pass+1)); echo "PASS  $1"; else fail=$((fail+1)); echo "FAIL  $1"; fi; }
core(){ (cd $P && bun run $NITI/src/cli.ts "$@") }

ck "--version" '[[ $(core --version) == $(grep "\"version\"" $NITI/package.json | sed -E "s/.*\"([0-9.]+)\".*/\1/") ]]'
ck "--help" 'core --help | grep -q "niti-core"'
ck "unknown flag rejected" '! core --bogus >/dev/null 2>&1'
ck "typo subcommand rejected (no billed run)" '! core stauts >/dev/null 2>&1'
ck "untrusted dir refuses without a TTY" '! core "build it" </dev/null >/dev/null 2>&1'
ck "trust check says untrusted" '! core trust check >/dev/null'
ck "trust grant" 'core trust grant | grep -q trusted'
ck "trust check now trusted" 'core trust check >/dev/null'
ck "auth list empty" 'core auth list | grep -q "No credentials"'
out=$(core "build a reddit replica page" 2>&1); code=$?
ck "headless run without --auto denies writes (exit 1 or 2)" '[[ $code -ne 0 && ! -e $P/index.html ]]'
out=$(core --auto "build a reddit replica page" 2>&1); code=$?
ck "headless --auto run succeeds (exit 0)" '[[ $code -eq 0 ]]' || echo "$out" | tail -15
ck "headless --auto wrote files" '[[ -e $P/index.html && -e $P/style.css ]]'
ck "audit verify ok" 'core audit verify | grep -q "chain intact"'
ck "resume with nothing left exits 0" 'core resume >/dev/null 2>&1'
cd $P && git init -q . && git -c user.email=t@t -c user.name=t add -A >/dev/null && git -c user.email=t@t -c user.name=t commit -qm init && cd - >/dev/null
rm -f $P/index.html $P/style.css; git -C $P -c user.email=t@t -c user.name=t commit -qam rm
out=$(core --auto --worktree "build a reddit replica page" 2>&1); code=$?
ck "worktree run leaves the real tree untouched" '[[ ! -e $P/index.html ]]'
ck "worktree run wrote into .niti/worktrees" '[[ -n $(ls $P/.niti/worktrees/*/index.html 2>/dev/null) ]]' || echo "$out" | tail -8
kill $LPID 2>/dev/null
echo "\n$pass passed, $fail failed  (project $P)"
exit $(( fail > 0 ))
