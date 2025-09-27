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

// Router ABI (minimal) — signature used in factory:
// swapExactTokensForTokens(uint256 amountIn, uint256 minAmountOut, bool exactIn, (address,address,uint24,int24,address) key, bytes hookData, address recipient, uint256 deadline) payable
// const routerAbi = [
//     "function swapExactTokensForTokens(uint256 amountIn, uint256 minAmountOut, bool exactIn, tuple(address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) key, bytes hookData, address recipient, uint256 deadline) payable returns (uint256 amountOut)",
// ]; // Reserved for future swap implementation

// ERC20 minimal for Transfer event
const erc20Abi = [
    "event Transfer(address indexed from, address indexed to, uint256 value)",
    "function decimals() view returns (uint8)",
];

// ----------------- Config / env ----------------- //
const RPC_WSS = process.env.RPC_WSS || "";
const PRIVATE_KEY = process.env.PRIVATE_KEY || "";
const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS || "";
const ROUTER_ADDRESS = process.env.ROUTER_ADDRESS || "";
const HOOK_OVERRIDE = process.env.HOOK_ADDRESS || ""; // optional
// const ETH_AMOUNT_IN = process.env.ETH_AMOUNT_IN || "0.05"; // default 0.05 ETH - reserved for future use

if (!RPC_WSS || !PRIVATE_KEY || !FACTORY_ADDRESS || !ROUTER_ADDRESS) {
    console.error("Missing env vars. Required: RPC_WSS, PRIVATE_KEY, FACTORY_ADDRESS, ROUTER_ADDRESS");
    process.exit(1);
}

// ----------------- Provider / Wallet / Contracts ----------------- //
const provider = new ethers.WebSocketProvider(RPC_WSS);
const wallet = new ethers.Wallet(PRIVATE_KEY, provider);
const factory = new ethers.Contract(FACTORY_ADDRESS, factoryAbi, provider);
// const router = new ethers.Contract(ROUTER_ADDRESS, routerAbi, wallet); // Reserved for future swap implementation

async function main() {
    console.log("Connected to provider:", await provider.getNetwork().then(n => n.name));
    console.log("Wallet:", wallet.address);
    try {
        // read hookAddress from factory unless overridden
        const hookAddr = HOOK_OVERRIDE || (await factory.hookAddress());
        console.log("Hook address:", hookAddr);

        // quick check: is router whitelisted in factory?
        try {
            const isRouterValid = await factory.listOfRouters(ROUTER_ADDRESS);
            console.log("Router whitelisted in factory?", isRouterValid);
        } catch (err) {
            console.warn("Could not read listOfRouters (maybe ABI mismatch). Continuing anyway.");
        }

    } catch (err) {
        console.error("Error reading factory:", err);
    }

    console.log("Listening for NFTStrategyLaunched events...");

    // Listen for launches
    factory.on("NFTStrategyLaunched", async (collection: string, nftStrategy: string, tokenName: string, tokenSymbol: string, ev: ethers.EventLog) => {
        console.log("=== NFTStrategyLaunched ===");
        console.log("collection:", collection);
        console.log("token (nftStrategy):", nftStrategy);
        console.log("name / symb:", tokenName, tokenSymbol);
        console.log("txHash:", ev.transactionHash);

        // debug: attach Transfer listener to token (to see incoming tokens)
        try {
            const token = new ethers.Contract(nftStrategy, erc20Abi, provider);
            token.on("Transfer", (from: string, to: string, value: bigint) => {
                console.log(`[Token Transfer] from ${from} -> ${to} amount ${value.toString()}`);
            });
        } catch (err) {
            console.warn("Could not attach token Transfer listener:", err);
        }
        console.log("=== NFTStrategyLaunched END ===");

    });

    // handle provider errors & reconnect (basic)
    const wsProvider = provider as ethers.WebSocketProvider & { websocket?: { on: (event: string, handler: (code: number) => void) => void } };
    wsProvider.websocket?.on("close", (code: number) => {
        console.error("WebSocket closed, code:", code, "exiting. Use a process manager to restart.");
        process.exit(1);
    });
}

main().catch(e => {
    console.error("Fatal error:", e);
    process.exit(1);
});
