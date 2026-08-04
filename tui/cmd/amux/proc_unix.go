//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

// Put the core in its own process group so a signal reaches the language servers and MCP servers
// it spawned, not just the core itself.
func setProcessGroup(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

// Negative pid = "the whole group". Errors are ignored on purpose: the usual one is ESRCH, meaning
// it already exited, which is the outcome we wanted.
func terminateGroup(pid int) { _ = syscall.Kill(-pid, syscall.SIGTERM) }
func killGroup(pid int)      { _ = syscall.Kill(-pid, syscall.SIGKILL) }
