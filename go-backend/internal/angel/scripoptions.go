package angel

import (
	"context"
	"fmt"
	"regexp"
	"sort"
	"strings"
	"time"
)

// masterExpiryRe matches the master's "DDMMMYYYY" expiry form, e.g. "07JUL2026".
var masterExpiryRe = regexp.MustCompile(`^\d{2}[A-Z]{3}\d{4}$`)

// This mirrors Angel's internal `scripmaster/v2/all-scrip-options` endpoint, but
// served from OUR in-memory scrip master — no Angel round-trip. Angel's version
// is fast because it does exactly this server-side: take (TradeSymbol, ExpiryDate,
// MarketSegmentId), filter the instrument master to that symbol+expiry+segment,
// and return every option scrip sorted by strike (with CE/PE paired). We already
// hold the whole master in memory, so this is a pure lookup — sub-millisecond.
//
// Angel's params → our master fields:
//   TradeSymbol     → ScripRow.Name    (underlying, e.g. "NIFTY")
//   ExpiryDate      → ScripRow.Expiry  (they send ISO "2026-07-07"; master is
//                     "07JUL2026" — we accept either)
//   MarketSegmentId → ScripRow.Segment (1=NSE→NFO, 3=BSE→BFO, 5=MCX)

// segmentByMarketId maps Angel's MarketSegmentId to our F&O segment code.
var segmentByMarketId = map[string]string{
	"1": "NFO", // NSE derivatives
	"2": "NFO",
	"3": "BFO", // BSE derivatives
	"5": "MCX", // commodities
}

// ScripOption is one option contract row, carrying just the master-derived
// fields (no live price — quotes/greeks come from separate calls, exactly like
// Angel splits all-scrip-options and greeks).
type ScripOption struct {
	Token         string  `json:"token"`
	TradingSymbol string  `json:"tradingSymbol"`
	Strike        int     `json:"strike"`
	OptionType    string  `json:"optionType"` // CE | PE
	LotSize       int     `json:"lotSize"`
	Expiry        string  `json:"expiry"`
	Exchange      string  `json:"exchange"`
}

// ScripOptionsReq mirrors Angel's query params.
type ScripOptionsReq struct {
	TradeSymbol     string // underlying, e.g. NIFTY
	ExpiryDate      string // "2026-07-07" or "07JUL2026"
	MarketSegmentId string // "1" | "3" | "5" (optional; inferred from symbol if blank)
}

// AllScripOptions returns every option scrip for (symbol, expiry, segment) from
// the master, sorted by strike then CE before PE. The response groups the
// strikes with aligned CE/PE arrays so the frontend can render a chain directly.
func (m *MasterStore) AllScripOptions(ctx context.Context, req ScripOptionsReq) (map[string]any, error) {
	symbol := strings.ToUpper(strings.TrimSpace(req.TradeSymbol))
	if symbol == "" {
		return nil, fmt.Errorf("TradeSymbol is required")
	}
	expiry, err := normalizeExpiry(req.ExpiryDate)
	if err != nil {
		return nil, err
	}

	// Segment: honor MarketSegmentId if given, else infer from the symbol (SENSEX
	// → BFO, commodities → MCX, else NFO) so callers can omit it.
	segment := segmentByMarketId[strings.TrimSpace(req.MarketSegmentId)]
	if segment == "" {
		segment = segmentFor(symbol)
	}

	rows, err := m.Data(ctx)
	if err != nil {
		return nil, err
	}

	// Filter the master to this symbol+expiry+segment, splitting CE/PE. Sorting
	// happens once at the end (on the strike union), so the scan is O(n).
	type contract struct {
		token, tradingSymbol string
		lotSize              int
	}
	ce := map[int]contract{}
	pe := map[int]contract{}
	lotSize := 1
	for i := range rows {
		r := &rows[i]
		if r.Name != symbol || r.Segment != segment || r.Expiry != expiry {
			continue
		}
		strike := normalizeStrike(r.Strike, segment)
		lot := r.LotSize
		if lot <= 0 {
			lot = 1
		}
		lotSize = lot
		switch {
		case strings.HasSuffix(r.Symbol, "CE"):
			ce[strike] = contract{r.Token, r.Symbol, lot}
		case strings.HasSuffix(r.Symbol, "PE"):
			pe[strike] = contract{r.Token, r.Symbol, lot}
		}
	}

	if len(ce) == 0 && len(pe) == 0 {
		return nil, fmt.Errorf("No option scrips for %s %s (%s)", symbol, expiry, segment)
	}

	// Sorted strike union — the master isn't stored strike-sorted, so we sort the
	// distinct strikes once (this is how Angel's response reads in strike order).
	strikes := unionStrikes(ce, pe)

	// Aligned arrays (one entry per strike) + a flat scrips list. The aligned
	// form is what a chain UI wants; the flat list mirrors Angel's raw payload.
	// liveTokens is every CE/PE token, so the browser can subscribe the whole
	// ladder to the live feed straight from this one response.
	callTokens := make([]any, len(strikes))
	putTokens := make([]any, len(strikes))
	callSymbols := make([]any, len(strikes))
	putSymbols := make([]any, len(strikes))
	scrips := make([]ScripOption, 0, len(ce)+len(pe))
	liveTokens := make([]string, 0, len(ce)+len(pe))
	exchange := segment
	for i, s := range strikes {
		if c, ok := ce[s]; ok {
			callTokens[i] = c.token
			callSymbols[i] = c.tradingSymbol
			liveTokens = append(liveTokens, c.token)
			scrips = append(scrips, ScripOption{c.token, c.tradingSymbol, s, "CE", c.lotSize, expiry, exchange})
		}
		if p, ok := pe[s]; ok {
			putTokens[i] = p.token
			putSymbols[i] = p.tradingSymbol
			liveTokens = append(liveTokens, p.token)
			scrips = append(scrips, ScripOption{p.token, p.tradingSymbol, s, "PE", p.lotSize, expiry, exchange})
		}
	}

	// Spot source (index LTP token for NSE/BSE) so the caller can fetch a spot.
	spotExchange, spotToken := "", ""
	if pair, ok := spotTokens[symbol]; ok {
		spotExchange, spotToken = pair[0], pair[1]
	}
	// Flat list sorted by strike then CE before PE (stable, Angel-like order).
	sort.SliceStable(scrips, func(i, j int) bool {
		if scrips[i].Strike != scrips[j].Strike {
			return scrips[i].Strike < scrips[j].Strike
		}
		return scrips[i].OptionType < scrips[j].OptionType // CE < PE
	})

	return map[string]any{
		"status":       true,
		"symbol":       symbol,
		"expiry":       expiry,
		"exchange":     exchange,
		"segment":      segment,
		"lotSize":      lotSize,
		"strikes":      strikes,
		"callTokens":   callTokens,
		"putTokens":    putTokens,
		"callSymbols":  callSymbols,
		"putSymbols":   putSymbols,
		"liveTokens":   liveTokens, // every CE/PE token for the live feed
		"spotToken":    nilIfEmpty(spotToken),
		"spotExchange": nilIfEmpty(spotExchange),
		"scrips":       scrips, // flat, strike-sorted list of every CE/PE contract
		"count":        len(scrips),
	}, nil
}

// normalizeExpiry accepts either Angel's ISO date ("2026-07-07") or the master's
// "07JUL2026" form and returns the master form (uppercase "DDMMMYYYY").
func normalizeExpiry(value string) (string, error) {
	v := strings.ToUpper(strings.TrimSpace(value))
	if v == "" {
		return "", fmt.Errorf("ExpiryDate is required")
	}
	// Already in master form?
	if masterExpiryRe.MatchString(v) {
		return v, nil
	}
	// Try ISO "2006-01-02".
	if t, err := time.Parse("2006-01-02", v); err == nil {
		return strings.ToUpper(t.Format("02Jan2006")), nil
	}
	return "", fmt.Errorf("ExpiryDate %q must be YYYY-MM-DD or DDMMMYYYY", value)
}
