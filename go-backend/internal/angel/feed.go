package angel

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"log"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gorilla/websocket"

	"angelone-backend/internal/config"
)

// maxFeedTokens is Angel's hard limit: 1000 token subscriptions per WS session
// (in mode 3 / SNAP_QUOTE, each distinct token is one subscription). We keep a
// small safety margin so we never trip the server-side rejection.
const maxFeedTokens = 990

var (
	errFeedSession = errors.New("Live feed needs an active session (jwtToken + feedToken)")
	errNoTokens    = errors.New("No tokens to subscribe")
)

func itoa(n int) string  { return strconv.Itoa(n) }
func atoi(s string) int  { n, _ := strconv.Atoi(s); return n }

// WSExchangeType maps exchange segments to SmartWebSocket exchangeType codes.
var WSExchangeType = map[string]int{
	"NSE": 1, "NFO": 2, "BSE": 3, "BFO": 4, "MCX": 5, "CDS": 7, "NCDEX": 7,
}

func wsType(exchange string) int {
	if t, ok := WSExchangeType[exchange]; ok {
		return t
	}
	return WSExchangeType["NFO"]
}

// FeedCredentials are what the WS handshake needs (from the chain's feed block).
type FeedCredentials struct {
	JWTToken   string `json:"jwtToken"`
	FeedToken  string `json:"feedToken"`
	APIKey     string `json:"apiKey"`
	ClientCode string `json:"clientCode"`
}

// Tick is one parsed market update pushed to SSE clients.
type Tick struct {
	Token string   `json:"token"`
	LTP   float64  `json:"ltp"`
	OI    *float64 `json:"oi"`
	Close *float64 `json:"close"`
}

// Feed owns the single upstream Angel WebSocket, the additive token union, and
// the set of connected SSE clients. It mirrors the Node feed's behavior exactly:
// one socket, an additive union (on-screen chain + every basket leg), and
// incremental subscribe frames on the live socket.
type Feed struct {
	cfg config.Config

	mu           sync.Mutex
	conn         *websocket.Conn
	creds        FeedCredentials
	tokens       map[int]map[string]bool // exchangeType -> set(token) — the union
	chainKeys    map[string]bool         // "type|token" for the current on-screen chain
	basketKeys   map[string]bool         // "type|token" the basket currently holds
	sseClients   map[chan SSEEvent]bool
	heartbeat    *time.Ticker
	stopHeartbeat chan struct{}
}

// SSEEvent is one server-sent event: Event is "" for a data tick or "status".
type SSEEvent struct {
	Event string
	Data  string
}

func NewFeed(cfg config.Config) *Feed {
	return &Feed{
		cfg:        cfg,
		tokens:     map[int]map[string]bool{},
		chainKeys:  map[string]bool{},
		basketKeys: map[string]bool{},
		sseClients: map[chan SSEEvent]bool{},
	}
}

// ── SSE client registry ─────────────────────────────────────────────────────

// AddClient registers an SSE listener and returns its channel + the initial
// connected status line.
func (f *Feed) AddClient() (chan SSEEvent, bool) {
	ch := make(chan SSEEvent, 256)
	f.mu.Lock()
	f.sseClients[ch] = true
	connected := f.conn != nil
	f.mu.Unlock()
	return ch, connected
}

// RemoveClient unregisters a listener; when the last one leaves, the upstream
// feed is dropped and the token union forgotten (matches closeFeed(true)).
func (f *Feed) RemoveClient(ch chan SSEEvent) {
	f.mu.Lock()
	if _, ok := f.sseClients[ch]; ok {
		delete(f.sseClients, ch)
		close(ch)
	}
	last := len(f.sseClients) == 0
	f.mu.Unlock()
	if last {
		f.closeUpstream(true)
	}
}

func (f *Feed) broadcast(ev SSEEvent) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for ch := range f.sseClients {
		select {
		case ch <- ev:
		default: // slow client: drop rather than block the feed
		}
	}
}

// ── Subscription API (called by the HTTP handlers) ──────────────────────────

// FeedEntry is an (exchangeType, token) pair.
type feedEntry struct {
	exType int
	token  string
}

// Subscribe points the feed at a freshly loaded chain: drops the previous
// chain's strikes (preserving basket-leg tokens) and (re)subscribes the union.
func (f *Feed) Subscribe(creds FeedCredentials, exchange string, tokens []string, spotToken, spotExchange string) (int, error) {
	if creds.JWTToken == "" || creds.FeedToken == "" {
		return 0, errFeedSession
	}
	if len(tokens) == 0 {
		return 0, errNoTokens
	}
	entries := toEntries(exchange, tokens, spotToken, spotExchange)
	newKeys := map[string]bool{}
	for _, e := range entries {
		newKeys[keyOf(e.exType, e.token)] = true
	}

	f.mu.Lock()
	// Drop previous chain tokens not in the new chain (basket legs aren't in
	// chainKeys, so they're never removed).
	for key := range f.chainKeys {
		if newKeys[key] {
			continue
		}
		exType, token := splitKey(key)
		if set := f.tokens[exType]; set != nil {
			delete(set, token)
		}
	}
	f.chainKeys = newKeys
	f.creds = creds
	added, dropped := f.mergeLocked(entries)
	f.mu.Unlock()

	f.startOrResubscribe(creds, added)
	if dropped > 0 && f.cfg.FeedDebug {
		log.Printf("[feed] chain subscribe hit the %d-token cap; %d dropped", maxFeedTokens, dropped)
	}
	return len(tokens), nil
}

// FeedItem is an exported (exchange, token) pair for the HTTP layer.
type FeedItem struct {
	Exchange string
	Token    string
}

// SubscribeResult reports the outcome of a basket sync: how many tokens were
// newly subscribed, how many were released (old strike/expiry tokens no longer
// in the basket), how many were dropped for the 1000-token cap, and the union
// size.
type SubscribeResult struct {
	Added    int
	Removed  int
	Dropped  int
	Total    int
}

// SetBasketTokensItems adapts exported FeedItems (the FULL current basket set)
// into the internal entry shape and reconciles the feed to exactly that set.
func (f *Feed) SetBasketTokensItems(creds *FeedCredentials, items []FeedItem) (SubscribeResult, error) {
	entries := make([]feedEntry, 0, len(items))
	for _, it := range items {
		if it.Token == "" {
			continue
		}
		entries = append(entries, feedEntry{wsType(it.Exchange), it.Token})
	}
	return f.SetBasketTokens(creds, entries)
}

// SetBasketTokens reconciles the live feed to hold EXACTLY the basket's current
// leg tokens (plus whatever the on-screen chain needs). It diffs the new set
// against what the basket held last time:
//   - tokens the basket dropped (old strike/expiry after a change, or a removed
//     leg) are UNSUBSCRIBED — unless the on-screen chain still needs them — so
//     nothing accumulates toward Angel's 1000-token cap;
//   - genuinely new tokens are subscribed (respecting the cap).
// This is why changing a leg's strike/expiry releases the previous token: the
// client sends the full set, the old token isn't in it, so it's dropped here.
func (f *Feed) SetBasketTokens(creds *FeedCredentials, items []feedEntry) (SubscribeResult, error) {
	f.mu.Lock()
	use := f.creds
	if creds != nil && creds.JWTToken != "" {
		use = *creds
	}
	if use.JWTToken == "" || use.FeedToken == "" {
		f.mu.Unlock()
		return SubscribeResult{}, errFeedSession
	}
	f.creds = use

	// New basket key set.
	newBasket := make(map[string]bool, len(items))
	for _, e := range items {
		if e.token != "" {
			newBasket[keyOf(e.exType, e.token)] = true
		}
	}

	// Release: tokens the basket used to hold but no longer does — and that the
	// on-screen chain doesn't need — get removed from the union + unsubscribed.
	var removed []feedEntry
	for key := range f.basketKeys {
		if newBasket[key] || f.chainKeys[key] {
			continue
		}
		exType, token := splitKey(key)
		if set := f.tokens[exType]; set != nil {
			delete(set, token)
		}
		removed = append(removed, feedEntry{exType, token})
	}

	// Add: tokens in the new basket not already in the union (cap-aware).
	added, dropped := f.mergeLocked(items)
	f.basketKeys = newBasket
	haveConn := f.conn != nil
	total := f.totalTokensLocked()
	f.mu.Unlock()

	if dropped > 0 {
		log.Printf("[feed] basket sync hit the %d-token cap; %d dropped (total=%d)", maxFeedTokens, dropped, total)
	}

	// Push the changes to Angel: unsubscribe releases, subscribe adds.
	f.unsubscribe(groupEntries(removed))
	addedCount := countGroups(added)
	if addedCount > 0 {
		f.startOrResubscribe(use, added)
	} else if !haveConn {
		// No new tokens and no socket yet (e.g. only removals): make sure the
		// socket exists so remaining tokens keep ticking.
		f.startOrResubscribe(use, f.snapshot())
	}

	return SubscribeResult{Added: addedCount, Removed: len(removed), Dropped: dropped, Total: total}, nil
}

// totalTokensLocked counts the distinct tokens across all exchange groups —
// this is what Angel caps at 1000 per session. Caller must hold f.mu.
func (f *Feed) totalTokensLocked() int {
	n := 0
	for _, set := range f.tokens {
		n += len(set)
	}
	return n
}

// mergeLocked adds entries to the union (respecting Angel's 1000-token cap) and
// returns the newly-added tokens grouped by exchangeType, plus the count of
// tokens that were DROPPED because the session was already full. Caller must
// hold f.mu.
func (f *Feed) mergeLocked(entries []feedEntry) ([]tokenGroup, int) {
	added := map[int][]string{}
	total := f.totalTokensLocked()
	dropped := 0
	for _, e := range entries {
		if e.token == "" {
			continue
		}
		if f.tokens[e.exType] == nil {
			f.tokens[e.exType] = map[string]bool{}
		}
		if f.tokens[e.exType][e.token] {
			continue // already subscribed — doesn't count against the cap
		}
		if total >= maxFeedTokens {
			dropped++ // session full: refuse rather than let Angel reject it
			continue
		}
		f.tokens[e.exType][e.token] = true
		added[e.exType] = append(added[e.exType], e.token)
		total++
	}
	return groupsOf(added), dropped
}

// snapshot returns the whole union as subscribe groups (used on (re)connect).
func (f *Feed) snapshot() []tokenGroup {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[int][]string{}
	for exType, set := range f.tokens {
		for token := range set {
			out[exType] = append(out[exType], token)
		}
	}
	return groupsOf(out)
}

type tokenGroup struct {
	exType int
	tokens []string
}

// ── Upstream WebSocket ──────────────────────────────────────────────────────

// startOrResubscribe opens the socket if needed, else sends an incremental
// subscribe for the given groups on the live socket.
func (f *Feed) startOrResubscribe(creds FeedCredentials, groups []tokenGroup) {
	f.mu.Lock()
	conn := f.conn
	f.mu.Unlock()

	if conn != nil {
		f.sendSubscribe(conn, groups, "incremental")
		return
	}
	f.connect(creds)
}

func (f *Feed) connect(creds FeedCredentials) {
	header := http.Header{}
	header.Set("Authorization", creds.JWTToken) // raw JWT, no "Bearer "
	header.Set("x-api-key", creds.APIKey)
	header.Set("x-client-code", creds.ClientCode)
	header.Set("x-feed-token", creds.FeedToken)

	conn, _, err := websocket.DefaultDialer.Dial(config.SmartStreamURL, header)
	if err != nil {
		f.broadcast(statusEvent(false, "Feed error: "+err.Error()))
		return
	}

	f.mu.Lock()
	f.conn = conn
	f.stopHeartbeat = make(chan struct{})
	stop := f.stopHeartbeat
	f.mu.Unlock()

	f.broadcast(statusEvent(true, "Live feed connected"))
	f.sendSubscribe(conn, f.snapshot(), "initial")

	go f.readLoop(conn)
	go f.pingLoop(conn, stop)
}

// sendSubscribe writes a mode-3 (SNAP_QUOTE) subscribe frame for the groups.
func (f *Feed) sendSubscribe(conn *websocket.Conn, groups []tokenGroup, tag string) {
	if len(groups) == 0 {
		return
	}
	tokenList := make([]map[string]any, 0, len(groups))
	for _, g := range groups {
		tokenList = append(tokenList, map[string]any{"exchangeType": g.exType, "tokens": g.tokens})
	}
	msg := map[string]any{
		"correlationID": tag,
		"action":        1,
		"params":        map[string]any{"mode": 3, "tokenList": tokenList},
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.conn != conn {
		return
	}
	if err := conn.WriteJSON(msg); err != nil && f.cfg.FeedDebug {
		log.Printf("[feed] subscribe write failed: %v", err)
	}
}

// unsubscribe writes an action-0 frame releasing the given token groups on the
// live socket, so dropped strike/expiry tokens stop counting against the cap.
// No-ops when there's no socket (the tokens were never subscribed upstream).
func (f *Feed) unsubscribe(groups []tokenGroup) {
	if len(groups) == 0 {
		return
	}
	f.mu.Lock()
	conn := f.conn
	f.mu.Unlock()
	if conn == nil {
		return
	}
	tokenList := make([]map[string]any, 0, len(groups))
	for _, g := range groups {
		tokenList = append(tokenList, map[string]any{"exchangeType": g.exType, "tokens": g.tokens})
	}
	msg := map[string]any{
		"correlationID": "basket-drop",
		"action":        0, // unsubscribe
		"params":        map[string]any{"mode": 3, "tokenList": tokenList},
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.conn != conn {
		return
	}
	if err := conn.WriteJSON(msg); err != nil && f.cfg.FeedDebug {
		log.Printf("[feed] unsubscribe write failed: %v", err)
	}
}

// groupEntries collapses a flat entry slice into per-exchangeType token groups.
func groupEntries(entries []feedEntry) []tokenGroup {
	m := map[int][]string{}
	for _, e := range entries {
		if e.token != "" {
			m[e.exType] = append(m[e.exType], e.token)
		}
	}
	return groupsOf(m)
}

// countGroups totals the tokens across groups.
func countGroups(groups []tokenGroup) int {
	n := 0
	for _, g := range groups {
		n += len(g.tokens)
	}
	return n
}

func (f *Feed) pingLoop(conn *websocket.Conn, stop chan struct{}) {
	ticker := time.NewTicker(10 * time.Second) // Angel needs a ping ~every 10s
	defer ticker.Stop()
	for {
		select {
		case <-stop:
			return
		case <-ticker.C:
			f.mu.Lock()
			same := f.conn == conn
			f.mu.Unlock()
			if !same {
				return
			}
			if err := conn.WriteMessage(websocket.TextMessage, []byte("ping")); err != nil {
				return
			}
		}
	}
}

func (f *Feed) readLoop(conn *websocket.Conn) {
	for {
		mt, data, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if mt != websocket.BinaryMessage {
			continue // pong/text/error frames
		}
		if tick := parseTick(data); tick != nil {
			raw, _ := json.Marshal(tick)
			f.broadcast(SSEEvent{Data: string(raw)})
		}
	}
	f.mu.Lock()
	if f.conn == conn {
		f.conn = nil
		if f.stopHeartbeat != nil {
			close(f.stopHeartbeat)
			f.stopHeartbeat = nil
		}
	}
	f.mu.Unlock()
	f.broadcast(statusEvent(false, "Live feed closed"))
}

// closeUpstream drops the socket. reset=true also forgets tokens + creds so a
// stale union can't be re-subscribed on the next chain load.
func (f *Feed) closeUpstream(reset bool) {
	f.mu.Lock()
	conn := f.conn
	f.conn = nil
	if f.stopHeartbeat != nil {
		close(f.stopHeartbeat)
		f.stopHeartbeat = nil
	}
	if reset {
		f.tokens = map[int]map[string]bool{}
		f.chainKeys = map[string]bool{}
		f.basketKeys = map[string]bool{}
		f.creds = FeedCredentials{}
	}
	f.mu.Unlock()
	if conn != nil {
		_ = conn.Close()
	}
}

// parseTick decodes one SmartWebSocket V2 binary packet. Little-endian layout:
// [0]=mode [1]=exchangeType [2:27]=token (null-term ascii) [43:51]=LTP int64
// (paise ÷100). SNAP_QUOTE adds close at [115:123] and OI at [131:139].
func parseTick(buf []byte) *Tick {
	if len(buf) < 51 {
		return nil
	}
	token := strings.TrimRight(strings.SplitN(string(buf[2:27]), "\x00", 2)[0], " \x00")
	if token == "" {
		return nil
	}
	ltp := float64(int64(binary.LittleEndian.Uint64(buf[43:51]))) / 100
	tick := &Tick{Token: token, LTP: ltp}
	if len(buf) >= 123 {
		cl := float64(int64(binary.LittleEndian.Uint64(buf[115:123]))) / 100
		tick.Close = &cl
	}
	if len(buf) >= 139 {
		oi := float64(int64(binary.LittleEndian.Uint64(buf[131:139])))
		tick.OI = &oi
	}
	return tick
}

// ── helpers ─────────────────────────────────────────────────────────────────

func toEntries(exchange string, tokens []string, spotToken, spotExchange string) []feedEntry {
	entries := make([]feedEntry, 0, len(tokens)+1)
	for _, t := range tokens {
		if t != "" {
			entries = append(entries, feedEntry{wsType(exchange), t})
		}
	}
	if spotToken != "" {
		ex := spotExchange
		if ex == "" {
			ex = exchange
		}
		entries = append(entries, feedEntry{wsType(ex), spotToken})
	}
	return entries
}

func groupsOf(m map[int][]string) []tokenGroup {
	out := make([]tokenGroup, 0, len(m))
	for exType, tokens := range m {
		if len(tokens) == 0 {
			continue
		}
		out = append(out, tokenGroup{exType, tokens})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].exType < out[j].exType })
	return out
}

func keyOf(exType int, token string) string { return itoa(exType) + "|" + token }
func splitKey(key string) (int, string) {
	i := strings.IndexByte(key, '|')
	if i < 0 {
		return 0, key
	}
	return atoi(key[:i]), key[i+1:]
}

func statusEvent(connected bool, message string) SSEEvent {
	raw, _ := json.Marshal(map[string]any{"connected": connected, "message": message})
	return SSEEvent{Event: "status", Data: string(raw)}
}
