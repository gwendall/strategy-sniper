// snipe-bot.ts
import "dotenv/config";
import { ethers } from "ethers";

/**
 * Required .env variables:
 * RPC_WSS=wss://your-ws-rpc
 * PRIVATE_KEY=0x...
 * FACTORY_ADDRESS=0x...
 * ROUTER_ADDRESS=0x...           # Uniswap V4 Router (swap executor)
 * POOL_MANAGER_ADDRESS=0x...     # Uniswap V4 Pool Manager (for pool existence check)
 * HOOK_ADDRESS=0x... (optional) # override hook address, otherwise reads from factory
 * ETH_AMOUNT_IN=0.05            # amount of ETH to snipe with (as string)
 *
 * Install: npm i ethers dotenv
 * Run: npx ts-node src/index.ts
 */

// ----------------- Minimal ABIs ----------------- //
// Factory ABI: we only need NFTStrategyLaunched event, hookAddress(), listOfRouters()
const factoryAbi = [
  // event NFTStrategyLaunched(address indexed collection, address indexed nftStrategy, string tokenName, string tokenSymbol);
  "event NFTStrategyLaunched(address indexed collection, address indexed nftStrategy, string tokenName, string tokenSymbol)",
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
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS ?? "";
const POOL_MANAGER_ADDRESS = process.env.POOL_MANAGER_ADDRESS ?? "";
const HOOK_OVERRIDE = process.env.HOOK_ADDRESS ?? ""; // optional
const ETH_AMOUNT_IN = process.env.ETH_AMOUNT_IN ?? "0.05"; // default 0.05 ETH

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
const router = new ethers.Contract(ROUTER_ADDRESS, routerAbi, wallet);
const poolManager = new ethers.Contract(POOL_MANAGER_ADDRESS, poolManagerAbi, provider);

async function main() {
  console.log("=== Script Launch Parameters ===");
  console.log("RPC_WSS:", RPC_WSS);
  console.log(
    "PRIVATE_KEY:",
    PRIVATE_KEY ? `${PRIVATE_KEY.slice(0, 6)}...${PRIVATE_KEY.slice(-4)}` : "Not set"
  );
  console.log("FACTORY_ADDRESS:", FACTORY_ADDRESS);
  console.log("ROUTER_ADDRESS:", ROUTER_ADDRESS);
  console.log("POOL_MANAGER_ADDRESS:", POOL_MANAGER_ADDRESS);
  console.log("HOOK_OVERRIDE:", HOOK_OVERRIDE || "Not set");
  console.log("ETH_AMOUNT_IN:", ETH_AMOUNT_IN);
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
    const hookAddr = HOOK_OVERRIDE || ((await factory.hookAddress()) as string);
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

  console.log("Listening for NFTStrategyLaunched events...");

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
      void (async () => {
        console.log("=== NFTStrategyLaunched ===");
        console.log("collection:", collection);
        console.log("token (nftStrategy):", nftStrategy);
        console.log("name / symb:", tokenName, tokenSymbol);
        console.log("txHash:", ev.transactionHash);
        console.log("blockNumber:", ev.blockNumber);
        console.log("timestamp:", new Date().toISOString());

        // debug: attach Transfer listener to token (to see incoming tokens)
        try {
          const token = new ethers.Contract(nftStrategy, erc20Abi, provider);
          void token.on("Transfer", (from: string, to: string, value: bigint) => {
            console.log(`[Token Transfer] from ${from} -> ${to} amount ${value.toString()}`);
          });
          console.log("✓ Token Transfer listener attached successfully");
        } catch (err) {
          console.error("✗ Failed to attach token Transfer listener:", err);
          console.error("Transfer listener error details:", {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            nftStrategy,
          });
        }

        // Build deterministic PoolKey as in factory
        console.log("--- Building PoolKey ---");
        let hooks: string;
        try {
          hooks = HOOK_OVERRIDE || ((await factory.hookAddress()) as string);
          console.log("✓ Hook address resolved:", hooks);
        } catch (err) {
          console.error("✗ Failed to get hook address:", err);
          console.error("Hook address error details:", {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            HOOK_OVERRIDE,
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

        // Check if pool exists before attempting swap
        console.log("--- Checking Pool Existence ---");
        try {
          const slot0 = (await poolManager.getSlot0(poolKey)) as {
            sqrtPriceX96: bigint;
            tick: bigint;
            protocolFee: bigint;
            lpFee: bigint;
          };
          console.log("✓ Pool exists! Slot0:", {
            sqrtPriceX96: slot0.sqrtPriceX96.toString(),
            tick: slot0.tick.toString(),
            protocolFee: slot0.protocolFee.toString(),
            lpFee: slot0.lpFee.toString(),
          });
        } catch (err) {
          console.error("✗ Pool does not exist or failed to get slot0:", err);
          console.error("Pool check error details:", {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            poolKey,
          });
          console.error("⚠ Skipping swap - pool not found");
          return;
        }

        // Prepare swap parameters
        console.log("--- Preparing Swap Parameters ---");
        const ethIn = ethers.parseEther(ETH_AMOUNT_IN); // amount of ETH to send
        const zeroForOne = true; // Always true for ETH -> Token (currency0 -> currency1)
        const hookData = "0x";
        const receiver = wallet.address;
        const deadline = Math.floor(Date.now() / 1000) + 180; // 3 minutes for production safety

        console.log("✓ Swap direction: ETH (currency0) -> Token (currency1)");

        // Simulate swap to get expected output and calculate safe minOut
        console.log("--- Simulating Swap for minOut Calculation ---");
        let minOut = 0n;
        try {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          const result = await router.swapExactTokensForTokens.staticCall(
            ethIn,
            0, // simulate with 0 minOut first
            zeroForOne,
            poolKey,
            hookData,
            receiver,
            deadline,
            { value: ethIn }
          );

          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          const amount0Delta = result[0] as bigint;
          // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access
          const amount1Delta = result[1] as bigint;

          console.log("Swap simulation result:", {
            amount0Delta: amount0Delta.toString(),
            amount1Delta: amount1Delta.toString(),
          });

          // For ETH -> Token swap (zeroForOne = true):
          // amount0Delta = negative (ETH out)
          // amount1Delta = positive (tokens in)
          const tokensOut = amount1Delta > 0 ? amount1Delta : -amount1Delta;
          minOut = (tokensOut * 90n) / 100n; // 10% slippage tolerance

          console.log("✓ Calculated minOut with 10% slippage:", minOut.toString());
        } catch (simErr) {
          console.warn(
            "⚠ Swap simulation failed, using minOut = 0 (no slippage protection):",
            simErr instanceof Error ? simErr.message : String(simErr)
          );
          minOut = 0n;
        }

        // Gas params - tune as needed
        const overrides = {
          value: ethIn,
          gasLimit: 1_200_000,
          // gasPrice: ethers.parseUnits("200", "gwei"), // optional: set explicit gas price if legacy RPC
        };

        console.log("Swap parameters:", {
          ethIn: ethIn.toString(),
          ethInEther: ETH_AMOUNT_IN,
          minOut: minOut.toString(),
          zeroForOne,
          receiver,
          deadline,
          overrides,
          routerAddress: ROUTER_ADDRESS,
        });

        // Check wallet balance before swap
        try {
          const balance = await provider.getBalance(wallet.address);
          console.log("Wallet ETH balance:", ethers.formatEther(balance), "ETH");
          if (balance < ethIn) {
            console.error("✗ Insufficient ETH balance!");
            console.error("Required:", ethers.formatEther(ethIn), "ETH");
            console.error("Available:", ethers.formatEther(balance), "ETH");
            return;
          }
        } catch (err) {
          console.error("✗ Failed to check wallet balance:", err);
          console.error("Balance check error details:", {
            message: err instanceof Error ? err.message : String(err),
            stack: err instanceof Error ? err.stack : undefined,
            walletAddress: wallet.address,
          });
        }

        console.log(`--- Executing Swap ---`);
        console.log(
          `Attempting swap: send ${ETH_AMOUNT_IN} ETH -> token ${nftStrategy} via router ${ROUTER_ADDRESS}`
        );

        try {
          // Get gas estimate first (correct ethers v6 syntax)
          try {
            const gasEstimate = await router.swapExactTokensForTokens.estimateGas(
              ethIn,
              minOut,
              zeroForOne,
              poolKey,
              hookData,
              receiver,
              deadline,
              { value: ethIn }
            );
            console.log("✓ Gas estimate:", gasEstimate.toString());

            // Update gas limit based on estimate with 20% buffer
            overrides.gasLimit = Number((gasEstimate * 120n) / 100n);
            console.log("Updated gas limit with 20% buffer:", overrides.gasLimit.toString());
          } catch (gasErr) {
            console.warn(
              "⚠ Gas estimation failed (proceeding with default gas limit):",
              gasErr instanceof Error ? gasErr.message : String(gasErr)
            );
          }

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

          console.log("✓ Swap tx submitted:", tx.hash);
          console.log("Transaction details:", {
            hash: tx.hash,
            from: tx.from,
            to: tx.to,
            value: tx.value?.toString(),
            gasLimit: tx.gasLimit?.toString(),
            gasPrice: tx.gasPrice?.toString(),
            nonce: tx.nonce,
          });

          console.log("Waiting for transaction confirmation...");
          const receipt = await tx.wait();
          if (!receipt) {
            console.error("✗ Transaction receipt is null");
            return;
          }

          console.log("✓ Swap confirmed!");
          console.log("Receipt details:", {
            blockNumber: receipt.blockNumber,
            blockHash: receipt.blockHash,
            gasUsed: receipt.gasUsed?.toString(),
            status: receipt.status,
            logs: receipt.logs.length,
          });

          // Parse the return value from the transaction logs to see actual swap amounts
          try {
            // Look for the Swap event or similar in the logs to get actual amounts
            // For now, just log that the swap succeeded
            console.log("🎉 Sniping successful! Tokens acquired.");

            // Calculate gas cost
            if (receipt.gasUsed && tx.gasPrice) {
              const gasCost = receipt.gasUsed * tx.gasPrice;
              console.log("Gas cost:", ethers.formatEther(gasCost), "ETH");
            }
          } catch (parseErr) {
            console.warn("Could not parse swap results from logs:", parseErr);
          }

          // Log any events in the receipt
          if (receipt.logs.length > 0) {
            console.log("Transaction logs:");
            receipt.logs.forEach((log, index) => {
              console.log(`Log ${index}:`, {
                address: log.address,
                topics: log.topics,
                data: log.data,
              });
            });
          }
        } catch (err) {
          console.error("✗ Swap failed!");
          console.error("Error message:", err instanceof Error ? err.message : String(err));
          console.error("Error stack:", err instanceof Error ? err.stack : undefined);

          // Log additional error context
          if (err instanceof Error) {
            const errorDetails: Record<string, unknown> = {
              name: err.name,
              message: err.message,
            };

            if ("code" in err) errorDetails.code = err.code;
            if ("reason" in err) errorDetails.reason = err.reason;
            if ("transaction" in err) errorDetails.transaction = err.transaction;
            if ("receipt" in err) errorDetails.receipt = err.receipt;

            console.error("Error details:", errorDetails);
          }

          console.error("Swap context when error occurred:", {
            ethIn: ethIn.toString(),
            minOut: minOut.toString(),
            zeroForOne,
            poolKey,
            hookData,
            receiver,
            deadline,
            overrides,
            routerAddress: ROUTER_ADDRESS,
            walletAddress: wallet.address,
            timestamp: new Date().toISOString(),
          });
        }

        console.log("=== NFTStrategyLaunched END ===");
      })();
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
