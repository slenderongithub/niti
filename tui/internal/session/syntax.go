package session

import (
	"path/filepath"
	"strings"
	"unicode"
)

// Syntax color for diff rows and the file viewer: keywords, strings, numbers and comments, by file
// extension. ponytail: a line-at-a-time lexer, not a parser — a block comment or string that spans
// lines is only colored on the line where it starts. Add a real highlighter (e.g. chroma) if that
// ever matters more than the dependency.

const (
	mkSynKw  = ''
	mkSynStr = ''
	mkSynNum = ''
	mkSynCom = ''
	mkSynEnd = ''
)

type lang struct {
	line  []string // line-comment openers
	block bool     // /* … */
	quote string   // string delimiters
}

var (
	cLike  = lang{line: []string{"//"}, block: true, quote: "\"'`"}
	hashy  = lang{line: []string{"#"}, quote: "\"'"}
	sqlish = lang{line: []string{"--"}, quote: "'\""}
	langs  = map[string]lang{
		".go": cLike, ".ts": cLike, ".tsx": cLike, ".js": cLike, ".jsx": cLike, ".mjs": cLike, ".cjs": cLike,
		".rs": cLike, ".java": cLike, ".kt": cLike, ".swift": cLike, ".c": cLike, ".h": cLike, ".cc": cLike,
		".cpp": cLike, ".hpp": cLike, ".cs": cLike, ".scala": cLike, ".dart": cLike, ".php": cLike, ".css": cLike,
		".scss": cLike, ".json": cLike, ".py": hashy, ".rb": hashy, ".sh": hashy, ".bash": hashy, ".zsh": hashy,
		".yaml": hashy, ".yml": hashy, ".toml": hashy, ".r": hashy, ".ex": hashy, ".exs": hashy,
		".sql": sqlish, ".lua": sqlish,
	}
	keywords = setOf("func function const let var return if else elif for while do switch case default break " +
		"continue import export from package type interface struct class def async await new try catch finally " +
		"throw throws raise except nil null None true false True False undefined self this super public private " +
		"protected static void in of as with yield lambda pass fn impl pub use mod match enum trait mut defer go " +
		"chan select range map extends implements readonly declare namespace module require end then local not and or is")
)

func setOf(words string) map[string]bool {
	m := map[string]bool{}
	for _, w := range strings.Fields(words) {
		m[w] = true
	}
	return m
}

// highlight wraps the syntax tokens of one line in span markers for renderLine. Marker runes
// already in the line (the changed-words highlight) pass through untouched.
func highlight(line, path string) string {
	l, ok := langs[strings.ToLower(filepath.Ext(path))]
	if !ok {
		return line
	}
	r := []rune(line)
	var b strings.Builder
	span := func(kind rune, from, to int) {
		b.WriteRune(kind)
		b.WriteString(string(r[from:to]))
		b.WriteRune(mkSynEnd)
	}
	isMarker := func(c rune) bool { return c >= '' && c <= '' }
	at := func(i int, s string) bool { return strings.HasPrefix(string(r[i:min(i+len([]rune(s)), len(r))]), s) }
	for i := 0; i < len(r); {
		c := r[i]
		switch {
		case isMarker(c):
			b.WriteRune(c)
			i++
		case l.block && at(i, "/*"):
			end := strings.Index(string(r[i+2:]), "*/")
			j := len(r)
			if end >= 0 {
				j = i + 2 + len([]rune(string(r[i+2:])[:end])) + 2
			}
			span(mkSynCom, i, j)
			i = j
		case anyPrefix(r, i, l.line):
			span(mkSynCom, i, len(r))
			i = len(r)
		case strings.ContainsRune(l.quote, c):
			j := i + 1
			for j < len(r) && r[j] != c {
				if r[j] == '\\' {
					j++
				}
				j++
			}
			j = min(j+1, len(r))
			span(mkSynStr, i, j)
			i = j
		case unicode.IsDigit(c) && (i == 0 || !isWord(r[i-1])):
			j := i
			for j < len(r) && (isWord(r[j]) || r[j] == '.') {
				j++
			}
			span(mkSynNum, i, j)
			i = j
		case isWord(c) && (i == 0 || !isWord(r[i-1])):
			j := i
			for j < len(r) && isWord(r[j]) {
				j++
			}
			if keywords[string(r[i:j])] {
				span(mkSynKw, i, j)
			} else {
				b.WriteString(string(r[i:j]))
			}
			i = j
		default:
			b.WriteRune(c)
			i++
		}
	}
	return b.String()
}

func anyPrefix(r []rune, i int, prefixes []string) bool {
	for _, p := range prefixes {
		if strings.HasPrefix(string(r[i:]), p) {
			return true
		}
	}
	return false
}

func isWord(c rune) bool { return c == '_' || unicode.IsLetter(c) || unicode.IsDigit(c) }
