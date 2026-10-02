#!/bin/zsh
# Boot a core (fake model) in a temp project and run the live TUI test against it.
NITI=${0:A:h:h:h}; SP=${0:A:h}
LLM=$((49100 + RANDOM % 300)); P=$(mktemp -d); P=${P:A}; S=$(mktemp -d)
export NITI_AUTH_FILE=$S/auth.json NITI_TRUST_FILE=$S/trust.json NITI_TRUST=1
bun $SP/fakellm.ts $LLM $S >/dev/null 2>&1 & LPID=$!
mkdir -p $P/.niti $P/src; echo 'export const a = 1;' > $P/src/a.ts
for id in backend frontend; do
  [[ $id == backend ]] && lead="    lead: true" || lead=""
  printf '  - id: %s\n    provider: custom\n    model: fake\n    role: %s\n    baseURL: http://127.0.0.1:%s/v1\n    systemPrompt: s\n%s\n    allowedTools: [read_file, write_file]\n' $id $id $LLM "$lead"
done | { echo "agents:"; cat; echo "verify: false"; } > $P/.niti/agents.yaml
sleep 0.5
cd $P && { bun run $NITI/src/cli.ts serve > $S/hs.txt 2> $S/core.log & CPID=$!; }; cd - >/dev/null
trap "kill $CPID $LPID 2>/dev/null" EXIT
for i in {1..50}; do [[ -s $S/hs.txt ]] && break; sleep 0.1; done
export NITI_E2E_URL=$(sed -E 's/.*"url":"([^"]+)".*/\1/' $S/hs.txt) NITI_E2E_TOKEN=$(sed -E 's/.*"token":"([^"]+)".*/\1/' $S/hs.txt)
(cd $NITI/tui && go test -count=1 -run TestLiveTUI ./internal/session/ -v 2>&1 | tail -40; exit ${pipestatus[1]})
code=$?
echo "project $P  logs $S"
exit $code
