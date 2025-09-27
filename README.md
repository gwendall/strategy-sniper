# Strategy Sniper

NFT Strategy Sniper Bot for monitoring and trading NFT strategy launches on Ethereum.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Create `.env` file:
```bash
cp .env.example .env
```

3. Configure your environment variables in `.env`:
- `RPC_WSS`: WebSocket RPC endpoint
- `PRIVATE_KEY`: Your wallet private key
- `FACTORY_ADDRESS`: Factory contract address
- `ROUTER_ADDRESS`: Uniswap V4 Router address
- `HOOK_ADDRESS`: (Optional) Hook address override
- `ETH_AMOUNT_IN`: Amount of ETH for swaps (default: 0.05)

## Usage

### Development mode (with TypeScript):
```bash
npm run dev
```

### Production mode (compiled JavaScript):
```bash
npm run build
npm start
```

### Watch mode (auto-recompile on changes):
```bash
npm run watch
```

## Scripts

- `npm run build` - Compile TypeScript to JavaScript
- `npm start` - Run the compiled JavaScript
- `npm run dev` - Run TypeScript directly with ts-node
- `npm run watch` - Watch for changes and recompile
- `npm run clean` - Remove build output

## Features

- Monitors NFTStrategyLaunched events from factory contract
- Tracks token transfers for newly launched strategies
- WebSocket connection with automatic error handling
- TypeScript for type safety
- Environment variable configuration