package theme

import (
	"testing"

	"github.com/charmbracelet/lipgloss"
)

func TestAvatarArtDrawsAndBlinks(t *testing.T) {
	for slot := 0; slot < 6; slot++ {
		big := AvatarLines(slot, false, true, lipgloss.Color("#000000"))
		if len(big) != 9 || lipgloss.Width(big[0]) != 18 {
			t.Fatalf("slot %d: big art is %d lines × %d cells, want 9 × 18", slot, len(big), lipgloss.Width(big[0]))
		}
		small := AvatarLines(slot, false, false, lipgloss.Color("#000000"))
		if len(small) != 6 || lipgloss.Width(small[0]) != 12 {
			t.Fatalf("slot %d: small art is %d × %d, want 6 × 12", slot, len(small), lipgloss.Width(small[0]))
		}
		// Every avatar but the laughing one (slot 3, eyes already shut) looks different blinking,
		// at both sizes.
		if differs := AvatarArtBig[slot][0] != AvatarArtBig[slot][1]; differs != (slot != 3) {
			t.Fatalf("slot %d: big blink frame differs=%v", slot, differs)
		}
		if differs := AvatarArtSmall[slot][0] != AvatarArtSmall[slot][1]; differs != (slot != 3) {
			t.Fatalf("slot %d: small blink frame differs=%v", slot, differs)
		}
	}
	// One silhouette: every avatar covers exactly the same cells, at both sizes.
	for slot := 1; slot < 6; slot++ {
		for y := 0; y < 18; y++ {
			for x := 0; x < 18; x++ {
				if (AvatarArtBig[slot][0][y][x] == "") != (AvatarArtBig[0][0][y][x] == "") {
					t.Fatalf("slot %d's 18px silhouette differs at %d,%d", slot, x, y)
				}
			}
		}
		for y := 0; y < 12; y++ {
			for x := 0; x < 12; x++ {
				if (AvatarArtSmall[slot][0][y][x] == "") != (AvatarArtSmall[0][0][y][x] == "") {
					t.Fatalf("slot %d's 12px silhouette differs at %d,%d", slot, x, y)
				}
			}
		}
	}
	// One 160ms blink per 5.2s, slots offset from one another.
	if !Blinking(0, 0) || Blinking(0, 200) || Blinking(1, 0) {
		t.Fatal("blink schedule is off")
	}
	if d := NextBlinkChangeMs(1, 0); d != BlinkLengthMs {
		t.Fatalf("next change from the start of a blink should be its end, got %d", d)
	}
	if d := NextBlinkChangeMs(6, 200); d <= 0 || d > BlinkPeriodMs {
		t.Fatalf("next change out of range: %d", d)
	}
}
