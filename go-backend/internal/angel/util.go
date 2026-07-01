package angel

import (
	"encoding/json"
	"math"
	"sort"
	"strconv"
	"time"
)

// parseExpiryMs parses Angel's "DDMMMYYYY" expiry (e.g. "31JUL2026") into a
// Unix-millis timestamp for chronological sorting. Unknown formats sort last.
func parseExpiryMs(expiry string) int64 {
	t, err := time.Parse("02Jan2006", titleMonth(expiry))
	if err != nil {
		return 1<<62 - 1 // push unparseable expiries to the end
	}
	return t.UnixMilli()
}

// titleMonth lowercases the month letters so Go's "02Jan2006" layout matches
// Angel's uppercase "31JUL2026" (day/year digits are unaffected).
func titleMonth(s string) string {
	b := []byte(s)
	for i := range b {
		if b[i] >= 'A' && b[i] <= 'Z' && i >= 2 {
			// keep first letter of month uppercase, lower the rest
			if i > 2 {
				b[i] = b[i] - 'A' + 'a'
			}
		}
	}
	return string(b)
}

// mapData returns the "data" object of a SmartAPI envelope as a map (or empty).
func mapData(m map[string]any) map[string]any {
	if d, ok := m["data"].(map[string]any); ok {
		return d
	}
	return map[string]any{}
}

// strOr coerces v to string, or returns fallback when nil/not a string.
func strOr(v any, fallback string) string {
	switch t := v.(type) {
	case string:
		if t != "" {
			return t
		}
	case float64:
		return strconv.FormatFloat(t, 'f', -1, 64)
	case json.Number:
		return t.String()
	}
	return fallback
}

// toFloat coerces JSON scalars (float64, string, json.Number) to float64.
func toFloat(v any) float64 {
	switch t := v.(type) {
	case float64:
		return t
	case json.Number:
		f, _ := t.Float64()
		return f
	case string:
		f, _ := strconv.ParseFloat(t, 64)
		return f
	}
	return 0
}

// normalizeStrike converts Angel's scaled master strike to a whole-rupee strike.
// MCX commodity strikes are consistently ×100, so always ÷100. NSE/BSE index
// option strikes only over-scale on some rows (>200000), so divide only then —
// otherwise the raw value is already the real strike. (Mirrors the Node server;
// getting this wrong made commodity strikes come out 100× too large.)
func normalizeStrike(raw float64, exchange string) int {
	if exchange == "MCX" {
		return int(math.Trunc(raw / 100))
	}
	if raw > 200000 {
		return int(math.Trunc(raw / 100))
	}
	return int(math.Trunc(raw))
}

// ── small numeric / map helpers ─────────────────────────────────────────────

func round2(v float64) float64 { return math.Round(v*100) / 100 }

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

func clampInt(v, lo, hi int) int { return maxInt(lo, minInt(hi, v)) }
func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func indexOf(s []int, want int) int {
	for i, v := range s {
		if v == want {
			return i
		}
	}
	return -1
}

func nilIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// chunkTokens splits a token slice into batches of at most size, so a bulk quote
// stays under Angel's per-request token cap (~50).
func chunkTokens(tokens []string, size int) [][]string {
	if size < 1 {
		size = 50
	}
	var chunks [][]string
	for i := 0; i < len(tokens); i += size {
		end := i + size
		if end > len(tokens) {
			end = len(tokens)
		}
		chunks = append(chunks, tokens[i:end])
	}
	return chunks
}

// unionStrikes returns the sorted union of CE and PE strike keys.
func unionStrikes[T any](ce, pe map[int]T) []int {
	set := map[int]bool{}
	for k := range ce {
		set[k] = true
	}
	for k := range pe {
		set[k] = true
	}
	out := make([]int, 0, len(set))
	for k := range set {
		out = append(out, k)
	}
	sort.Ints(out)
	return out
}

// firstFetchedLTP reads data.fetched[0].ltp from a quote envelope.
func firstFetchedLTP(res map[string]any) float64 {
	list := fetchedList(res)
	if len(list) == 0 {
		return 0
	}
	return toFloat(list[0]["ltp"])
}

// fetchedList extracts data.fetched[] as []map.
func fetchedList(res map[string]any) []map[string]any {
	data, _ := res["data"].(map[string]any)
	if data == nil {
		return nil
	}
	raw, _ := data["fetched"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// fetchedGreeks extracts data[] (a plain array) from the optionGreek envelope.
func fetchedGreeks(res map[string]any) []map[string]any {
	raw, _ := res["data"].([]any)
	out := make([]map[string]any, 0, len(raw))
	for _, item := range raw {
		if m, ok := item.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

// firstNonZero returns the first non-zero numeric field among keys.
func firstNonZero(m map[string]any, keys ...string) float64 {
	for _, k := range keys {
		if v, ok := m[k]; ok {
			if f := toFloat(v); f != 0 {
				return f
			}
		}
	}
	return 0
}

// withoutSession clones creds with the session dropped (forces a fresh login).
func withoutSession(cc ClientCreds) ClientCreds {
	cc.Session = nil
	return cc
}

// sessionFromResponse pulls the *Session out of an AutoLogin response map.
func sessionFromResponse(res map[string]any) *Session {
	if s, ok := res["session"].(*Session); ok {
		return s
	}
	return nil
}
