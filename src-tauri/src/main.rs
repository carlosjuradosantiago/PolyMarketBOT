mod trading;

use std::sync::Arc;
use tokio::sync::Mutex;
use tauri::{Manager, State};
use trading::engine::TradingEngine;
use trading::models::*;

type EngineState = Arc<Mutex<TradingEngine>>;

// ─── Tauri Commands ─────────────────────────────────────────────────

#[tauri::command]
async fn get_stats(engine: State<'_, EngineState>) -> Result<BotStats, String> {
    let eng = engine.lock().await;
    Ok(eng.get_stats())
}

#[tauri::command]
async fn get_activity_log(engine: State<'_, EngineState>) -> Result<Vec<ActivityEntry>, String> {
    let eng = engine.lock().await;
    Ok(eng.get_activity_log())
}

#[tauri::command]
async fn get_balance_history(engine: State<'_, EngineState>) -> Result<Vec<BalancePoint>, String> {
    let eng = engine.lock().await;
    Ok(eng.get_balance_history())
}

#[tauri::command]
async fn save_config(engine: State<'_, EngineState>, config: BotConfig) -> Result<String, String> {
    let mut eng = engine.lock().await;
    eng.configure(config);
    Ok("Configuration saved successfully".to_string())
}

#[tauri::command]
async fn get_config(engine: State<'_, EngineState>) -> Result<BotConfig, String> {
    let eng = engine.lock().await;
    Ok(eng.config.clone())
}

#[tauri::command]
async fn start_bot(engine: State<'_, EngineState>) -> Result<String, String> {
    let mut eng = engine.lock().await;
    eng.start();
    Ok("Bot started".to_string())
}

#[tauri::command]
async fn stop_bot(engine: State<'_, EngineState>) -> Result<String, String> {
    let mut eng = engine.lock().await;
    eng.stop();
    Ok("Bot stopped".to_string())
}

#[tauri::command]
async fn get_bot_status(engine: State<'_, EngineState>) -> Result<bool, String> {
    let eng = engine.lock().await;
    Ok(eng.is_running)
}

#[tauri::command]
async fn run_cycle(engine: State<'_, EngineState>) -> Result<Vec<ActivityEntry>, String> {
    let mut eng = engine.lock().await;
    match eng.run_cycle().await {
        Ok(activities) => Ok(activities),
        Err(e) => Err(format!("Cycle error: {}", e)),
    }
}

// Demo mode: simulates trading activity for UI testing
#[tauri::command]
async fn run_demo_cycle(engine: State<'_, EngineState>) -> Result<BotStats, String> {
    let mut eng = engine.lock().await;

    if !eng.is_running {
        eng.is_running = true;
        eng.start_time = Some(chrono::Utc::now());
    }

    eng.stats.cycle += 1;

    // Update uptime
    if let Some(start) = eng.start_time {
        let elapsed = chrono::Utc::now() - start;
        let hours = elapsed.num_hours();
        let minutes = elapsed.num_minutes() % 60;
        let seconds = elapsed.num_seconds() % 60;
        eng.stats.uptime = format!("{:02}:{:02}:{:02}", hours, minutes, seconds);
    }

    // Simulate market scanning
    let scan_count = 200 + (eng.stats.cycle as u64 * 7) % 900;
    eng.stats.markets_scanned += scan_count;
    eng.add_activity(
        &format!("Scanning {} feeds...", scan_count),
        ActivityType::Info,
    );

    // Simulate finding edges and placing trades
    let cycle_seed = eng.stats.cycle as f64;
    let market_names = vec![
        "BTC > $102K Feb 12\"",
        "NVDA > $800 Feb 14\"",
        "UFC 312 decision\"",
        "Seoul PM2.5 > 100\"",
        "Man City vs Wolves ML\"",
        "Trump approval > 45%\"",
        "ETH > $3500 Feb 15\"",
        "SpaceX launch success\"",
        "Fed rate hold March\"",
        "Tesla Q1 deliveries > 500K\"",
    ];

    let idx = (eng.stats.cycle as usize) % market_names.len();
    let market_name = market_names[idx];

    let edge = 0.25 + ((cycle_seed * 0.17) % 0.4);
    let fair_value = 0.45 + ((cycle_seed * 0.13) % 0.3);

    if (eng.stats.cycle % 3) != 0 {
        eng.add_activity(
            &format!(
                "Edge: \"{}\" @ {:.2} (fair {:.2})",
                market_name, edge, fair_value
            ),
            ActivityType::Edge,
        );

        let order_size = 20.0 + ((cycle_seed * 23.0) % 180.0);
        eng.add_activity(
            &format!("ORDER ${:.2} → \"{}\"", order_size, market_name),
            ActivityType::Order,
        );

        // Resolve with ~65% win rate
        let won = ((cycle_seed * 7.3) % 10.0) > 3.5;
        let pnl = if won {
            order_size * edge * 0.8
        } else {
            -order_size * (1.0 - edge) * 0.6
        };

        eng.stats.current_balance += pnl;
        eng.stats.total_trades += 1;
        if pnl > 0.0 {
            eng.stats.wins += 1;
            if pnl > eng.stats.best_trade { eng.stats.best_trade = pnl; }
        } else {
            eng.stats.losses += 1;
            if pnl < eng.stats.worst_trade { eng.stats.worst_trade = pnl; }
        }

        eng.add_activity(
            &format!(
                "RESOLVED {}${:.2}",
                if pnl >= 0.0 { "+" } else { "" },
                pnl
            ),
            if pnl >= 0.0 { ActivityType::Resolved } else { ActivityType::Warning },
        );
    } else {
        eng.add_activity(
            &format!("{} markets scanned, no edge", scan_count),
            ActivityType::Info,
        );
    }

    // Evaluate remaining markets
    eng.add_activity(
        &format!("Evaluating {} markets...", 400 + (eng.stats.cycle as u64 % 600)),
        ActivityType::Info,
    );

    // Monitoring orderbooks
    eng.add_activity(
        &format!("Monitoring {} orderbooks...", 200 + (eng.stats.cycle as u64 % 700)),
        ActivityType::Info,
    );

    // API cost simulation
    eng.stats.api_costs += 0.003;
    eng.stats.daily_api_cost = eng.stats.api_costs;

    if (eng.stats.cycle % 5) == 0 {
        eng.add_activity(
            &format!("Inference: -${:.3}", 0.002 + (cycle_seed * 0.001) % 0.005),
            ActivityType::Inference,
        );
    }

    // Update balance history
    eng.balance_history.push(BalancePoint {
        timestamp: chrono::Utc::now().format("%H:%M:%S").to_string(),
        balance: eng.stats.current_balance,
        label: format!("{}m", eng.balance_history.len() * 2),
    });

    // Update derived stats
    eng.stats.total_pnl = eng.stats.current_balance - eng.stats.initial_balance;
    eng.stats.total_pnl_pct = format!(
        "{}${:.1}k",
        if eng.stats.total_pnl >= 0.0 { "+" } else { "" },
        eng.stats.total_pnl / 1000.0
    );

    if eng.stats.total_trades > 0 {
        eng.stats.win_rate = (eng.stats.wins as f64 / eng.stats.total_trades as f64) * 100.0;
        eng.stats.avg_bet = eng.stats.current_balance / eng.stats.total_trades as f64 * 0.3;
    }

    eng.stats.avg_edge = 0.10 + ((cycle_seed * 0.03) % 0.10);
    eng.stats.sharpe_ratio = 1.5 + ((cycle_seed * 0.1) % 1.5);

    if eng.stats.daily_api_cost > 0.0 {
        eng.stats.runway_days = (eng.stats.current_balance / eng.stats.daily_api_cost.max(0.01)) as u32;
    }

    Ok(eng.stats.clone())
}

// ─── Main ────────────────────────────────────────────────────────────

#[cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    let engine: EngineState = Arc::new(Mutex::new(TradingEngine::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(engine)
        .invoke_handler(tauri::generate_handler![
            get_stats,
            get_activity_log,
            get_balance_history,
            save_config,
            get_config,
            start_bot,
            stop_bot,
            get_bot_status,
            run_cycle,
            run_demo_cycle,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
