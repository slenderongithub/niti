package session

import (
	"fmt"
	"os/exec"
	"runtime"
)

// openBrowser launches the OS default browser at url. The interactive graph is a web page served by
// the amux core; the terminal only needs to point a browser at it. Fire-and-forget from the caller's
// side — any launch error is surfaced through the usual actionResultMsg status line.
func openBrowser(url string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("cmd", "/c", "start", "", url)
	default: // linux, *bsd, …
		cmd = exec.Command("xdg-open", url)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("could not open a browser (%s): %w", runtime.GOOS, err)
	}
	// Reap the launcher so it doesn't linger as a zombie; the browser it spawns is detached.
	go func() { _ = cmd.Wait() }()
	return nil
}
