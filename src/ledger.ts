// Based on source from:
// https://github.com/web3modal/ledger-provider
// Package update and code upgrade by: Filipe Soccol

import Web3ProviderEngine from 'web3-provider-engine';
// @ts-ignore
import CacheSubprovider from 'web3-provider-engine/subproviders/cache.js';
// @ts-ignore
import RPCSubprovider from 'web3-provider-engine/subproviders/rpc.js';
import { LedgerSubprovider } from './ledgerSubprovider';
import { LedgerEthereumClient } from './types';
import TransportWebUSB from "@ledgerhq/hw-transport-webusb";
import Eth from '@ledgerhq/hw-app-eth';

export interface ILedgerProviderOptions {
  chainId: number;
  rpcUrl: string;
  accountFetchingConfigs?: any;
  baseDerivationPath?: any;
  pollingInterval?: any;
  requestTimeoutMs?: any;
}

async function ledgerEthereumBrowserClientFactoryAsync(): Promise<LedgerEthereumClient> {
    const ledgerConnection = await TransportWebUSB.create();
    const ledgerEthClient = new Eth(ledgerConnection);
    // @ts-ignore
    return ledgerEthClient;
}

class LedgerProvider extends Web3ProviderEngine {
  constructor(opts: ILedgerProviderOptions) {
    super({
      pollingInterval: opts.pollingInterval,
    });
    this.addProvider(
      new LedgerSubprovider({
        networkId: opts.chainId,
        ledgerEthereumClientFactoryAsync: ledgerEthereumBrowserClientFactoryAsync,
        accountFetchingConfigs: opts.accountFetchingConfigs,
        baseDerivationPath: opts.baseDerivationPath,
      })
    );
    this.addProvider(new CacheSubprovider());
    this.addProvider(new RPCSubprovider(opts));

    this.start();
  }
}

export default LedgerProvider;