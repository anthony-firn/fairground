/** Opt the configured development fund into USDC when its owner funds its ALGO minimum. */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import algosdk from 'algosdk';
import { DEVELOPMENT_ADDRESS } from '../src/defaults.ts';
import { MAINNET_GENESIS_HASH, USDC_ASSET_ID } from '../src/rails/algorand.ts';

const path = homedir() + '/.config/fairground/development-wallet.json';
const algod = new algosdk.Algodv2('', 'https://mainnet-api.4160.nodely.dev', '');
const watch = process.argv.includes('--watch');
let announced = false;
while (true) {
  try {
    const account = await algod.accountInformation(DEVELOPMENT_ADDRESS!).do();
    const holding = account.assets?.find((a) => a.assetId === BigInt(USDC_ASSET_ID));
    if (holding) {
      if (holding.isFrozen) throw new Error('the fund’s USDC holding is frozen');
      console.log('Development fund is opted in and can receive USDC.');
      break;
    }
    const params = await algod.getTransactionParams().do();
    if (Buffer.from(params.genesisHash!).toString('base64') !== MAINNET_GENESIS_HASH) throw new Error('unexpected Algorand network');
    const fee = params.minFee;
    if (fee > 5000n) throw new Error('opt-in network fee is above the permitted limit');
    if (account.amount < account.minBalance + 100_000n + fee) {
      if (!announced) console.log('Waiting for the owner to fund the development wallet with ALGO; no transaction submitted.');
      announced = true;
      if (!watch) break;
    } else {
      const cfg = JSON.parse(readFileSync(path, 'utf8')) as { address: string; mnemonic: string };
      const keys = algosdk.mnemonicToSecretKey(cfg.mnemonic);
      if (cfg.address !== DEVELOPMENT_ADDRESS || keys.addr.toString() !== DEVELOPMENT_ADDRESS) throw new Error('development wallet key does not match the configured fund');
      if (account.authAddr && account.authAddr.toString() !== DEVELOPMENT_ADDRESS) throw new Error('development wallet is rekeyed');
      const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
        sender: cfg.address, receiver: cfg.address, assetIndex: USDC_ASSET_ID, amount: 0,
        suggestedParams: { ...params, flatFee: true, fee },
      });
      // This is only a zero-amount self-transfer opt-in, never a payment to another wallet.
      const sent = await algod.sendRawTransaction(txn.signTxn(keys.sk)).do();
      await algosdk.waitForConfirmation(algod, sent.txid, 8);
      console.log('Development fund USDC opt-in confirmed:', sent.txid);
      break;
    }
  } catch {
    console.error('Could not complete the development fund opt-in; no recovery information is logged.');
    if (!watch) process.exitCode = 1;
    if (!watch) break;
  }
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}
