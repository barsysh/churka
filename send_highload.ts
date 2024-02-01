import {
  Address,
  BitReader,
  BitString,
  Cell,
  SendMode,
  TupleReader,
  beginCell,
  external,
  internal,
  parseTuple,
  storeMessage,
  toNano,
} from "@ton/core";
import {
  KeyPair,
  getSecureRandomBytes,
  keyPairFromSeed,
  mnemonicToWalletKey,
} from "@ton/crypto";
import axios from "axios";
// import { LiteClient, LiteRoundRobinEngine, LiteSingleEngine } from 'ton-lite-client'
import { TonClient4 } from "@ton/ton";
import { execSync } from "child_process";
import fs from "fs";
import { WalletContractV4 } from "@ton/ton";
import dotenv from "dotenv";
import { givers10000, givers100, givers1000 } from "./givers";
import arg from "arg";
import {
  LiteClient,
  LiteSingleEngine,
  LiteRoundRobinEngine,
} from "ton-lite-client";
import {
  getLiteClient,
  getTon4Client,
  getTon4ClientOrbs,
  getTon4ClientTonhub,
  getTonCenterClient,
} from "./client";
import { HighloadWalletV2 } from "@scaleton/highload-wallet";
import { OpenedContract } from "@ton/core";

dotenv.config({ path: "config.txt.txt" });
dotenv.config({ path: ".env.txt" });
dotenv.config();
dotenv.config({ path: "config.txt" });

const args = arg({
  "--givers": Number, // 100 1000 10000
  "--api": String, // lite, tonhub
  "--bin": String, // cuda, opencl or path to miner
  "--gpu": Number, // gpu id, default 0
  "--timeout": Number, // Timeout for mining in seconds
  "--allow-shards": Boolean, // if true - allows mining to other shards
});

let givers = givers10000;
if (args["--givers"]) {
  const val = args["--givers"];
  const allowed = [100, 1000, 10000];
  if (!allowed.includes(val)) {
    throw new Error("Invalid --givers argument");
  }

  switch (val) {
    case 100:
      givers = givers100;
      console.log("Using givers 100");
      break;
    case 1000:
      givers = givers1000;
      console.log("Using givers 1 000");
      break;
    case 10000:
      givers = givers10000;
      console.log("Using givers 10 000");
      break;
  }
} else {
  console.log("Using givers 10 000");
}

let bin = ".\\pow-miner-cuda.exe";
if (args["--bin"]) {
  const argBin = args["--bin"];
  if (argBin === "cuda") {
    bin = ".\\pow-miner-cuda.exe";
  } else if (argBin === "opencl" || argBin === "amd") {
    bin = ".\\pow-miner-opencl.exe";
  } else {
    bin = argBin;
  }
}
console.log("Using bin", bin);

const gpu = args["--gpu"] ?? 0;
const timeout = args["--timeout"] ?? 5;

const allowShards = args["--allow-shards"] ?? false;

console.log("Using GPU", gpu);
console.log("Using timeout", timeout);

const mySeed = process.env.SEED as string;
const totalDiff = BigInt(
  "115792089237277217110272752943501742914102634520085823245724998868298727686144",
);

let bestGiver: { address: string; coins: number } = { address: "", coins: 0 };
async function updateBestGivers(
  liteClient: TonClient4 | LiteClient,
  myAddress: Address,
) {
  const whitelistGivers = allowShards
    ? [...givers]
    : givers.filter((giver) => {
        const shardMaxDepth = 1;
        const giverAddress = Address.parse(giver.address);
        const myShard = new BitReader(
          new BitString(myAddress.hash, 0, 1024),
        ).loadUint(shardMaxDepth);
        const giverShard = new BitReader(
          new BitString(giverAddress.hash, 0, 1024),
        ).loadUint(shardMaxDepth);

        if (myShard === giverShard) {
          return true;
        }

        return false;
      });
  console.log("Whitelist: ", whitelistGivers.length);

  if (liteClient instanceof TonClient4) {
    const lastInfo = await CallForSuccess(() => liteClient.getLastBlock());

    let newBestGiber: { address: string; coins: number } = {
      address: "",
      coins: 0,
    };
    await Promise.all(
      whitelistGivers.map(async (giver) => {
        const stack = await CallForSuccess(() =>
          liteClient.runMethod(
            lastInfo.last.seqno,
            Address.parse(giver.address),
            "get_pow_params",
            [],
          ),
        );
        // const powStack = Cell.fromBase64(powInfo.result as string)
        // const stack = parseTuple(powStack)

        const reader = new TupleReader(stack.result);
        const seed = reader.readBigNumber();
        const complexity = reader.readBigNumber();
        const iterations = reader.readBigNumber();

        const hashes = totalDiff / complexity;
        const coinsPerHash = giver.reward / Number(hashes);
        if (coinsPerHash > newBestGiber.coins) {
          newBestGiber = { address: giver.address, coins: coinsPerHash };
        }
      }),
    );
    bestGiver = newBestGiber;
  } else if (liteClient instanceof LiteClient) {
    const lastInfo = await liteClient.getMasterchainInfo();

    let newBestGiber: { address: string; coins: number } = {
      address: "",
      coins: 0,
    };
    await Promise.all(
      whitelistGivers.map(async (giver) => {
        const powInfo = await liteClient.runMethod(
          Address.parse(giver.address),
          "get_pow_params",
          Buffer.from([]),
          lastInfo.last,
        );
        const powStack = Cell.fromBase64(powInfo.result as string);
        const stack = parseTuple(powStack);

        const reader = new TupleReader(stack);
        const seed = reader.readBigNumber();
        const complexity = reader.readBigNumber();
        const iterations = reader.readBigNumber();

        const hashes = totalDiff / complexity;
        const coinsPerHash = giver.reward / Number(hashes);
        if (coinsPerHash > newBestGiber.coins) {
          newBestGiber = { address: giver.address, coins: coinsPerHash };
        }
      }),
    );
    bestGiver = newBestGiber;
  }
}

async function getPowInfo(
  liteClient: TonClient4 | LiteClient,
  address: Address,
): Promise<[bigint, bigint, bigint]> {
  if (liteClient instanceof TonClient4) {
    const lastInfo = await CallForSuccess(() => liteClient.getLastBlock());
    const powInfo = await CallForSuccess(() =>
      liteClient.runMethod(lastInfo.last.seqno, address, "get_pow_params", []),
    );

    const reader = new TupleReader(powInfo.result);
    const seed = reader.readBigNumber();
    const complexity = reader.readBigNumber();
    const iterations = reader.readBigNumber();

    return [seed, complexity, iterations];
  } else if (liteClient instanceof LiteClient) {
    const lastInfo = await liteClient.getMasterchainInfo();
    const powInfo = await liteClient.runMethod(
      address,
      "get_pow_params",
      Buffer.from([]),
      lastInfo.last,
    );
    const powStack = Cell.fromBase64(powInfo.result as string);
    const stack = parseTuple(powStack);

    const reader = new TupleReader(stack);
    const seed = reader.readBigNumber();
    const complexity = reader.readBigNumber();
    const iterations = reader.readBigNumber();

    return [seed, complexity, iterations];
  }

  throw new Error("invalid client");
}

let go = true;
let i = 0;
let liteClient: TonClient4 | LiteClient;
async function main() {
  liteClient = await getLiteClient(
    "https://gist.githubusercontent.com/barsysh/9f719bca956492111b6e5861f0e3ea3a/raw/d99e5746b2611d85f0e8cfff34f48e2fe4c16467/broken.json",
  );
  const keyPair = await mnemonicToWalletKey(mySeed.split(" "));

  const wallet = new HighloadWalletV2(keyPair.publicKey, 0, 1);
  const w4PrizeDestionation = WalletContractV4.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
  });

  console.log(
    "Using highload wallet",
    wallet.address.toString({ bounceable: false, urlSafe: true }),
  );
  console.log(
    "Prize destination: ",
    w4PrizeDestionation.address.toString({ urlSafe: true, bounceable: true }),
  );

  await updateBestGivers(liteClient, wallet.address);

  setInterval(() => {
    updateBestGivers(liteClient, wallet.address);
  }, 1000);

  while (go) {
    const giverAddress = bestGiver.address;
    const [seed, complexity, iterations] = await getPowInfo(
      liteClient,
      Address.parse(giverAddress),
    );

    const randomName = (await getSecureRandomBytes(8)).toString("hex") + ".boc";
    const path = `bocs/${randomName}`;
    const command = `${bin} -g ${gpu} -F 128 -t ${timeout} ${w4PrizeDestionation.address.toString({ urlSafe: true, bounceable: true })} ${seed} ${complexity} ${iterations} ${giverAddress} ${path}`;
    try {
      const output = execSync(command, { encoding: "utf-8", stdio: "pipe" }); // the default is 'buffer'
    } catch (e) {}
    let mined: Buffer | undefined = undefined;
    try {
      mined = fs.readFileSync(path);
      fs.rmSync(path);
    } catch (e) {
      //
    }
    if (!mined) {
      console.log(`${new Date()}: not mined`, seed, i++);
    }
    if (mined) {
      const [newSeed] = await getPowInfo(
        liteClient,
        Address.parse(giverAddress),
      );
      if (newSeed !== seed) {
        console.log("Mined already too late seed");
        continue;
      }

      console.log(`${new Date()}:     mined`, seed, i++);

      sendMinedBoc(
        wallet,
        keyPair,
        giverAddress,
        Cell.fromBoc(mined as Buffer)[0]
          .asSlice()
          .loadRef(),
      );
    }
  }
}
main();

async function sendMinedBoc(
  wallet: HighloadWalletV2,
  keyPair: KeyPair,
  giverAddress: string,
  boc: Cell,
) {
  const wall = liteClient.open(wallet);

  const now = BigInt(Math.floor(Date.now() / 1000)) << BigInt(33);
  for (let i = 0; i < 10; i++) {
    wall.sendTransfer({
      queryId: now,
      messages: [
        [
          internal({
            to: giverAddress,
            value: toNano("0.05"),
            bounce: true,
            body: boc,
          }),
          SendMode.NONE,
        ],
      ],
      secretKey: keyPair.secretKey,
    });
  }
}

// Function to call ton api untill we get response.
// Because testnet is pretty unstable we need to make sure response is final
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function CallForSuccess<T extends (...args: any[]) => any>(
  toCall: T,
  attempts = 20,
  delayMs = 100,
): Promise<ReturnType<T>> {
  if (typeof toCall !== "function") {
    throw new Error("unknown input");
  }

  let i = 0;
  let lastError: unknown;

  while (i < attempts) {
    try {
      const res = await toCall();
      return res;
    } catch (err) {
      lastError = err;
      i++;
      await delay(delayMs);
    }
  }

  console.log("error after attempts", i);
  throw lastError;
}

export function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
