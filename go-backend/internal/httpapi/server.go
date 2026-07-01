// Package httpapi wires the HTTP surface. Routes match the existing Node
// server's /api/angel/* paths exactly, so the React frontend needs zero changes.
package httpapi

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"angelone-backend/internal/angel"
	"angelone-backend/internal/config"
)

// Server holds the shared dependencies and implements http.Handler.
type Server struct {
	cfg    config.Config
	client *angel.Client
	master *angel.MasterStore
	feed   *angel.Feed
}

func New(cfg config.Config, client *angel.Client, master *angel.MasterStore, feed *angel.Feed) *Server {
	return &Server{cfg: cfg, client: client, master: master, feed: feed}
}

// Handler builds the router.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/angel/auto-login", s.postJSON(s.handleAutoLogin))
	mux.HandleFunc("/api/angel/logout", s.handleLogout)
	mux.HandleFunc("/api/angel/master-index", s.handleMasterIndex)
	// All option scrips for a symbol+expiry straight from OUR master (no Angel
	// round-trip), mirroring Angel's all-scrip-options. GET with query params.
	mux.HandleFunc("/api/angel/all-scrip-options", s.handleAllScripOptions)
	// Live prices only (LTP/OI/close per strike) for a symbol+expiry — the slow,
	// Angel-facing half, fired in the background after the instant ladder render.
	mux.HandleFunc("/api/angel/chain-prices", s.postJSON(s.handleChainPrices))
	mux.HandleFunc("/api/angel/refresh-master", s.postJSON(s.handleRefreshMaster))
	mux.HandleFunc("/api/angel/option-chain", s.postJSON(s.handleOptionChain))
	mux.HandleFunc("/api/angel/order-book", s.postJSON(s.handleOrderBook))
	mux.HandleFunc("/api/angel/trade-book", s.postJSON(s.handleTradeBook))
	mux.HandleFunc("/api/angel/margin", s.postJSON(s.handleMargin))
	mux.HandleFunc("/api/angel/charges", s.postJSON(s.handleCharges))
	mux.HandleFunc("/api/angel/resolve-leg", s.postJSON(s.handleResolveLeg))
	mux.HandleFunc("/api/angel/subscribe", s.postJSON(s.handleSubscribe))
	// Basket feed sync: client sends the FULL current leg-token set, server
	// reconciles (subscribe new, unsubscribe dropped). /subscribe-more kept as an
	// alias so an older frontend build still works.
	mux.HandleFunc("/api/angel/basket-tokens", s.postJSON(s.handleBasketTokens))
	mux.HandleFunc("/api/angel/subscribe-more", s.postJSON(s.handleBasketTokens))
	mux.HandleFunc("/api/angel/stream", s.handleStream)
	mux.HandleFunc("/", s.serveStatic) // SPA static fallback
	return withCORS(mux)
}

// ── handlers ────────────────────────────────────────────────────────────────

func (s *Server) handleAutoLogin(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var wrap struct {
		Client angel.ClientCreds `json:"client"`
	}
	decodeInto(body, &wrap)
	return s.client.AutoLogin(ctx, wrap.Client)
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, 200, map[string]any{"status": true, "message": "Logged out"})
}

func (s *Server) handleMasterIndex(w http.ResponseWriter, r *http.Request) {
	idx, err := s.master.Index(r.Context())
	if err != nil {
		writeJSON(w, 500, errBody(err))
		return
	}
	writeJSON(w, 200, idx)
}

// handleAllScripOptions serves every option scrip for a symbol+expiry from our
// master, mirroring Angel's all-scrip-options query shape. Two forms:
//   GET  ?TradeSymbol=NIFTY&ExpiryDate=2026-07-07&MarketSegmentId=1  → pure master
//   POST {client, TradeSymbol, ExpiryDate, MarketSegmentId}          → + spot/atm
// The POST form does one cheap spot LTP quote so the skeleton carries spot+atm.
func (s *Server) handleAllScripOptions(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		q := r.URL.Query()
		res, err := s.master.AllScripOptions(r.Context(), angel.ScripOptionsReq{
			TradeSymbol:     q.Get("TradeSymbol"),
			ExpiryDate:      q.Get("ExpiryDate"),
			MarketSegmentId: q.Get("MarketSegmentId"),
		})
		if err != nil {
			writeJSON(w, 400, errBody(err))
			return
		}
		writeJSON(w, 200, res)
	case http.MethodPost:
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		var body struct {
			Client          angel.ClientCreds `json:"client"`
			TradeSymbol     string            `json:"TradeSymbol"`
			ExpiryDate      string            `json:"ExpiryDate"`
			MarketSegmentId string            `json:"MarketSegmentId"`
		}
		_ = json.Unmarshal(raw, &body)
		res, err := s.client.ScripOptionsWithSpot(r.Context(), s.master, angel.ScripOptionsReq{
			TradeSymbol:     body.TradeSymbol,
			ExpiryDate:      body.ExpiryDate,
			MarketSegmentId: body.MarketSegmentId,
		}, body.Client)
		if err != nil {
			writeJSON(w, 400, errBody(err))
			return
		}
		writeJSON(w, 200, res)
	default:
		writeJSON(w, 405, map[string]any{"status": false, "message": "Method not allowed"})
	}
}

func (s *Server) handleRefreshMaster(ctx context.Context, _ map[string]json.RawMessage) (any, error) {
	return s.master.Refresh(ctx)
}

func (s *Server) handleOptionChain(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req angel.OptionChainReq
	decodeReq(body, &req)
	return s.client.GetOptionChain(ctx, req, s.master)
}

func (s *Server) handleOrderBook(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req angel.BookReq
	decodeReq(body, &req)
	return s.client.GetOrderBook(ctx, req)
}

func (s *Server) handleTradeBook(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req angel.BookReq
	decodeReq(body, &req)
	return s.client.GetTradeBook(ctx, req)
}

// handleChainPrices returns just the live prices for a symbol+expiry (the slow,
// Angel-facing half), so the frontend can render the master ladder instantly and
// fill these in via a background call.
func (s *Server) handleChainPrices(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req struct {
		Client      angel.ClientCreds `json:"client"`
		TradeSymbol string            `json:"TradeSymbol"`
		ExpiryDate  string            `json:"ExpiryDate"`
	}
	decodeReq(body, &req)
	return s.client.ChainPrices(ctx, s.master, angel.ScripOptionsReq{
		TradeSymbol: req.TradeSymbol,
		ExpiryDate:  req.ExpiryDate,
	}, req.Client)
}

func (s *Server) handleMargin(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req angel.MarginReq
	decodeReq(body, &req)
	return s.client.GetMargin(ctx, req)
}

func (s *Server) handleCharges(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req angel.ChargesReq
	decodeReq(body, &req)
	return s.client.GetCharges(ctx, req)
}

func (s *Server) handleResolveLeg(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req angel.ResolveLegReq
	decodeReq(body, &req)
	return s.client.ResolveLeg(ctx, req, s.master)
}

func (s *Server) handleSubscribe(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req struct {
		Credentials angel.FeedCredentials `json:"credentials"`
		Exchange    string                `json:"exchange"`
		Tokens      []string              `json:"tokens"`
		Spot        *struct {
			Token    string `json:"token"`
			Exchange string `json:"exchange"`
		} `json:"spot"`
	}
	decodeReq(body, &req)
	spotToken, spotExchange := "", ""
	if req.Spot != nil {
		spotToken, spotExchange = req.Spot.Token, req.Spot.Exchange
	}
	n, err := s.feed.Subscribe(req.Credentials, orNFO(req.Exchange), req.Tokens, spotToken, spotExchange)
	if err != nil {
		return nil, err
	}
	return map[string]any{"status": true, "subscribed": n, "exchange": orNFO(req.Exchange)}, nil
}

// handleBasketTokens reconciles the live feed to EXACTLY the basket's current
// leg tokens: the client posts the full set, the server subscribes new ones and
// unsubscribes dropped ones (old strike/expiry after a change, or removed legs).
func (s *Server) handleBasketTokens(ctx context.Context, body map[string]json.RawMessage) (any, error) {
	var req struct {
		Credentials *angel.FeedCredentials `json:"credentials"`
		Items       []struct {
			Exchange string `json:"exchange"`
			Token    string `json:"token"`
		} `json:"items"`
	}
	decodeReq(body, &req)
	items := make([]angel.FeedItem, 0, len(req.Items))
	for _, it := range req.Items {
		items = append(items, angel.FeedItem{Exchange: it.Exchange, Token: it.Token})
	}
	res, err := s.feed.SetBasketTokensItems(req.Credentials, items)
	if err != nil {
		return nil, err
	}
	// `dropped` is non-zero only when the 1000-token session cap is full; the
	// frontend can surface that so the user knows some legs aren't ticking live.
	return map[string]any{
		"status":  true,
		"added":   res.Added,
		"removed": res.Removed,
		"dropped": res.Dropped,
		"total":   res.Total,
	}, nil
}

// handleStream is the SSE endpoint: registers a client and streams tick/status
// events until the request is cancelled.
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}
	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache, no-transform")
	h.Set("Connection", "keep-alive")
	h.Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)

	ch, connected := s.feed.AddClient()
	defer s.feed.RemoveClient(ch)

	fmt.Fprint(w, "retry: 3000\n\n")
	writeSSE(w, "status", fmt.Sprintf(`{"connected":%t,"message":"Stream open"}`, connected))
	flusher.Flush()

	keepAlive := time.NewTicker(20 * time.Second)
	defer keepAlive.Stop()

	for {
		select {
		case <-r.Context().Done():
			return
		case ev, ok := <-ch:
			if !ok {
				return
			}
			writeSSE(w, ev.Event, ev.Data)
			flusher.Flush()
		case <-keepAlive.C:
			fmt.Fprint(w, ": keep-alive\n\n")
			flusher.Flush()
		}
	}
}

// serveStatic serves the built SPA from dist/, falling back to index.html.
func (s *Server) serveStatic(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeJSON(w, 404, map[string]any{"status": false, "message": "Not found"})
		return
	}
	clean := filepath.Clean(strings.TrimPrefix(r.URL.Path, "/"))
	if clean == "." || clean == "" {
		clean = "index.html"
	}
	full := filepath.Join(s.cfg.StaticRoot, clean)
	if info, err := os.Stat(full); err != nil || info.IsDir() {
		full = filepath.Join(s.cfg.StaticRoot, "index.html")
	}
	http.ServeFile(w, r, full)
}

// ── plumbing ────────────────────────────────────────────────────────────────

// postJSON adapts a (ctx, body)→(any,error) handler into an http.HandlerFunc
// that reads the JSON body once and writes the JSON result or a 500 error body.
func (s *Server) postJSON(fn func(context.Context, map[string]json.RawMessage) (any, error)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, 405, map[string]any{"status": false, "message": "Method not allowed"})
			return
		}
		raw, _ := io.ReadAll(io.LimitReader(r.Body, 8<<20))
		body := map[string]json.RawMessage{}
		if len(raw) > 0 {
			_ = json.Unmarshal(raw, &body)
		}
		res, err := fn(r.Context(), body)
		if err != nil {
			writeJSON(w, 500, errBody(err))
			return
		}
		writeJSON(w, 200, res)
	}
}

func decodeReq(body map[string]json.RawMessage, target any) {
	// Re-marshal the whole body and unmarshal into the typed request. Cheap and
	// keeps the handlers declarative.
	raw, _ := json.Marshal(rawToAny(body))
	_ = json.Unmarshal(raw, target)
}

func decodeInto(body map[string]json.RawMessage, target any) { decodeReq(body, target) }

func rawToAny(body map[string]json.RawMessage) map[string]any {
	out := make(map[string]any, len(body))
	for k, v := range body {
		var val any
		_ = json.Unmarshal(v, &val)
		out[k] = val
	}
	return out
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeSSE(w io.Writer, event, data string) {
	if event != "" {
		fmt.Fprintf(w, "event: %s\n", event)
	}
	fmt.Fprintf(w, "data: %s\n\n", data)
}

func errBody(err error) map[string]any {
	return map[string]any{"status": false, "message": err.Error()}
}

func orNFO(s string) string {
	if s == "" {
		return "NFO"
	}
	return s
}

// withCORS handles preflight and adds permissive CORS headers (dev parity with
// the Node server's sendCors).
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		h.Set("Access-Control-Allow-Headers", "Content-Type")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}
