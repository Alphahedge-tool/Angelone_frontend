package angel

import (
	"context"
	"fmt"
)

// BookReq is the request body for order/trade book reads.
type BookReq struct {
	Client ClientCreds `json:"client"`
}

// GetOrderBook returns the current Angel order book for the selected account.
func (c *Client) GetOrderBook(ctx context.Context, req BookReq) (map[string]any, error) {
	return c.book(ctx, req.Client, "/rest/secure/angelbroking/order/v1/getOrderBook", "orders")
}

// GetTradeBook returns the current Angel trade book for the selected account.
func (c *Client) GetTradeBook(ctx context.Context, req BookReq) (map[string]any, error) {
	return c.book(ctx, req.Client, "/rest/secure/angelbroking/order/v1/getTradeBook", "trades")
}

func (c *Client) book(ctx context.Context, cc ClientCreds, path, key string) (map[string]any, error) {
	session, err := c.sessionOrLogin(ctx, cc)
	if err != nil {
		return nil, fmt.Errorf("Angel session unavailable for %s", key)
	}

	headers := c.smartHeaders(cc.APIKey)
	result, err := c.doJSON(ctx, "GET", path, authHeaders(headers, session.JWTToken), nil)
	if err != nil {
		relogin, rerr := c.AutoLogin(ctx, withoutSession(cc))
		if rerr != nil {
			return nil, err
		}
		session = sessionFromResponse(relogin)
		result, err = c.doJSON(ctx, "GET", path, authHeaders(headers, session.JWTToken), nil)
		if err != nil {
			return nil, err
		}
	}

	return map[string]any{
		"status":  true,
		key:       normalizeBookRows(result["data"]),
		"raw":     result,
		"session": session,
	}, nil
}

func normalizeBookRows(v any) []map[string]any {
	switch rows := v.(type) {
	case []any:
		out := make([]map[string]any, 0, len(rows))
		for _, row := range rows {
			if m, ok := row.(map[string]any); ok {
				out = append(out, m)
			}
		}
		return out
	case []map[string]any:
		return rows
	case map[string]any:
		return []map[string]any{rows}
	default:
		return []map[string]any{}
	}
}
