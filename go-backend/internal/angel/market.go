package angel

import (
	"context"
	"fmt"
	"math"
	"sort"
	"strings"
	"sync"
)

// spotTokens maps index symbols to their [exchange, token] spot LTP source.
var spotTokens = map[string][2]string{
	"NIFTY":      {"NSE", "99926000"},
	"BANKNIFTY":  {"NSE", "99926009"},
	"FINNIFTY":   {"NSE", "99926037"},
	"MIDCPNIFTY": {"NSE", "99926074"},
	"SENSEX":     {"BSE", "99919000"},
}

// mcxSymbols are the MCX commodity underlyings that trade options.
var mcxSymbols = map[string]bool{
	"GOLD": true, "GOLDM": true, "SILVER": true, "SILVERM": true,
	"CRUDEOIL": true, "CRUDEOILM": true, "NATURALGAS": true, "NATGASMINI": true,
	"COPPER": true, "ZINC": true, "MCXBULLDEX": true,
}

// segmentFor picks the F&O segment a symbol's contracts live in.
func segmentFor(symbol string) string {
	switch {
	case symbol == "SENSEX":
		return "BFO"
	case mcxSymbols[symbol]:
		return "MCX"
	default:
		return "NFO"
	}
}

// quote fetches a market quote, coalescing identical concurrent requests (same
// mode+tokens within the cache TTL share one upstream call). This is the third
// bottleneck fix: the option chain's 30 rows + spot no longer each pay the
// round-trip — repeated reads hit the cache, concurrent ones hit singleflight.
func (c *Client) quote(ctx context.Context, headers map[string]string, jwt, mode, exchange string, tokens []string) (map[string]any, error) {
	key := "quote|" + mode + "|" + exchange + "|" + strings.Join(tokens, ",")
	res, err := c.cache.do(ctx, key, func() (any, error) {
		return c.doJSON(ctx, "POST", "/rest/secure/angelbroking/market/v1/quote", authHeaders(headers, jwt), map[string]any{
			"mode":           mode,
			"exchangeTokens": map[string]any{exchange: tokens},
		})
	})
	if err != nil {
		return nil, err
	}
	return res.(map[string]any), nil
}

// OptionChainReq is the request body for /option-chain.
type OptionChainReq struct {
	Client ClientCreds `json:"client"`
	Symbol string      `json:"symbol"`
	Expiry string      `json:"expiry"`
	Window int         `json:"window"`
}

// ScripOptionsWithSpot builds the master-only chain skeleton (AllScripOptions)
// and, when a session is available, adds one cheap spot LTP quote so the
// response carries spot + atm immediately — the frontend can render and mark the
// ATM row without waiting for the first live tick. The spot quote is best-effort:
// if there's no session, the skeleton still returns (atm from the median strike).
func (c *Client) ScripOptionsWithSpot(ctx context.Context, master *MasterStore, req ScripOptionsReq, cc ClientCreds) (map[string]any, error) {
	res, err := master.AllScripOptions(ctx, req)
	if err != nil {
		return nil, err
	}

	strikes, _ := res["strikes"].([]int)

	spot := 0.0
	if len(strikes) > 0 {
		spot = float64(strikes[len(strikes)/2]) // median fallback
	}

	// Ensure a session so the response can carry the feed block (the frontend
	// subscribes the live feed with this feedToken). We deliberately do NOT fetch
	// all-strike prices here — that's the slow part, split into ChainPrices so the
	// ladder renders instantly. Just one cheap spot quote for the ATM marker.
	session, sErr := c.sessionOrLogin(ctx, cc)

	spotToken, _ := res["spotToken"].(string)
	spotExchange, _ := res["spotExchange"].(string)

	if sErr == nil && session != nil && spotToken != "" {
		headers := c.smartHeaders(cc.APIKey)
		if q, err := c.quote(ctx, headers, session.JWTToken, "LTP", spotExchange, []string{spotToken}); err == nil {
			if v := firstFetchedLTP(q); v > 0 {
				spot = v
			}
		}
	}

	// ATM = strike closest to spot.
	atm := 0
	if len(strikes) > 0 {
		atm = strikes[0]
		for _, s := range strikes {
			if math.Abs(float64(s)-spot) < math.Abs(float64(atm)-spot) {
				atm = s
			}
		}
	}
	res["spot"] = spot
	res["atm"] = atm

	// Feed block + session so the frontend can start the live feed and reuse the
	// account for margin/charges — matching what /option-chain returned.
	if session != nil {
		res["feed"] = map[string]any{
			"jwtToken":   session.JWTToken,
			"feedToken":  session.FeedToken,
			"apiKey":     cc.APIKey,
			"clientCode": cc.ClientCode,
		}
		res["session"] = session
	}
	return res, nil
}

// ChainPrices returns ONLY the live prices (LTP/OI/close per strike, spot, atm,
// pcr) for a symbol+expiry — no ladder structure. This is the slow, Angel-facing
// half of the chain, split out so the frontend can render the master skeleton
// INSTANTLY and then fill these in via a background call (or the live feed). The
// arrays are aligned by strike so the frontend merges them onto the skeleton by
// index.
func (c *Client) ChainPrices(ctx context.Context, master *MasterStore, req ScripOptionsReq, cc ClientCreds) (map[string]any, error) {
	skel, err := master.AllScripOptions(ctx, req)
	if err != nil {
		return nil, err
	}
	strikes, _ := skel["strikes"].([]int)
	exchange, _ := skel["exchange"].(string)
	callTokens, _ := skel["callTokens"].([]any)
	putTokens, _ := skel["putTokens"].([]any)
	allTokens, _ := skel["liveTokens"].([]string)
	spotToken, _ := skel["spotToken"].(string)
	spotExchange, _ := skel["spotExchange"].(string)

	session, err := c.sessionOrLogin(ctx, cc)
	if err != nil || session == nil {
		return nil, fmt.Errorf("Angel session unavailable for prices")
	}
	jwt := session.JWTToken
	headers := c.smartHeaders(cc.APIKey)

	spot := 0.0
	if len(strikes) > 0 {
		spot = float64(strikes[len(strikes)/2])
	}

	// spot + FULL quote for every strike (chunked to 50), all concurrent.
	var (
		fetched []map[string]any
		wg      sync.WaitGroup
		mu      sync.Mutex
	)
	if spotToken != "" {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if q, e := c.quote(ctx, headers, jwt, "LTP", spotExchange, []string{spotToken}); e == nil {
				if v := firstFetchedLTP(q); v > 0 {
					mu.Lock()
					spot = v
					mu.Unlock()
				}
			}
		}()
	}
	for _, chunk := range chunkTokens(allTokens, 50) {
		wg.Add(1)
		go func(toks []string) {
			defer wg.Done()
			if q, e := c.quote(ctx, headers, jwt, "FULL", exchange, toks); e == nil {
				rows := fetchedList(q)
				mu.Lock()
				fetched = append(fetched, rows...)
				mu.Unlock()
			}
		}(chunk)
	}
	wg.Wait()

	byToken := map[string]map[string]any{}
	for _, q := range fetched {
		byToken[strOr(q["symbolToken"], "")] = q
	}
	n := len(strikes)
	callOI := make([]float64, n)
	putOI := make([]float64, n)
	callLtp := make([]float64, n)
	putLtp := make([]float64, n)
	callClose := make([]float64, n)
	putClose := make([]float64, n)
	readRow := func(tokens []any, i int) (oi, ltp, cl float64) {
		if i >= len(tokens) {
			return
		}
		tok, _ := tokens[i].(string)
		q := byToken[tok]
		if q == nil {
			return
		}
		oi = toFloat(q["opnInterest"])
		ltp = firstNonZero(q, "ltp", "lastTradePrice", "lastPrice", "close")
		cl = firstNonZero(q, "close", "previousClose")
		return
	}
	var totalCall, totalPut float64
	for i := range strikes {
		callOI[i], callLtp[i], callClose[i] = readRow(callTokens, i)
		putOI[i], putLtp[i], putClose[i] = readRow(putTokens, i)
		totalCall += callOI[i]
		totalPut += putOI[i]
	}

	atm := 0
	if len(strikes) > 0 {
		atm = strikes[0]
		for _, s := range strikes {
			if math.Abs(float64(s)-spot) < math.Abs(float64(atm)-spot) {
				atm = s
			}
		}
	}
	pcr := 0.0
	if totalCall > 0 {
		pcr = round2(totalPut / totalCall)
	}

	return map[string]any{
		"status":    true,
		"strikes":   strikes, // for the frontend to align by index
		"spot":      spot,
		"atm":       atm,
		"pcr":       pcr,
		"callOI":    callOI,
		"putOI":     putOI,
		"callLtp":   callLtp,
		"putLtp":    putLtp,
		"callClose": callClose,
		"putClose":  putClose,
	}, nil
}

// GetOptionChain builds the ATM-centered option chain (OI, LTP, close, greeks
// exposure, live-feed tokens) for a symbol+expiry — the port of getOptionChain.
func (c *Client) GetOptionChain(ctx context.Context, req OptionChainReq, master *MasterStore) (map[string]any, error) {
	if req.Expiry == "" {
		return nil, fmt.Errorf("Expiry is required")
	}
	session, err := c.sessionOrLogin(ctx, req.Client)
	if err != nil {
		return nil, err
	}
	jwt := session.JWTToken
	headers := c.smartHeaders(req.Client.APIKey)

	rows, err := master.Data(ctx)
	if err != nil {
		return nil, err
	}
	symbol := strings.ToUpper(req.Symbol)
	expiry := strings.ToUpper(req.Expiry)
	exchange := segmentFor(symbol)

	type contract struct{ token, tradingSymbol string }
	ce := map[int]contract{}
	pe := map[int]contract{}
	lotSize := 1
	type fut struct {
		token    string
		expiryMs int64
	}
	var futs []fut

	for i := range rows {
		row := &rows[i]
		if row.Name != symbol || row.Segment != exchange {
			continue
		}
		sym := row.Symbol
		if exchange == "MCX" && strings.HasSuffix(sym, "FUT") {
			futs = append(futs, fut{row.Token, parseExpiryMs(row.Expiry)})
		}
		if row.Expiry != expiry {
			continue
		}
		strike := normalizeStrike(row.Strike, exchange)
		if row.LotSize > 0 {
			lotSize = row.LotSize
		}
		switch {
		case strings.HasSuffix(sym, "CE"):
			ce[strike] = contract{row.Token, sym}
		case strings.HasSuffix(sym, "PE"):
			pe[strike] = contract{row.Token, sym}
		}
	}

	if len(ce) == 0 && len(pe) == 0 {
		return nil, fmt.Errorf("No option tokens found for %s %s", symbol, expiry)
	}

	// Nearest future on/after the option expiry (MCX spot source).
	var futToken string
	if len(futs) > 0 {
		sort.Slice(futs, func(i, j int) bool { return futs[i].expiryMs < futs[j].expiryMs })
		optMs := parseExpiryMs(expiry)
		futToken = futs[0].token
		for _, f := range futs {
			if f.expiryMs >= optMs {
				futToken = f.token
				break
			}
		}
	}

	strikes := unionStrikes(ce, pe)

	spotExchange, spotToken := "", ""
	if pair, ok := spotTokens[symbol]; ok {
		spotExchange, spotToken = pair[0], pair[1]
	} else if futToken != "" {
		spotExchange, spotToken = exchange, futToken
	}

	// Spot LTP decides the ATM (and thus which strikes are in the window). It's a
	// single cheap token, so fetch it first; the two heavy calls parallelize below.
	spot := 0.0
	if len(strikes) > 0 {
		spot = float64(strikes[len(strikes)/2])
	}
	if spotToken != "" {
		if r, err := c.quote(ctx, headers, jwt, "LTP", spotExchange, []string{spotToken}); err == nil {
			if v := firstFetchedLTP(r); v > 0 {
				spot = v
			}
		}
	}

	// ATM = strike closest to spot.
	atm := strikes[0]
	for _, s := range strikes {
		if math.Abs(float64(s)-spot) < math.Abs(float64(atm)-spot) {
			atm = s
		}
	}
	atmIndex := indexOf(strikes, atm)
	if atmIndex < 0 {
		atmIndex = 0
	}
	side := clampInt(req.Window, 1, 30)
	if req.Window == 0 {
		side = 12
	}
	lo := maxInt(0, atmIndex-side)
	hi := minInt(len(strikes), atmIndex+side+1)
	finalStrikes := strikes[lo:hi]

	// Per-strike token/symbol arrays aligned with finalStrikes.
	callTokens := make([]any, len(finalStrikes))
	putTokens := make([]any, len(finalStrikes))
	callSymbols := make([]any, len(finalStrikes))
	putSymbols := make([]any, len(finalStrikes))
	var liveTokens []string
	for i, s := range finalStrikes {
		if cc, ok := ce[s]; ok {
			callTokens[i] = cc.token
			callSymbols[i] = cc.tradingSymbol
			liveTokens = append(liveTokens, cc.token)
		}
		if pc, ok := pe[s]; ok {
			putTokens[i] = pc.token
			putSymbols[i] = pc.tradingSymbol
			liveTokens = append(liveTokens, pc.token)
		}
	}

	// Fetch the FULL quote for the WINDOWED tokens (Angel caps a quote at ~50
	// tokens, so we chunk) and the greeks — all CONCURRENTLY. This is where the
	// time is: running the quote chunks and greeks in parallel keeps the load
	// near one round-trip instead of the sum.
	const quoteChunk = 50
	chunks := chunkTokens(liveTokens, quoteChunk)

	var (
		fetched []map[string]any
		greekRes map[string]any
		liveErr error
		mu      sync.Mutex
		wg      sync.WaitGroup
	)
	for _, chunk := range chunks {
		wg.Add(1)
		go func(tokens []string) {
			defer wg.Done()
			res, err := c.quote(ctx, headers, jwt, "FULL", exchange, tokens)
			if err != nil {
				mu.Lock()
				if liveErr == nil {
					liveErr = err
				}
				mu.Unlock()
				return
			}
			rows := fetchedList(res)
			mu.Lock()
			fetched = append(fetched, rows...)
			mu.Unlock()
		}(chunk)
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		greekRes, _ = c.doJSON(ctx, "POST", "/rest/secure/angelbroking/marketData/v1/optionGreek", authHeaders(headers, jwt), map[string]any{
			"name": symbol, "expirydate": expiry,
		})
	}()
	wg.Wait()

	// If any quote chunk failed (commonly a dead JWT), re-login once and refetch
	// the whole windowed set sequentially — spot/greeks stay best-effort.
	if liveErr != nil {
		relogin, rerr := c.AutoLogin(ctx, withoutSession(req.Client))
		if rerr != nil {
			return nil, liveErr
		}
		session = sessionFromResponse(relogin)
		jwt = session.JWTToken
		fetched = fetched[:0]
		for _, chunk := range chunks {
			res, err := c.quote(ctx, headers, jwt, "FULL", exchange, chunk)
			if err != nil {
				return nil, err
			}
			fetched = append(fetched, fetchedList(res)...)
		}
	}

	// Fold quotes into per-strike maps by token.
	ceByToken := make(map[string]int, len(ce))
	for strike, cc := range ce {
		ceByToken[cc.token] = strike
	}
	peByToken := make(map[string]int, len(pe))
	for strike, pc := range pe {
		peByToken[pc.token] = strike
	}
	callOI, putOI := map[int]float64{}, map[int]float64{}
	callLtp, putLtp := map[int]float64{}, map[int]float64{}
	callClose, putClose := map[int]float64{}, map[int]float64{}
	for _, q := range fetched {
		token := strOr(q["symbolToken"], "")
		oi := toFloat(q["opnInterest"])
		ltp := firstNonZero(q, "ltp", "lastTradePrice", "lastPrice", "close")
		cl := firstNonZero(q, "close", "previousClose")
		if s, ok := ceByToken[token]; ok {
			callOI[s], callLtp[s], callClose[s] = oi, ltp, cl
		}
		if s, ok := peByToken[token]; ok {
			putOI[s], putLtp[s], putClose[s] = oi, ltp, cl
		}
	}

	// Greek deltas by strike for the "manipulated OI" (delta-weighted) exposure.
	callDelta, putDelta := map[int]float64{}, map[int]float64{}
	for _, g := range fetchedGreeks(greekRes) {
		s := int(math.Trunc(toFloat(g["strikePrice"])))
		ot := strOr(g["optionType"], "")
		if strings.Contains(ot, "CE") {
			callDelta[s] = toFloat(g["delta"])
		}
		if strings.Contains(ot, "PE") {
			putDelta[s] = toFloat(g["delta"])
		}
	}

	n := len(finalStrikes)
	outCall := make([]float64, n)
	outPut := make([]float64, n)
	outCallLtp := make([]float64, n)
	outPutLtp := make([]float64, n)
	outCallClose := make([]float64, n)
	outPutClose := make([]float64, n)
	expCall := make([]float64, n)
	expPut := make([]float64, n)
	var totalCall, totalPut float64
	for i, s := range finalStrikes {
		outCall[i] = callOI[s]
		outPut[i] = putOI[s]
		outCallLtp[i] = callLtp[s]
		outPutLtp[i] = putLtp[s]
		outCallClose[i] = callClose[s]
		outPutClose[i] = putClose[s]
		expCall[i] = math.Abs(callOI[s] * callDelta[s])
		expPut[i] = math.Abs(putOI[s] * putDelta[s])
		totalCall += callOI[s]
		totalPut += putOI[s]
	}
	pcr := 0.0
	if totalCall > 0 {
		pcr = round2(totalPut / totalCall)
	}

	return map[string]any{
		"status":            true,
		"symbol":            symbol,
		"expiry":            expiry,
		"spot":              spot,
		"atm":               atm,
		"pcr":               pcr,
		"strikes":           finalStrikes,
		"callOI":            outCall,
		"putOI":             outPut,
		"callLtp":           outCallLtp,
		"putLtp":            outPutLtp,
		"callClose":         outCallClose,
		"putClose":          outPutClose,
		"manipulatedCallOI": expCall,
		"manipulatedPutOI":  expPut,
		"exchange":          exchange,
		"lotSize":           lotSize,
		"callTokens":        callTokens,
		"putTokens":         putTokens,
		"callSymbols":       callSymbols,
		"putSymbols":        putSymbols,
		"liveTokens":        liveTokens,
		"spotToken":         nilIfEmpty(spotToken),
		"spotExchange":      nilIfEmpty(spotExchange),
		"feed": map[string]any{
			"jwtToken":   jwt,
			"feedToken":  session.FeedToken,
			"apiKey":     req.Client.APIKey,
			"clientCode": req.Client.ClientCode,
		},
		"session": session,
	}, nil
}

// ── resolve-leg ─────────────────────────────────────────────────────────────

// ResolveLegReq is the request body for /resolve-leg.
type ResolveLegReq struct {
	Client     ClientCreds `json:"client"`
	Symbol     string      `json:"symbol"`
	Expiry     string      `json:"expiry"`
	Strike     float64     `json:"strike"`
	OptionType string      `json:"optionType"`
}

// ResolveLeg resolves one option contract (token, tradingsymbol, lot size) for a
// (symbol, expiry, strike, side), snapping to the nearest strike, and fetches
// its live LTP/close — the port of resolveLeg.
func (c *Client) ResolveLeg(ctx context.Context, req ResolveLegReq, master *MasterStore) (map[string]any, error) {
	symbol := strings.ToUpper(req.Symbol)
	expiry := strings.ToUpper(req.Expiry)
	side := "CE"
	if strings.HasSuffix(strings.ToUpper(req.OptionType), "PE") {
		side = "PE"
	}
	want := int(math.Trunc(req.Strike))
	if symbol == "" || expiry == "" || want == 0 {
		return nil, fmt.Errorf("symbol, expiry and strike are required")
	}
	exchange := segmentFor(symbol)

	rows, err := master.Data(ctx)
	if err != nil {
		return nil, err
	}
	type cand struct {
		strike        int
		token, symbol string
		lotSize       int
	}
	var cands []cand
	for i := range rows {
		row := &rows[i]
		if row.Name != symbol || row.Segment != exchange || row.Expiry != expiry {
			continue
		}
		if !strings.HasSuffix(row.Symbol, side) {
			continue
		}
		lot := row.LotSize
		if lot == 0 {
			lot = 1
		}
		cands = append(cands, cand{normalizeStrike(row.Strike, exchange), row.Token, row.Symbol, lot})
	}
	if len(cands) == 0 {
		return nil, fmt.Errorf("No %s contracts for %s %s", side, symbol, expiry)
	}

	found := cands[0]
	snapped := found.strike
	exact := false
	for _, cd := range cands {
		if cd.strike == want {
			found, snapped, exact = cd, cd.strike, true
			break
		}
	}
	if !exact {
		best := cands[0]
		for _, cd := range cands {
			if abs(cd.strike-want) < abs(best.strike-want) {
				best = cd
			}
		}
		found, snapped = best, best.strike
	}

	// Live quote (best-effort — return the contract with ltp=null on failure).
	var ltp, cl *float64
	var quoteErr any
	session := resolveSession(req.Client)
	if session == nil || session.JWTToken == "" {
		quoteErr = "no session (log in to fetch price)"
	} else {
		headers := c.smartHeaders(req.Client.APIKey)
		q, err := c.quote(ctx, headers, session.JWTToken, "FULL", exchange, []string{found.token})
		if err != nil {
			quoteErr = err.Error()
		} else if list := fetchedList(q); len(list) > 0 {
			raw := firstNonZero(list[0], "ltp", "lastTradePrice")
			closeV := firstNonZero(list[0], "close", "previousClose")
			var v float64
			if raw > 0 {
				v = raw
			} else {
				v = closeV
			}
			ltp = &v
			if closeV > 0 {
				cl = &closeV
			}
		} else {
			quoteErr = strOr(q["message"], "quote returned no rows")
		}
	}

	var changePct *float64
	if ltp != nil && cl != nil && *cl > 0 {
		v := round2((*ltp - *cl) / *cl * 100)
		changePct = &v
	}

	return map[string]any{
		"status":        true,
		"token":         found.token,
		"tradingSymbol": found.symbol,
		"exchange":      exchange,
		"lotSize":       found.lotSize,
		"strike":        snapped,
		"expiry":        expiry,
		"optionType":    side,
		"ltp":           ltp,
		"close":         cl,
		"changePct":     changePct,
		"quoteError":    quoteErr,
	}, nil
}

// sessionOrLogin returns a usable session, logging in if needed.
func (c *Client) sessionOrLogin(ctx context.Context, cc ClientCreds) (*Session, error) {
	if s := resolveSession(cc); s != nil {
		return s, nil
	}
	res, err := c.AutoLogin(ctx, cc)
	if err != nil {
		return nil, err
	}
	if s := sessionFromResponse(res); s != nil {
		return s, nil
	}
	return nil, fmt.Errorf("Angel session unavailable")
}
