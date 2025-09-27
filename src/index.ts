// snipe-bot.ts
import "dotenv/config";
import { ethers } from "ethers";

/**
 * Prérequis .env :
 * RPC_WSS=wss://your-ws-rpc
 * PRIVATE_KEY=0x...
 * FACTORY_ADDRESS=0x...
 * ROUTER_ADDRESS=0x...        # Uniswap V4 Router (swap executor)
 * HOOK_ADDRESS=0x... (optionnel) # si tu veux override, sinon on lit factory.hookAddress()
 * ETH_AMOUNT_IN=0.05          # combien d'ETH en string
 *
 * Installer : npm i ethers dotenv
 * Lancer : npx ts-node snipe-bot.ts
 */

// ----------------- Minimal ABIs ----------------- //
// Factory ABI: we only need NFTStrategyLaunched event, hookAddress(), listOfRouters()
const factoryAbi = [
  // event NFTStrategyLaunched(address indexed collection, address indexed nftStrategy, string tokenName, string tokenSymbol);
  "event NFTStrategyLaunched(address indexed collection, address indexed nftStrategy, string tokenName, string tokenSymbol)",
  "function hookAddress() view returns (address)",
  "function listOfRouters(address) view returns (bool)",
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
const HOOK_OVERRIDE = process.env.HOOK_ADDRESS ?? ""; // optional
const ETH_AMOUNT_IN = process.env.ETH_AMOUNT_IN ?? "0.05"; // default 0.05 ETH

if (!RPC_WSS || !PRIVATE_KEY || !FACTORY_ADDRESS || !ROUTER_ADDRESS) {
  console.error(
    "Missing env vars. Required: RPC_WSS, PRIVATE_KEY, FACTORY_ADDRESS, ROUTER_ADDRESS"
  );
  process.exit(1);
}

// ----------------- Provider / Wallet / Contracts ----------------- //
const provider = new ethers.WebSocketProvider(RPC_WSS);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const factory = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, provider);
const router = new ethers.Contract(ROUTER_ADDRESS, routerAbi, wallet); // Reserved for future swap implementation

async function main() {
  console.log("=== Script Launch Parameters ===");
  console.log("RPC_WSS:", RPC_WSS);
  console.log(
    "PRIVATE_KEY:",
    PRIVATE_KEY ? `${PRIVATE_KEY.slice(0, 6)}...${PRIVATE_KEY.slice(-4)}` : "Not set"
  );
  console.log("FACTORY_ADDRESS:", FACTORY_ADDRESS);
  console.log("ROUTER_ADDRESS:", ROUTER_ADDRESS);
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

        // PoolKey(currency0, currency1, fee, tickSpacing, hooks)
        // CRITICAL: Currencies must be ordered by address value (currency0 < currency1)
        const ethAddress = ethers.ZeroAddress;
        const tokenAddress = nftStrategy;

        const currency0 = ethAddress < tokenAddress ? ethAddress : tokenAddress;
        const currency1 = ethAddress < tokenAddress ? tokenAddress : ethAddress;
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
        console.log("Currency ordering:", { ethAddress, tokenAddress, currency0, currency1 });

        // Prepare swap parameters
        console.log("--- Preparing Swap Parameters ---");
        const ethIn = ethers.parseEther(ETH_AMOUNT_IN); // amount of ETH to send
        const minOut = 0; // set to 0 for max agressivity; you can compute via quoter for safety
        const zeroForOne = ethAddress === currency0; // true if swapping currency0 -> currency1
        const hookData = "0x";
        const receiver = wallet.address;
        const deadline = Math.floor(Date.now() / 1000) + 60; // 60 sec

        console.log("Swap direction:", { zeroForOne, swapping: zeroForOne ? "currency0 -> currency1" : "currency1 -> currency0" });

        // Gas params - tune as needed
        const overrides = {
          value: ethIn,
          gasLimit: 1_200_000,
          // gasPrice: ethers.parseUnits("200", "gwei"), // optional: set explicit gas price if legacy RPC
        };

        console.log("Swap parameters:", {
          ethIn: ethIn.toString(),
          ethInEther: ETH_AMOUNT_IN,
          minOut,
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
          // Get gas estimate first
          try {
            const gasEstimate = await router.swapExactTokensForTokens.estimateGas(
              ethIn,
              minOut,
              zeroForOne,
              poolKey,
              hookData,
              receiver,
              deadline,
              overrides
            );
            console.log("✓ Gas estimate:", gasEstimate.toString());
          } catch (gasErr) {
            console.warn(
              "⚠ Gas estimation failed (proceeding anyway):",
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
            minOut,
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
