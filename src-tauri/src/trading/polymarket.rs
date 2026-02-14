use anyhow::Result;
use reqwest::Client;
use serde_json::Value;
use super::models::*;

const POLYMARKET_API_BASE: &str = "https://clob.polymarket.com";
const POLYMARKET_GAMMA_BASE: &str = "https://gamma-api.polymarket.com";

pub struct PolymarketClient {
    client: Client,
    api_key: String,
    secret: String,
    passphrase: String,
}

impl PolymarketClient {
    pub fn new(api_key: &str, secret: &str, passphrase: &str) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(30))
                .build()
                .expect("Failed to build HTTP client"),
            api_key: api_key.to_string(),
            secret: secret.to_string(),
            passphrase: passphrase.to_string(),
        }
    }

    /// Fetch active markets from Polymarket
    pub async fn get_markets(&self, limit: u32, offset: u32) -> Result<Vec<Market>> {
        let url = format!(
            "{}/markets?limit={}&offset={}&active=true&closed=false",
            POLYMARKET_GAMMA_BASE, limit, offset
        );

        let resp = self.client.get(&url).send().await?;
        let body: Value = resp.json().await?;

        let markets = if let Some(arr) = body.as_array() {
            arr.iter()
                .filter_map(|m| {
                    let question = m.get("question")?.as_str()?.to_string();
                    let id = m.get("condition_id").or(m.get("id"))?.as_str()?.to_string();

                    let outcomes: Vec<String> = m.get("outcomes")
                        .and_then(|o| serde_json::from_value(o.clone()).ok())
                        .unwrap_or_else(|| vec!["Yes".to_string(), "No".to_string()]);

                    let outcome_prices: Vec<f64> = m.get("outcomePrices")
                        .and_then(|p| {
                            if let Some(arr) = p.as_array() {
                                Some(arr.iter().filter_map(|v| {
                                    v.as_str().and_then(|s| s.parse::<f64>().ok())
                                        .or_else(|| v.as_f64())
                                }).collect())
                            } else {
                                None
                            }
                        })
                        .unwrap_or_else(|| vec![0.5, 0.5]);

                    let volume = m.get("volume")
                        .and_then(|v| v.as_str().and_then(|s| s.parse::<f64>().ok()).or(v.as_f64()))
                        .unwrap_or(0.0);

                    let liquidity = m.get("liquidity")
                        .and_then(|v| v.as_str().and_then(|s| s.parse::<f64>().ok()).or(v.as_f64()))
                        .unwrap_or(0.0);

                    Some(Market {
                        id,
                        question,
                        slug: m.get("slug").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                        outcomes,
                        outcome_prices,
                        volume,
                        liquidity,
                        end_date: m.get("endDate").and_then(|d| d.as_str()).map(|s| s.to_string()),
                        active: true,
                    })
                })
                .collect()
        } else {
            vec![]
        };

        Ok(markets)
    }

    /// Get specific market details
    pub async fn get_market(&self, condition_id: &str) -> Result<Option<Market>> {
        let url = format!("{}/markets/{}", POLYMARKET_GAMMA_BASE, condition_id);
        let resp = self.client.get(&url).send().await?;

        if !resp.status().is_success() {
            return Ok(None);
        }

        let m: Value = resp.json().await?;

        let question = m.get("question").and_then(|q| q.as_str()).unwrap_or("Unknown").to_string();
        let id = condition_id.to_string();

        let outcomes: Vec<String> = m.get("outcomes")
            .and_then(|o| serde_json::from_value(o.clone()).ok())
            .unwrap_or_else(|| vec!["Yes".to_string(), "No".to_string()]);

        let outcome_prices: Vec<f64> = m.get("outcomePrices")
            .and_then(|p| {
                if let Some(arr) = p.as_array() {
                    Some(arr.iter().filter_map(|v| {
                        v.as_str().and_then(|s| s.parse::<f64>().ok()).or_else(|| v.as_f64())
                    }).collect())
                } else {
                    None
                }
            })
            .unwrap_or_else(|| vec![0.5, 0.5]);

        Ok(Some(Market {
            id,
            question,
            slug: m.get("slug").and_then(|s| s.as_str()).unwrap_or("").to_string(),
            outcomes,
            outcome_prices,
            volume: m.get("volume").and_then(|v| v.as_f64()).unwrap_or(0.0),
            liquidity: m.get("liquidity").and_then(|v| v.as_f64()).unwrap_or(0.0),
            end_date: m.get("endDate").and_then(|d| d.as_str()).map(|s| s.to_string()),
            active: true,
        }))
    }

    /// Get orderbook for a token
    pub async fn get_orderbook(&self, token_id: &str) -> Result<Value> {
        let url = format!("{}/book?token_id={}", POLYMARKET_API_BASE, token_id);
        let resp = self.client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send()
            .await?;
        let body: Value = resp.json().await?;
        Ok(body)
    }

    /// Place an order on Polymarket CLOB
    pub async fn place_order(
        &self,
        token_id: &str,
        side: &str,
        price: f64,
        size: f64,
    ) -> Result<Value> {
        let order_payload = serde_json::json!({
            "tokenID": token_id,
            "price": price,
            "size": size,
            "side": side,
            "feeRateBps": 0,
            "nonce": 0,
            "expiration": 0,
        });

        let url = format!("{}/order", POLYMARKET_API_BASE);
        let resp = self.client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .header("Content-Type", "application/json")
            .json(&order_payload)
            .send()
            .await?;

        let body: Value = resp.json().await?;
        Ok(body)
    }

    /// Get current positions
    pub async fn get_positions(&self) -> Result<Value> {
        let url = format!("{}/positions", POLYMARKET_API_BASE);
        let resp = self.client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send()
            .await?;
        let body: Value = resp.json().await?;
        Ok(body)
    }

    /// Get balance info
    pub async fn get_balance(&self) -> Result<f64> {
        let url = format!("{}/balance", POLYMARKET_API_BASE);
        let resp = self.client
            .get(&url)
            .header("Authorization", format!("Bearer {}", self.api_key))
            .send()
            .await?;

        let body: Value = resp.json().await?;
        let balance = body.get("balance")
            .and_then(|b| b.as_f64())
            .unwrap_or(0.0);

        Ok(balance)
    }

    pub fn is_configured(&self) -> bool {
        !self.api_key.is_empty() && !self.secret.is_empty()
    }
}
