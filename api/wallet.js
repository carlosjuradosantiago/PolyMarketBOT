// Vercel Serverless Function — Secure wallet info proxy
// The private key lives server-side only (never exposed to browser)

import { ethers } from "ethers";

const POLYGON_RPCS = [
  "https://polygon-bor-rpc.publicnode.com",
  "https://polygon-pokt.nodies.app",
  "https://1rpc.io/matic",
];
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

async function fetchBalance(address) {
  for (const rpcUrl of POLYGON_RPCS) {
    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl, 137, { staticNetwork: true });
      const maticBalance = await provider.getBalance(address);
      const matic = parseFloat(ethers.formatEther(maticBalance));

      const usdcContract = new ethers.Contract(
        USDC_ADDRESS,
        ["function balanceOf(address) view returns (uint256)"],
        provider
      );
      const usdcBalance = await usdcContract.balanceOf(address);
      const usdc = parseFloat(ethers.formatUnits(usdcBalance, 6));

      return { usdc, matic };
    } catch {
      continue;
    }
  }
  return null;
}

export default async function handler(req, res) {
  const privateKey = process.env.WALLET_PRIVATE_KEY;
  if (!privateKey) {
    return res.status(200).json({
      address: "",
      balance: null,
      polymarketBalance: null,
      isValid: false,
    });
  }

  try {
    const key = privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`;
    const wallet = new ethers.Wallet(key);
    const address = wallet.address;

    const balance = await fetchBalance(address);

    return res.status(200).json({
      address,
      balance,
      polymarketBalance: null, // CLOB auth requires complex signing, skip for now
      isValid: true,
    });
  } catch (err) {
    console.error("[Wallet] Error:", err);
    return res.status(500).json({ error: err.message });
  }
}
