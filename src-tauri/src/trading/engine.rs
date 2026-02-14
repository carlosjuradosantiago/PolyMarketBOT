use std::sync::Arc;
use tokio::sync::Mutex;
use chrono::Utc;
use uuid::Uuid;
use anyhow::Result;

use super::models::*;
use super::polymarket::PolymarketClient;
use super::claude::ClaudeClient;

pub struct TradingEngine {
    pub polymarket: Option<PolymarketClient>,
    pub claude: Option<ClaudeClient>,
    pub config: BotConfig,
    pub stats: BotStats,
    pub orders: Vec<Order>,
    pub activity_log: Vec<ActivityEntry>,
    pub balance_history: Vec<BalancePoint>,
    pub is_running: bool,
    pub start_time: Option<chrono::DateTime<Utc>>,
}

impl TradingEngine {
    pub fn new() -> Self {
        let config = BotConfig::default();
        let initial_balance = config.initial_balance;

        Self {
            polymarket: None,
            claude: None,
            config,
            stats: BotStats {
                current_balance: initial_balance,
                initial_balance,
                total_pnl: 0.0,
                total_pnl_pct: "+0%".to_string(),
                api_costs: 0.0,
                win_rate: 0.0,
                wins: 0,
                losses: 0,
                total_trades: 0,
                markets_scanned: 0,
                avg_bet: 0.0,
                best_trade: 0.0,
                worst_trade: 0.0,
                sharpe_ratio: 0.0,
                avg_edge: 0.0,
                daily_api_cost: 0.0,
                runway_days: 0,
                uptime: "00:00:00".to_string(),
                cycle: 0,
                pid: std::process::id(),
            },
            orders: Vec::new(),
            activity_log: Vec::new(),
            balance_history: vec![BalancePoint {
                timestamp: Utc::now().format("%H:%M:%S").to_string(),
                balance: initial_balance,
                label: "0h".to_string(),
            }],
            is_running: false,
            start_time: None,
        }
    }

    /// Initialize clients with API keys
    pub fn configure(&mut self, config: BotConfig) {
        self.polymarket = Some(PolymarketClient::new(
            &config.polymarket_api_key,
            &config.polymarket_secret,
            &config.polymarket_passphrase,
        ));
        self.claude = Some(ClaudeClient::new(
            &config.claude_api_key,
            &config.claude_model,
        ));
        self.config = config;
        self.add_activity("Configuration updated successfully", ActivityType::Info);
    }

    /// Start the trading bot
    pub fn start(&mut self) {
        self.is_running = true;
        self.start_time = Some(Utc::now());
        self.add_activity("🟢 Bot started - Survival Mode active", ActivityType::Info);
    }

    /// Stop the trading bot
    pub fn stop(&mut self) {
        self.is_running = false;
        self.add_activity("🔴 Bot stopped", ActivityType::Warning);
    }

    /// Run one cycle of market scanning + trading
    pub async fn run_cycle(&mut self) -> Result<Vec<ActivityEntry>> {
        let mut new_activities: Vec<ActivityEntry> = Vec::new();

        if !self.is_running {
            return Ok(new_activities);
        }

        self.stats.cycle += 1;

        // Update uptime
        if let Some(start) = self.start_time {
            let elapsed = Utc::now() - start;
            let hours = elapsed.num_hours();
            let minutes = elapsed.num_minutes() % 60;
            let seconds = elapsed.num_seconds() % 60;
            self.stats.uptime = format!("{:02}:{:02}:{:02}", hours, minutes, seconds);
        }

        // Scan markets
        let markets = if let Some(ref client) = self.polymarket {
            let msg = format!("Scanning markets... Cycle #{}", self.stats.cycle);
            self.add_activity(&msg, ActivityType::Info);
            new_activities.push(self.activity_log.last().unwrap().clone());

            match client.get_markets(100, 0).await {
                Ok(markets) => {
                    self.stats.markets_scanned += markets.len() as u64;
                    let msg = format!("Processing {} markets...", markets.len());
                    self.add_activity(&msg, ActivityType::Info);
                    new_activities.push(self.activity_log.last().unwrap().clone());
                    markets
                }
                Err(e) => {
                    self.add_activity(
                        &format!("Error fetching markets: {}", e),
                        ActivityType::Error,
                    );
                    new_activities.push(self.activity_log.last().unwrap().clone());
                    return Ok(new_activities);
                }
            }
        } else {
            return Ok(new_activities);
        };

        // Analyze markets with AI
        for market in markets.iter().take(10) {
            if let Some(ref mut claude) = self.claude {
                match claude.analyze_market(market).await {
                    Ok(prediction) => {
                        self.stats.api_costs = claude.estimate_cost();

                        if prediction.edge >= self.config.min_edge_threshold as f64 {
                            // Found an edge!
                            let edge_msg = format!(
                                "Edge: \"{}\" > ${:.0} @ {:.2} (fair {:.2})",
                                truncate_str(&market.question, 40),
                                prediction.recommended_size * self.stats.current_balance,
                                prediction.edge,
                            );
                            self.add_activity(&edge_msg, ActivityType::Edge);
                            new_activities.push(self.activity_log.last().unwrap().clone());

                            // Place order (simulated for safety)
                            let order_size = (prediction.recommended_size * self.stats.current_balance)
                                .min(self.config.max_bet_size);

                            if order_size > 1.0 && self.config.auto_trading {
                                let order = self.simulate_order(market, &prediction, order_size);
                                let order_msg = format!(
                                    "ORDER ${:.2} → \"{}\"",
                                    order_size,
                                    truncate_str(&market.question, 40)
                                );
                                self.add_activity(&order_msg, ActivityType::Order);
                                new_activities.push(self.activity_log.last().unwrap().clone());
                                self.orders.push(order);
                            }
                        }
                    }
                    Err(e) => {
                        let err_msg = format!("Inference: -${:.3}", 0.002);
                        self.add_activity(&err_msg, ActivityType::Inference);
                        new_activities.push(self.activity_log.last().unwrap().clone());
                    }
                }
            }
        }

        // Simulate some resolved trades for demo
        self.resolve_pending_orders();

        // Update balance history
        self.balance_history.push(BalancePoint {
            timestamp: Utc::now().format("%H:%M:%S").to_string(),
            balance: self.stats.current_balance,
            label: format!("{}h", self.balance_history.len()),
        });

        // Update derived stats
        self.update_stats();

        Ok(new_activities)
    }

    fn simulate_order(&self, market: &Market, prediction: &AIPrediction, size: f64) -> Order {
        Order {
            id: Uuid::new_v4().to_string(),
            market_id: market.id.clone(),
            market_name: market.question.clone(),
            side: OrderSide::Buy,
            outcome: prediction.predicted_outcome.clone(),
            price: prediction.fair_price,
            size,
            status: OrderStatus::Filled,
            created_at: Utc::now().format("%H:%M:%S").to_string(),
            resolved_at: None,
            pnl: None,
        }
    }

    fn resolve_pending_orders(&mut self) {
        let mut rng_seed = self.stats.cycle as f64;
        
        for order in self.orders.iter_mut() {
            if matches!(order.status, OrderStatus::Filled) {
                // Simple simulation: ~65% win rate
                rng_seed = (rng_seed * 1.1 + 0.3) % 1.0;
                let won = rng_seed > 0.35;

                let pnl = if won {
                    order.size * (1.0 / order.price - 1.0) * 0.3 // Partial win
                } else {
                    -order.size * 0.7 // Partial loss
                };

                order.pnl = Some(pnl);
                order.status = OrderStatus::Resolved;
                order.resolved_at = Some(Utc::now().format("%H:%M:%S").to_string());

                self.stats.current_balance += pnl;
                self.stats.total_trades += 1;

                if pnl > 0.0 {
                    self.stats.wins += 1;
                    if pnl > self.stats.best_trade {
                        self.stats.best_trade = pnl;
                    }
                } else {
                    self.stats.losses += 1;
                    if pnl < self.stats.worst_trade {
                        self.stats.worst_trade = pnl;
                    }
                }

                let resolve_msg = format!(
                    "RESOLVED {}${:.2}",
                    if pnl >= 0.0 { "+" } else { "" },
                    pnl
                );
                self.add_activity(&resolve_msg, if pnl >= 0.0 { ActivityType::Resolved } else { ActivityType::Warning });
            }
        }

        // Remove resolved orders from active list (keep last 50 for history)
        if self.orders.len() > 50 {
            self.orders = self.orders.split_off(self.orders.len() - 50);
        }
    }

    fn update_stats(&mut self) {
        self.stats.total_pnl = self.stats.current_balance - self.stats.initial_balance;

        let pnl_pct = if self.stats.initial_balance > 0.0 {
            (self.stats.total_pnl / self.stats.initial_balance) * 100.0
        } else {
            0.0
        };
        self.stats.total_pnl_pct = format!(
            "{}${:.1}k",
            if self.stats.total_pnl >= 0.0 { "+" } else { "" },
            self.stats.total_pnl / 1000.0
        );

        if self.stats.total_trades > 0 {
            self.stats.win_rate = (self.stats.wins as f64 / self.stats.total_trades as f64) * 100.0;
            
            let total_bet: f64 = self.orders.iter()
                .filter(|o| matches!(o.status, OrderStatus::Resolved))
                .map(|o| o.size)
                .sum();
            self.stats.avg_bet = if self.stats.total_trades > 0 {
                total_bet / self.stats.total_trades as f64
            } else {
                0.0
            };
        }

        // Sharpe ratio approximation
        if self.stats.total_trades > 1 {
            let returns: Vec<f64> = self.orders.iter()
                .filter_map(|o| o.pnl)
                .collect();
            let mean = returns.iter().sum::<f64>() / returns.len() as f64;
            let variance = returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / returns.len() as f64;
            let std_dev = variance.sqrt();
            self.stats.sharpe_ratio = if std_dev > 0.0 { mean / std_dev * (252.0_f64).sqrt() } else { 0.0 };
        }

        // Runway calculation
        if self.stats.daily_api_cost > 0.0 {
            self.stats.runway_days = (self.stats.current_balance / self.stats.daily_api_cost) as u32;
        } else {
            self.stats.runway_days = 9999;
        }

        self.stats.daily_api_cost = self.stats.api_costs; // Simplified
    }

    pub fn add_activity(&mut self, message: &str, entry_type: ActivityType) {
        let entry = ActivityEntry {
            timestamp: Utc::now().format("[%H:%M:%S]").to_string(),
            message: message.to_string(),
            entry_type,
        };
        self.activity_log.push(entry);

        // Keep last 500 entries
        if self.activity_log.len() > 500 {
            self.activity_log = self.activity_log.split_off(self.activity_log.len() - 500);
        }
    }

    pub fn get_stats(&self) -> BotStats {
        self.stats.clone()
    }

    pub fn get_activity_log(&self) -> Vec<ActivityEntry> {
        self.activity_log.clone()
    }

    pub fn get_balance_history(&self) -> Vec<BalancePoint> {
        self.balance_history.clone()
    }
}

fn truncate_str(s: &str, max_len: usize) -> String {
    if s.len() <= max_len {
        s.to_string()
    } else {
        format!("{}...", &s[..max_len])
    }
}
