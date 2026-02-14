# 🤖 Polymarket Trading Bot - AI Agent

High-performance automated trading bot for [Polymarket](https://polymarket.com) prediction markets, powered by **Claude AI** for market analysis and built with **Rust + Tauri** for maximum execution speed.

![Dashboard](docs/screenshot.png)

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────┐
│                  TAURI DESKTOP APP                   │
├──────────────────────┬──────────────────────────────┤
│     RUST BACKEND     │     REACT FRONTEND           │
│                      │                              │
│  ┌─────────────────┐ │  ┌──────────────────────┐    │
│  │ Trading Engine   │ │  │ Dashboard (Real-time)│    │
│  │ - Market Scanner │ │  │ - Balance Chart      │    │
│  │ - Order Manager  │ │  │ - Activity Log       │    │
│  │ - Risk Control   │ │  │ - Stats Panels       │    │
│  ├─────────────────┤ │  │ - Settings Panel     │    │
│  │ Polymarket API   │ │  └──────────────────────┘    │
│  │ (CLOB + Gamma)   │ │                              │
│  ├─────────────────┤ │  React + TypeScript           │
│  │ Claude AI Client │ │  Recharts + TailwindCSS      │
│  │ (Market Analysis)│ │                              │
│  └─────────────────┘ │                              │
│                      │                              │
│  Rust + Tokio async  │  Vite dev server              │
└──────────────────────┴──────────────────────────────┘
```

## 📦 Prerequisites

### Required
- **Node.js** >= 18 (https://nodejs.org)
- **Rust** >= 1.75 (https://rustup.rs)
- **Tauri CLI** (installed via npm)

### Windows Additional
- Visual Studio C++ Build Tools
- WebView2 (comes with Windows 10/11)

## 🚀 Quick Start

### 1. Install Dependencies

```bash
# Frontend dependencies
npm install

# Rust dependencies will be auto-downloaded on first build
```

### 2. Development Mode (Browser Preview)

To preview the UI in your browser without Tauri (Demo Mode):

```bash
npm run dev
```

Open http://localhost:5173 - The bot runs in **Demo Mode** with simulated trading data.

### 3. Desktop App (Full Tauri Build)

```bash
# Install Tauri CLI
npm install -g @tauri-apps/cli

# Run in development mode (desktop window)
npm run tauri dev

# Build production executable
npm run tauri build
```

The production build creates a native `.exe` (Windows), `.dmg` (macOS), or `.deb` (Linux).

## ⚙️ Configuration

Click the **⚙ Settings** button in the top-right to configure:

### API Keys Tab
- **Polymarket API Key** - From polymarket.com/settings
- **Polymarket Secret** - CLOB API secret
- **Polymarket Passphrase** - CLOB API passphrase
- **Claude API Key** - From console.anthropic.com

### Trading Tab
- **Initial Balance** - Starting capital (default: $50)
- **Max Bet Size** - Maximum per-trade (default: $200)
- **Min Edge Threshold** - Minimum edge to trade (default: 0.30)
- **Max Concurrent Orders** - Position limit (default: 5)
- **Scan Interval** - Market scan frequency (default: 60s)
- **Auto Trading** - Enable/disable automatic order placement
- **Survival Mode** - Conservative sizing for maximum runway

### AI Config Tab
- **Claude Model** - Choose between Opus 4, Sonnet 4, or Haiku 3.5

## 📊 Dashboard Features

- **Current Balance** - Real-time portfolio value
- **Total P&L** - Profit/loss since inception
- **API Costs** - Claude AI inference costs tracked
- **Win Rate** - Historical win/loss ratio
- **Balance Chart** - Log-scale balance over time
- **Activity Log** - Real-time feed of all bot actions:
  - 🟡 **Edge** detected in markets
  - 🔵 **Orders** placed
  - 🟢 **Resolved** trades (profit)
  - 🔴 **Warning** (losses)
  - 🟣 **Inference** costs
- **Stats Panel** - Trades, Sharpe ratio, avg edge, best/worst trade

## 🛡️ Safety Features

- **Demo Mode** - Test without real money (default in browser)
- **Survival Mode** - Ultra-conservative sizing
- **Edge Threshold** - Won't trade without minimum edge
- **Position Limits** - Max concurrent orders
- **API Cost Tracking** - Monitor inference spend

## 📁 Project Structure

```
├── src-tauri/              # Rust backend
│   ├── src/
│   │   ├── main.rs         # Tauri app entry + commands
│   │   └── trading/
│   │       ├── engine.rs   # Core trading engine
│   │       ├── polymarket.rs # Polymarket API client
│   │       ├── claude.rs   # Claude AI client
│   │       └── models.rs   # Data structures
│   ├── Cargo.toml          # Rust dependencies
│   └── tauri.conf.json     # Tauri configuration
├── src/                    # React frontend
│   ├── App.tsx             # Main application
│   ├── components/
│   │   ├── Header.tsx      # Top bar with controls
│   │   ├── TopCards.tsx     # Balance, P&L, costs, win rate
│   │   ├── BalanceChart.tsx # Line chart with gradient
│   │   ├── ActivityLog.tsx  # Scrolling activity feed
│   │   ├── StatsPanel.tsx   # Bottom statistics
│   │   └── SettingsPanel.tsx# Configuration modal
│   ├── types/index.ts      # TypeScript interfaces
│   └── utils/format.ts     # Formatting utilities
├── package.json
├── vite.config.ts
├── tailwind.config.js
└── tsconfig.json
```

## ⚠️ Disclaimer

This bot is for **educational purposes**. Prediction market trading carries risk.
Always start with small amounts and test thoroughly in demo mode.
The bot does NOT guarantee profits.

## 📄 License

MIT
