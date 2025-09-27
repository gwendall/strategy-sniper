import "dotenv/config";
import { ethers } from "ethers";

const fullInput = process.env.FACTORY_DEPLOY_DATA as string;
if (!fullInput?.startsWith("0x")) {
  throw new Error("Missing FACTORY_DEPLOY_DATA in .env");
}

// Slice the last 6 * 32 bytes (addresses)
const argsData = "0x" + fullInput.slice(fullInput.length - 64 * 6);

// Constructor types
const types = ["address", "address", "address", "address", "address", "address"];

const decoded = ethers.AbiCoder.defaultAbiCoder().decode(types, argsData);

console.log("posm           :", decoded[0]);
console.log("permit2        :", decoded[1]);
console.log("poolManager    :", decoded[2]);
console.log("universalRouter:", decoded[3]);
console.log("router         :", decoded[4]);
console.log("feeAddress     :", decoded[5]);
