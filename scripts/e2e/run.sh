#!/bin/zsh
# The full end-to-end check of the CLI product against a scripted fake model (no network, no cost):
# unit suites, the core server and every slash command, the headless CLI, the TUI model against a
# live core, and the compiled binaries in a real terminal. Exit 0 only if everything passed.
#   zsh scripts/e2e/run.sh
set -u
E2E=${0:A:h}; NITI=${E2E:h:h}
BIN=$(mktemp -d)/bin; mkdir -p $BIN
fail=0
step(){ print -P "\n%B== $1%b"; shift; "$@" || fail=1; }
step "typecheck" bun run --cwd $NITI typecheck
step "core unit tests" bun test --cwd $NITI ./src ./web
step "tui unit tests" zsh -c "cd $NITI/tui && go vet ./... && go test ./..."
step "build binaries" zsh -c "cd $NITI/tui && go build -o $BIN/niti ./cmd/niti && cd $NITI && bun build --compile src/cli.ts --outfile $BIN/niti-core >/dev/null"
step "core server + slash commands" bun $E2E/server.ts
step "headless cli" zsh $E2E/cli.sh
step "tui against a live core" zsh $E2E/tui.sh
step "real terminal" env NITI_E2E_BIN=$BIN python3 $E2E/terminal.py
pkill -f "$BIN/niti-core serve" 2>/dev/null
print -P "\n%B$([[ $fail == 0 ]] && echo 'ALL PASSED' || echo 'FAILURES ABOVE')%b"
exit $fail
