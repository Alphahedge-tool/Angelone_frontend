// Command angelone-backend is a Go port of the Node SmartAPI proxy: same
// /api/angel/* surface, plus connection pooling, per-endpoint rate limiting, and
// short-TTL quote coalescing to stop paying Angel's round-trip more than needed.
package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"angelone-backend/internal/angel"
	"angelone-backend/internal/config"
	"angelone-backend/internal/httpapi"
)

func main() {
	cfg := config.Load()

	client := angel.NewClient(cfg)
	master := angel.NewMasterStore(cfg)
	feed := angel.NewFeed(cfg)
	api := httpapi.New(cfg, client, master, feed)

	srv := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           api.Handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: the SSE stream is a long-lived response.
	}

	// Warm the scrip-master cache on boot so the first option chain is instant.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		if err := master.Warm(ctx); err != nil {
			log.Printf("Master warm-up failed: %v", err)
		} else {
			log.Printf("Scrip master ready")
		}
	}()

	go func() {
		log.Printf("Angel One panel running at http://localhost:%d", cfg.Port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("server error: %v", err)
		}
	}()

	// Graceful shutdown on Ctrl-C / SIGTERM.
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Printf("shutting down…")
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
}
