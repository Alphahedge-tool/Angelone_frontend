package angel

import (
	"context"
	"fmt"
	"math"
	"strings"
)

// Leg is a basket leg as sent by the frontend for margin/charges.
type Leg struct {
	Token       string  `json:"token"`
	Symbol      string  `json:"symbol"`
	Exchange    string  `json:"exchange"`
	Qty         float64 `json:"qty"`
	LotSize     float64 `json:"lotSize"`
	Price       float64 `json:"price"`
	TradeType   string  `json:"tradeType"`
	ProductType string  `json:"productType"`
	OrderType   string  `json:"orderType"` // MARKET | LIMIT — required by the margin batch API
}

// MarginReq is the request body for /margin.
type MarginReq struct {
	Client ClientCreds `json:"client"`
	Legs   []Leg       `json:"legs"`
}

// GetMargin computes the netted basket margin via Angel's batch calculator —
// the port of getMargin. Retries once with a fresh login on token failure.
func (c *Client) GetMargin(ctx context.Context, req MarginReq) (map[string]any, error) {
	positions := make([]map[string]any, 0, len(req.Legs))
	for _, leg := range req.Legs {
		if leg.Token == "" {
			continue
		}
		units := int(math.Trunc(leg.Qty * maxFloat(leg.LotSize, 1)))
		if units <= 0 {
			continue
		}
		positions = append(positions, map[string]any{
			"exchange":    orDefault(leg.Exchange, "NFO"),
			"token":       leg.Token, // Angel's key is "token" (not "symboltoken") → else "Token is required"
			"qty":         units,
			"price":       leg.Price,
			"productType": mapProductType(leg.ProductType),
			"tradeType":   tradeType(leg.TradeType),
			// The batch endpoint requires an order type per position ("Order type
			// is required" otherwise): LIMIT when a price is given, else MARKET.
			"orderType": orderType(leg.OrderType),
		})
		if len(positions) >= 50 {
			break
		}
	}
	if len(positions) == 0 {
		return map[string]any{"status": true, "totalMarginRequired": 0, "marginComponents": nil, "empty": true}, nil
	}

	session, err := c.sessionOrLogin(ctx, req.Client)
	if err != nil {
		return nil, fmt.Errorf("Angel session unavailable for margin")
	}
	headers := c.smartHeaders(req.Client.APIKey)
	body := map[string]any{"positions": positions}

	result, err := c.doJSON(ctx, "POST", "/rest/secure/angelbroking/margin/v1/batch", authHeaders(headers, session.JWTToken), body)
	if err != nil {
		relogin, rerr := c.AutoLogin(ctx, withoutSession(req.Client))
		if rerr != nil {
			return nil, err
		}
		session = sessionFromResponse(relogin)
		result, err = c.doJSON(ctx, "POST", "/rest/secure/angelbroking/margin/v1/batch", authHeaders(headers, session.JWTToken), body)
		if err != nil {
			return nil, err
		}
	}

	data := mapData(result)
	return map[string]any{
		"status":              true,
		"totalMarginRequired": toFloat(data["totalMarginRequired"]),
		"marginComponents":    data["marginComponents"],
		"positionCount":       len(positions),
		"session":             session,
	}, nil
}

// mapProductType maps basket products (CF/MIS) → Angel margin productType.
func mapProductType(v string) string {
	switch strings.ToUpper(orDefault(v, "CF")) {
	case "MIS", "INTRADAY":
		return "INTRADAY"
	case "DELIVERY", "CNC":
		return "DELIVERY"
	case "MARGIN":
		return "MARGIN"
	default:
		return "CARRYFORWARD"
	}
}

func tradeType(v string) string {
	if strings.ToUpper(v) == "SELL" {
		return "SELL"
	}
	return "BUY"
}

// orderType normalizes to Angel's LIMIT/MARKET enum; anything not explicitly
// LIMIT is treated as MARKET.
func orderType(v string) string {
	if strings.ToUpper(v) == "LIMIT" {
		return "LIMIT"
	}
	return "MARKET"
}

func orDefault(v, def string) string {
	if v == "" {
		return def
	}
	return v
}

func maxFloat(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}
