// snipe-bot.ts
import "dotenv/config";
import { ethers } from "ethers";

/**
 * Required .env variables:
 * RPC_WSS=wss://your-ws-rpc
 * PRIVATE_KEY=0x...
 * FACTORY_ADDRESS=0x...
 * RANGE_FACTORY_ADDRESS=0x...
 * ROUTER_ADDRESS=0x...           # Uniswap V4 Router (swap executor)
 * POOL_MANAGER_ADDRESS=0x...     # Uniswap V4 Pool Manager (for pool existence check)
 * ETH_AMOUNT_IN=0.05            # amount of ETH to snipe with (recommended ≤0.05 for fast mode)
 * SNIPE_MODE=fast               # "fast" (max speed, high risk) or "safe" (slower, safer)
 *
 * Modes:
 * - fast: No checks, immediate execution, 2x gas price, minOut=0 (⚡ SPEED)
 * - safe: Pool checks, simulation, slippage protection, longer deadline (🛡️ SAFETY)
 *
 * Install: npm i ethers dotenv
 * Run: npx ts-node src/index.ts
 */

// ----------------- Minimal ABIs ----------------- //
// Factory ABI: we only need NFTStrategyLaunched event, hookAddress(), listOfRouters()
const factoryAbi = [
  "event NFTStrategyLaunched(address indexed collection, address indexed nftStrategy, string tokenName, string tokenSymbol)",
  "function hookAddress() view returns (address)",
  "function listOfRouters(address) view returns (bool)",
];

// Additional ABI for Range factory
const rangeFactoryAbi = [
  "event NFTStrategyRangeLaunched(address indexed collection, address indexed nftStrategy, uint256 lowTokenId, uint256 highTokenId, string tokenName, string tokenSymbol)",
  "function hookAddress() view returns (address)",
  "function listOfRouters(address) view returns (bool)",
];

// Pool Manager ABI for checking pool existence
const poolManagerAbi = [
  "function getSlot0(tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
];

// Router ABI matching the actual contract interface
const routerAbi = [
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, bool zeroForOne, tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bytes hookData, address receiver, uint256 deadline) payable returns (tuple(int128 amount0, int128 amount1))",
];

// ERC20 minimal for Transfer event
const erc20Abi = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function decimals() view returns (uint8)",
];

// ----------------- Config / env ----------------- //
const RPC_WSS = process.env.RPC_WSS ?? "";
const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS ?? "";
const RANGE_FACTORY_ADDRESS = process.env.RANGE_FACTORY_ADDRESS ?? "";
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS ?? "";
const POOL_MANAGER_ADDRESS = process.env.POOL_MANAGER_ADDRESS ?? "";
const ETH_AMOUNT_IN = process.env.ETH_AMOUNT_IN ?? "0.05"; // default 0.05 ETH
const SNIPE_MODE = process.env.SNIPE_MODE ?? "fast"; // "fast" or "safe"

if (!RPC_WSS || !PRIVATE_KEY || !FACTORY_ADDRESS || !ROUTER_ADDRESS || !POOL_MANAGER_ADDRESS) {
  console.error(
    "Missing env vars. Required: RPC_WSS, PRIVATE_KEY, FACTORY_ADDRESS, ROUTER_ADDRESS, POOL_MANAGER_ADDRESS"
  );
  process.exit(1);
}

// ----------------- Provider / Wallet / Contracts ----------------- //
const provider = new ethers.WebSocketProvider(RPC_WSS);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const factory = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, provider);
const rangeFactory = new ethers.Contract(RANGE_FACTORY_ADDRESS, rangeFactoryAbi, provider);
const router = new ethers.Contract(ROUTER_ADDRESS, routerAbi, wallet);
const poolManager = new ethers.Contract(POOL_MANAGER_ADDRESS, poolManagerAbi, provider);

// Shared handler
async function handleLaunch(
  nftStrategy: string,
  tokenName: string,
  tokenSymbol: string,
  getHookAddress: () => Promise<string>
) {
  console.log("🚀 New token launch detected:", nftStrategy, tokenName, tokenSymbol);
  console.log("=== NFTStrategyLaunched ===");
  // console.log("collection:", collection);
  console.log("token (nftStrategy):", nftStrategy);
  console.log("name / symb:", tokenName, tokenSymbol);
  // console.log("txHash:", ev.transactionHash);
  // console.log("blockNumber:", ev.blockNumber);
  console.log("timestamp:", new Date().toISOString());

  // Build deterministic PoolKey as in factory
  console.log("--- Building PoolKey ---");
  let hooks: string;
  try {
    hooks = await getHookAddress();
    console.log("✓ Hook address resolved:", hooks);
  } catch (err) {
    console.error("✗ Failed to get hook address:", err);
    console.error("Hook address error details:", {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
      factoryAddress: FACTORY_ADDRESS,
    });
    return;
  }

  // PoolKey construction for ETH -> Token sniping
  // Since we're always trading ETH (0x0) -> Token, and 0x0 < any token address:
  // currency0 = ETH, currency1 = Token, zeroForOne = true
  console.log("--- Building PoolKey for ETH -> Token ---");
  const currency0 = ethers.ZeroAddress; // ETH (always currency0 since 0x0 < any address)
  const currency1 = nftStrategy; // Token (always currency1)
  const fee = 0; // uint24
  const tickSpacing = 60; // int24

  const poolKey = {
    currency0,
    currency1,
    fee,
    tickSpacing,
    hooks,
  };

  console.log("✓ PoolKey built:", poolKey);

  // Prepare basic swap parameters
  const ethIn = ethers.parseEther(ETH_AMOUNT_IN);
  const zeroForOne = true; // Always true for ETH -> Token
  const hookData = "0x";
  const receiver = wallet.address;

  // Get dynamic gas pricing
  console.log("--- Getting Network Fee Data ---");
  const feeData = await provider.getFeeData();
  const gasPrice = (feeData.gasPrice ?? ethers.parseUnits("50", "gwei")) * 2n; // 2x base fee for priority
  console.log(
    "Network base gas price:",
    ethers.formatUnits(feeData.gasPrice ?? 0n, "gwei"),
    "gwei"
  );
  console.log("Using priority gas price:", ethers.formatUnits(gasPrice, "gwei"), "gwei");

  if (SNIPE_MODE === "safe") {
    console.log("🛡️ SAFE MODE: Running checks and simulation for safer sniping");

    // Safe mode: Check pool exists
    try {
      const slot0 = (await poolManager.getSlot0(poolKey)) as {
        sqrtPriceX96: bigint;
        tick: bigint;
        protocolFee: bigint;
        lpFee: bigint;
      };
      console.log("✓ Pool exists! Price:", slot0.sqrtPriceX96.toString());
    } catch (err: unknown) {
      console.error("✗ Pool does not exist, skipping swap", err);
      return;
    }

    // Safe mode: Simulate swap for minOut
    let minOut = 0n;
    const deadline = Math.floor(Date.now() / 1000) + 180; // Longer deadline
    try {
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const result = await router.swapExactTokensForTokens.staticCall(
        ethIn,
        0,
        zeroForOne,
        poolKey,
        hookData,
        receiver,
        deadline,
        { value: ethIn }
      );
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
      const amount1Delta = result[1] as bigint;
      const tokensOut = amount1Delta > 0 ? amount1Delta : -amount1Delta;
      minOut = (tokensOut * 90n) / 100n; // 10% slippage
      console.log("✓ Simulated minOut with 10% slippage:", minOut.toString());
    } catch {
      console.warn("⚠ Simulation failed, using minOut = 0");
    }

    const overrides = {
      value: ethIn,
      gasLimit: 1_500_000,
      gasPrice,
    };

    console.log(`🛡️ SAFE SNIPING: ${ETH_AMOUNT_IN} ETH -> ${nftStrategy}`);

    try {
      const tx = (await router.swapExactTokensForTokens(
        ethIn,
        minOut,
        zeroForOne,
        poolKey,
        hookData,
        receiver,
        deadline,
        overrides
      )) as ethers.TransactionResponse;

      console.log("✓ Safe swap tx submitted:", tx.hash);
      const receipt = await tx.wait();
      if (receipt) {
        console.log("✓ Safe swap confirmed! Block:", receipt.blockNumber);
      }
    } catch (err) {
      console.error("✗ Safe swap failed:", err instanceof Error ? err.message : String(err));
    }
  } else {
    console.log("🚀 FAST MODE: Maximum speed sniping (high risk)");

    // Validate ETH amount for fast mode
    const ethAmount = parseFloat(ETH_AMOUNT_IN);
    if (ethAmount > 0.1) {
      console.warn(`⚠️ WARNING: Using ${ETH_AMOUNT_IN} ETH in FAST mode (no slippage protection)`);
      console.warn("💡 Consider using smaller amounts (≤0.05 ETH) or SAFE mode for larger amounts");
    }

    const minOut = 0n; // Accept any amount for max speed
    const deadline = Math.floor(Date.now() / 1000) + 60; // Short deadline

    const overrides = {
      value: ethIn,
      gasLimit: 2_000_000, // High gas limit to avoid failures
      gasPrice, // Dynamic priority pricing
    };

    console.log(`🚀 FAST SNIPING: ${ETH_AMOUNT_IN} ETH -> ${nftStrategy}`);

    try {
      const tx = (await router.swapExactTokensForTokens(
        ethIn,
        minOut,
        zeroForOne,
        poolKey,
        hookData,
        receiver,
        deadline,
        overrides
      )) as ethers.TransactionResponse;

      console.log("🚀 Fast swap tx submitted:", tx.hash);
      const receipt = await tx.wait();
      if (receipt) {
        console.log("🎉 Fast swap confirmed! Block:", receipt.blockNumber);
      }
    } catch (err) {
      console.error("✗ Fast swap failed:", err instanceof Error ? err.message : String(err));
    }
  }

  console.log("=== NFTStrategyLaunched END ===");
}

async function main() {
  console.log("=== Script Launch Parameters ===");
  console.log("RPC_WSS:", RPC_WSS);
  console.log(
    "PRIVATE_KEY:",
    PRIVATE_KEY ? `${PRIVATE_KEY.slice(0, 6)}...${PRIVATE_KEY.slice(-4)}` : "Not set"
  );
  console.log("FACTORY_ADDRESS:", FACTORY_ADDRESS);
  console.log("RANGE_FACTORY_ADDRESS:", RANGE_FACTORY_ADDRESS);
  console.log("ROUTER_ADDRESS:", ROUTER_ADDRESS);
  console.log("POOL_MANAGER_ADDRESS:", POOL_MANAGER_ADDRESS);
  console.log("ETH_AMOUNT_IN:", ETH_AMOUNT_IN);
  console.log("SNIPE_MODE:", SNIPE_MODE);
  console.log("================================");

  // try {
  //   console.log("Listening for Meebit Token Transfer events...");
  //   const meebitStrategy = "0xC9b2c00f31B210FCea1242D91307A5B1e3b2Be68";
  //   const meebitToken = new ethers.Contract(meebitStrategy, erc20Abi, provider);
  //   void meebitToken.on("Transfer", (from: string, to: string, value: bigint) => {
  //     console.log(`[Meebit Token Transfer] from ${from} -> ${to} amount ${value.toString()}`);
  //   });
  // } catch (err) {
  //   console.warn("Could not attach Meebit Token Transfer listener:", err);
  // }

  console.log("Connected to provider:", await provider.getNetwork().then((n) => n.name));
  console.log("Wallet:", wallet.address);
  try {
    // read hookAddress from factory unless overridden
    const hookAddr = (await factory.hookAddress()) as string;
    console.log("Hook address:", hookAddr);

    // quick check: is router whitelisted in factory?
    try {
      const isRouterValid = (await factory.listOfRouters(ROUTER_ADDRESS)) as boolean;
      console.log("Router whitelisted in factory?", isRouterValid);
    } catch {
      console.warn("Could not read listOfRouters (maybe ABI mismatch). Continuing anyway.");
    }
  } catch (err) {
    console.error("Error reading factory:", err);
  }

  console.log("Listening for NFTStrategyLaunched & NFTStrategyRangeLaunched events...");

  // Listen for launches
  void factory.on(
    "NFTStrategyLaunched",
    (
      collection: string,
      nftStrategy: string,
      tokenName: string,
      tokenSymbol: string,
      ev: ethers.EventLog
    ) => {
      console.log("NFTStrategyLaunched event received:", ev);
      console.log("collection:", collection);
      console.log("nftStrategy:", nftStrategy);
      console.log("tokenName:", tokenName);
      console.log("tokenSymbol:", tokenSymbol);
      void handleLaunch(nftStrategy, tokenName, tokenSymbol, () => factory.hookAddress());
    }
  );

  void rangeFactory.on(
    "NFTStrategyRangeLaunched",
    (
      collection: string,
      nftStrategy: string,
      lowTokenId: bigint,
      highTokenId: bigint,
      tokenName: string,
      tokenSymbol: string,
      ev: ethers.EventLog
    ) => {
      console.log("NFTStrategyRangeLaunched event received:", ev);
      console.log(`Range: ${lowTokenId} - ${highTokenId}`);
      console.log("collection:", collection);
      console.log("nftStrategy:", nftStrategy);
      console.log("tokenName:", tokenName);
      console.log("tokenSymbol:", tokenSymbol);
      void handleLaunch(nftStrategy, tokenName, tokenSymbol, () => rangeFactory.hookAddress());
    }
  );

  // handle provider errors & reconnect (basic)
  const wsProvider = provider as ethers.WebSocketProvider & {
    websocket?: { on: (event: string, handler: (code: number) => void) => void };
  };
  wsProvider.websocket?.on("close", (code: number) => {
    console.error("WebSocket closed, code:", code, "exiting. Use a process manager to restart.");
    process.exit(1);
  });
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
