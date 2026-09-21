package session

import "strings"

// diffLines turns the core's snippet (`@@ path:14-22`, then `-`/`+`/` ` lines) into feed lines whose
// leading marker lineStyle colors: red removals, green additions, dim header and context.
func diffLines(diff string) []string {
	if diff == "" {
		return nil
	}
	var out []string
	for _, l := range strings.Split(diff, "\n") {
		switch {
		case strings.HasPrefix(l, "@@ "):
			out = append(out, "  ╭ "+l[3:])
		case strings.HasPrefix(l, "-"):
			out = append(out, "  - "+l[1:])
		case strings.HasPrefix(l, "+"):
			out = append(out, "  + "+l[1:])
		case strings.HasPrefix(l, " "):
			out = append(out, "  │ "+l[1:])
		}
	}
	return out
}
