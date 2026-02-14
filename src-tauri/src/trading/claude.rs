use anyhow::Result;
use reqwest::Client;
use super::models::*;

const CLAUDE_API_URL: &str = "https://api.anthropic.com/v1/messages";

pub struct ClaudeClient {
    client: Client,
    api_key: String,
    model: String,
    total_input_tokens: u64,
    total_output_tokens: u64,
}

impl ClaudeClient {
    pub fn new(api_key: &str, model: &str) -> Self {
        Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(60))
                .build()
                .expect("Failed to build HTTP client"),
            api_key: api_key.to_string(),
            model: model.to_string(),
            total_input_tokens: 0,
            total_output_tokens: 0,
        }
    }

    /// Analyze a market using Claude AI to determine edge & probability
    pub async fn analyze_market(&mut self, market: &Market) -> Result<AIPrediction> {
        let system_prompt = r#"You are an expert prediction market analyst and quantitative trader. 
Your task is to analyze prediction markets and determine:
1. The TRUE probability of each outcome based on available information
2. Whether there is an EDGE (difference between fair price and market price)
3. Your confidence level in the prediction
4. Recommended position size based on Kelly Criterion

Respond in strict JSON format:
{
    "predicted_outcome": "Yes" or "No",
    "fair_price": 0.XX,
    "confidence": 0.XX,
    "edge": 0.XX,
    "reasoning": "Brief explanation",
    "recommended_size_pct": 0.XX
}

Only recommend trades where edge > 0.05 (5%). Be conservative with sizing.
Consider base rates, current events, and market efficiency."#;

        let market_info = format!(
            "Market: {}\nOutcomes: {:?}\nCurrent Prices: {:?}\nVolume: ${:.0}\nLiquidity: ${:.0}\nEnd Date: {}",
            market.question,
            market.outcomes,
            market.outcome_prices,
            market.volume,
            market.liquidity,
            market.end_date.as_deref().unwrap_or("Not set")
        );

        let request = ClaudeRequest {
            model: self.model.clone(),
            max_tokens: 1024,
            messages: vec![ClaudeMessage {
                role: "user".to_string(),
                content: format!("Analyze this prediction market and provide your assessment:\n\n{}", market_info),
            }],
            system: Some(system_prompt.to_string()),
        };

        let resp = self.client
            .post(CLAUDE_API_URL)
            .header("x-api-key", &self.api_key)
            .header("anthropic-version", "2023-06-01")
            .header("content-type", "application/json")
            .json(&request)
            .send()
            .await?;

        let claude_resp: ClaudeResponse = resp.json().await?;

        // Track token usage
        if let Some(usage) = &claude_resp.usage {
            self.total_input_tokens += usage.input_tokens as u64;
            self.total_output_tokens += usage.output_tokens as u64;
        }

        let text = claude_resp.content
            .first()
            .and_then(|c| c.text.as_ref())
            .map(|t| t.to_string())
            .unwrap_or_default();

        // Parse JSON from Claude response
        let prediction = self.parse_prediction(&text, market)?;
        Ok(prediction)
    }

    fn parse_prediction(&self, text: &str, market: &Market) -> Result<AIPrediction> {
        // Try to extract JSON from response
        let json_str = if let Some(start) = text.find('{') {
            if let Some(end) = text.rfind('}') {
                &text[start..=end]
            } else {
                text
            }
        } else {
            text
        };

        let parsed: serde_json::Value = serde_json::from_str(json_str)
            .unwrap_or_else(|_| serde_json::json!({
                "predicted_outcome": "Yes",
                "fair_price": 0.5,
                "confidence": 0.3,
                "edge": 0.0,
                "reasoning": "Failed to parse AI response",
                "recommended_size_pct": 0.0
            }));

        let edge = parsed.get("edge")
            .and_then(|e| e.as_f64())
            .unwrap_or(0.0);

        let confidence = parsed.get("confidence")
            .and_then(|c| c.as_f64())
            .unwrap_or(0.3);

        let fair_price = parsed.get("fair_price")
            .and_then(|f| f.as_f64())
            .unwrap_or(0.5);

        let recommended_size_pct = parsed.get("recommended_size_pct")
            .and_then(|r| r.as_f64())
            .unwrap_or(0.0);

        Ok(AIPrediction {
            market_id: market.id.clone(),
            market_name: market.question.clone(),
            predicted_outcome: parsed.get("predicted_outcome")
                .and_then(|p| p.as_str())
                .unwrap_or("Yes")
                .to_string(),
            confidence,
            edge,
            reasoning: parsed.get("reasoning")
                .and_then(|r| r.as_str())
                .unwrap_or("No reasoning provided")
                .to_string(),
            recommended_size: recommended_size_pct,
            fair_price,
        })
    }

    /// Estimate API cost based on token usage
    pub fn estimate_cost(&self) -> f64 {
        // Claude Sonnet pricing: $3/M input, $15/M output
        let input_cost = (self.total_input_tokens as f64 / 1_000_000.0) * 3.0;
        let output_cost = (self.total_output_tokens as f64 / 1_000_000.0) * 15.0;
        input_cost + output_cost
    }

    pub fn get_total_tokens(&self) -> (u64, u64) {
        (self.total_input_tokens, self.total_output_tokens)
    }

    pub fn is_configured(&self) -> bool {
        !self.api_key.is_empty()
    }
}
