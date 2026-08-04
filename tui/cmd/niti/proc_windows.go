//go:build windows

package main

import (
	"os/exec"
	"strconv"
)

// Windows has no process groups in the POSIX sense and no SIGTERM. taskkill /T walks the process
// tree, which is the closest equivalent to signalling a group; /F is the SIGKILL analogue.
func setProcessGroup(cmd *exec.Cmd) {}

func terminateGroup(pid int) { _ = exec.Command("taskkill", "/T", "/PID", strconv.Itoa(pid)).Run() }
func killGroup(pid int)      { _ = exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(pid)).Run() }
