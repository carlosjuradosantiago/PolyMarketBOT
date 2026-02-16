// ─── Wallet Service ─────────────────────────────────────────
// Manages wallet address derivation and balance fetching

import { ethers } from "ethers";
import {
  getOrDeriveApiCredentials,
  fetchPolymarketBalance,
  ApiCredentials,
} from "./clobAuth";

// Public Polygon RPCs with CORS support (no proxy needed)
const POLYGON_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon-pokt.nodies.app",
  "https://1rpc.io/matic",
];
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174"; // USDCe on Polygon

export interface WalletBalance {
  usdc: number;
  matic: number;
}

export interface RealOrder {
  id: string;
  market: string;
  asset_id: string;
  side: string;
  price: number;
  remaining: number;
  cost: number;
  outcome: string;
}

export interface RealPosition {
  asset_id: string;
  market: string;
  marketName: string | null;
  outcome: string;
  shares: number;
  avgPrice: number;
  currentPrice: number | null;
  totalCost: number;
  currentValue: number | null;
  pnl: number | null;
}

export interface WalletInfo {
  address: string;
  balance: WalletBalance | null;        // On-chain (Polygon)
  polymarketBalance: number | null;     // USDC deposited in Polymarket
  openOrders: {
    count: number;
    totalLocked: number;
    orders: RealOrder[];
    positions: RealPosition[];
    totalPositionValue: number;
    totalPnl: number;
  } | null;
  isValid: boolean;
}

// Derive Ethereum address from private key
export function deriveAddress(privateKey: string): string | null {
  try {
    const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(key);
    return wallet.address;
  } catch (error) {
    console.error("Error deriving address:", error);
    return null;
  }
}

// Create provider with fallback RPCs (direct CORS-enabled endpoints)
function getProvider(): ethers.JsonRpcProvider {
  // Use FallbackProvider-like behavior: try first RPC
  return new ethers.JsonRpcProvider(POLYGON_RPCS[0], 137, {
    staticNetwork: true,       // Skip network detection (avoids extra RPC call)
    batchMaxCount: 1,          // No batching for simple calls
  });
}

// Fetch USDC and MATIC balance with RPC fallback
export async function fetchBalance(address: string): Promise<WalletBalance | null> {
  for (const rpcUrl of POLYGON_RPCS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl, 137, {
        staticNetwork: true,
      });

      // Get MATIC balance
      const maticBalance = await provider.getBalance(address);
      const matic = parseFloat(ethers.formatEther(maticBalance));

      // Get USDC balance via ERC20 call
      const usdcContract = new ethers.Contract(
        USDC_ADDRESS,
        ["function balanceOf(address) view returns (uint256)"],
        provider
      );

      const usdcBalance = await usdcContract.balanceOf(address);
      const usdc = parseFloat(ethers.formatUnits(usdcBalance, 6));

      console.log(`[Wallet] Balance for ${address}: ${usdc} USDC, ${matic} MATIC (via ${rpcUrl})`);
      return { usdc, matic };
    } catch (error) {
      console.warn(`[Wallet] RPC ${rpcUrl} failed, trying next...`, (error as Error).message);
    }
  }

  console.error("[Wallet] All RPC endpoints failed");
  return null;
}

// Get full wallet info from private key
export async function getWalletInfo(privateKey: string): Promise<WalletInfo> {
  const address = deriveAddress(privateKey);
  
  if (!address) {
    return {
      address: "",
      balance: null,
      polymarketBalance: null,
      openOrders: null,
      isValid: false,
    };
  }
  
  // Fetch on-chain balance and Polymarket balance in parallel
  const [balance, pmBalance] = await Promise.all([
    fetchBalance(address),
    fetchPolymarketBalanceSafe(privateKey),
  ]);
  
  return {
    address,
    balance,
    polymarketBalance: pmBalance,
    openOrders: null, // Real orders fetched via /api/wallet serverless function
    isValid: true,
  };
}

// Safely fetch Polymarket CLOB balance (never throws)
async function fetchPolymarketBalanceSafe(privateKey: string): Promise<number | null> {
  try {
    const apiCreds = await getOrDeriveApiCredentials(privateKey);
    if (!apiCreds) {
      console.warn("[Wallet] Could not get CLOB API credentials - Polymarket balance unavailable");
      return null;
    }
    
    const pmBal = await fetchPolymarketBalance(privateKey, apiCreds);
    return pmBal?.collateral ?? null;
  } catch (error) {
    console.warn("[Wallet] Polymarket balance fetch failed:", (error as Error).message);
    return null;
  }
}

// Format address for display (0x1234...abcd)
export function formatAddress(address: string): string {
  if (!address || address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}
