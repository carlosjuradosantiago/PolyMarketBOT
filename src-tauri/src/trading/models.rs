use serde::{Deserialize, Serialize};
use chrono::{DateTime, Utc};
use uuid::Uuid;

// ─── Trading Models ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Market {
    pub id: String,
    pub question: String,
    pub slug: String,
    pub outcomes: Vec<String>,
    pub outcome_prices: Vec<f64>,
    pub volume: f64,
    pub liquidity: f64,
    pub end_date: Option<String>,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub id: String,
    pub market_id: String,
    pub market_name: String,
    pub side: OrderSide,
    pub outcome: String,
    pub price: f64,
    pub size: f64,
    pub status: OrderStatus,
    pub created_at: String,
    pub resolved_at: Option<String>,
    pub pnl: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OrderSide {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum OrderStatus {
    Pending,
    Filled,
    Resolved,
    Cancelled,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TradeResult {
    pub order_id: String,
    pub market_name: String,
    pub pnl: f64,
    pub status: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BalancePoint {
    pub timestamp: String,
    pub balance: f64,
    pub label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotStats {
    pub current_balance: f64,
    pub initial_balance: f64,
    pub total_pnl: f64,
    pub total_pnl_pct: String,
    pub api_costs: f64,
    pub win_rate: f64,
    pub wins: u32,
    pub losses: u32,
    pub total_trades: u32,
    pub markets_scanned: u64,
    pub avg_bet: f64,
    pub best_trade: f64,
    pub worst_trade: f64,
    pub sharpe_ratio: f64,
    pub avg_edge: f64,
    pub daily_api_cost: f64,
    pub runway_days: u32,
    pub uptime: String,
    pub cycle: u32,
    pub pid: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ActivityEntry {
    pub timestamp: String,
    pub message: String,
    pub entry_type: ActivityType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ActivityType {
    Info,
    Edge,
    Order,
    Resolved,
    Warning,
    Error,
    Inference,
}

// ─── Configuration Models ─────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BotConfig {
    pub polymarket_api_key: String,
    pub polymarket_secret: String,
    pub polymarket_passphrase: String,
    pub claude_api_key: String,
    pub claude_model: String,
    pub initial_balance: f64,
    pub max_bet_size: f64,
    pub min_edge_threshold: f64,
    pub max_concurrent_orders: u32,
    pub scan_interval_secs: u32,
    pub auto_trading: bool,
    pub survival_mode: bool,
}

impl Default for BotConfig {
    fn default() -> Self {
        Self {
            polymarket_api_key: String::new(),
            polymarket_secret: String::new(),
            polymarket_passphrase: String::new(),
            claude_api_key: String::new(),
            claude_model: "claude-sonnet-4-20250514".to_string(),
            initial_balance: 50.0,
            max_bet_size: 200.0,
            min_edge_threshold: 0.30,
            max_concurrent_orders: 5,
            scan_interval_secs: 60,
            auto_trading: false,
            survival_mode: true,
        }
    }
}

// ─── AI Models ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AIPrediction {
    pub market_id: String,
    pub market_name: String,
    pub predicted_outcome: String,
    pub confidence: f64,
    pub edge: f64,
    pub reasoning: String,
    pub recommended_size: f64,
    pub fair_price: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeMessage {
    pub role: String,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeRequest {
    pub model: String,
    pub max_tokens: u32,
    pub messages: Vec<ClaudeMessage>,
    pub system: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeResponse {
    pub content: Vec<ClaudeContent>,
    pub usage: Option<ClaudeUsage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeContent {
    #[serde(rename = "type")]
    pub content_type: String,
    pub text: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ClaudeUsage {
    pub input_tokens: u32,
    pub output_tokens: u32,
}
