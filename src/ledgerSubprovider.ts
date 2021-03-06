// Based on source from:
// https://github.com/0xProject/0x-monorepo/blob/development/packages/subproviders/src/subproviders/ledger.ts
// Package update and code upgrade by: Filipe Soccol

import Web3 from 'web3';
import { FeeMarketEIP1559Transaction, FeeMarketEIP1559TxData } from '@ethereumjs/tx';
import Common, { Hardfork } from '@ethereumjs/common'
import { stripHexPrefix } from 'ethereumjs-util';
import HDNode from 'hdkey';
import { Lock } from 'semaphore-async-await';

import {
    DerivedHDKeyInfo,
    LedgerEthereumClient,
    LedgerEthereumClientFactoryAsync,
    LedgerSubproviderConfigs,
    LedgerSubproviderErrors,
    PartialTxParams,
    WalletSubproviderErrors,
} from './types';
import { walletUtils } from './utils';

import { BaseWalletSubprovider } from './baseProvider';

const DEFAULT_BASE_DERIVATION_PATH = `44'/60'/0'`;
const ASK_FOR_ON_DEVICE_CONFIRMATION = false;
const SHOULD_GET_CHAIN_CODE = true;
const DEFAULT_NUM_ADDRESSES_TO_FETCH = 20;
const DEFAULT_ADDRESS_SEARCH_LIMIT = 1000;

/**
 * Subprovider for interfacing with a user's [Ledger Nano S](https://www.ledgerwallet.com/products/ledger-nano-s).
 * This subprovider intercepts all account related RPC requests (e.g message/transaction signing, etc...) and
 * re-routes them to a Ledger device plugged into the users computer.
 */
export class LedgerSubprovider extends BaseWalletSubprovider {
    // tslint:disable-next-line:no-unused-variable
    private readonly _connectionLock = new Lock();
    private readonly _networkId: number;
    private _baseDerivationPath: string;
    private readonly _ledgerEthereumClientFactoryAsync: LedgerEthereumClientFactoryAsync;
    private _ledgerClientIfExists?: LedgerEthereumClient;
    private readonly _shouldAlwaysAskForConfirmation: boolean;
    private readonly _addressSearchLimit: number;
    /**
     * Instantiates a LedgerSubprovider. Defaults to derivationPath set to `44'/60'/0'`.
     * TestRPC/Ganache defaults to `m/44'/60'/0'/0`, so set this in the configs if desired.
     * @param config Several available configurations
     * @return LedgerSubprovider instance
     */
    constructor(config: LedgerSubproviderConfigs) {
        super();
        this._networkId = config.networkId;
        this._ledgerEthereumClientFactoryAsync = config.ledgerEthereumClientFactoryAsync;
        this._baseDerivationPath = config.baseDerivationPath || DEFAULT_BASE_DERIVATION_PATH;
        this._shouldAlwaysAskForConfirmation =
            config.accountFetchingConfigs !== undefined &&
            config.accountFetchingConfigs.shouldAskForOnDeviceConfirmation !== undefined
                ? config.accountFetchingConfigs.shouldAskForOnDeviceConfirmation
                : ASK_FOR_ON_DEVICE_CONFIRMATION;
        this._addressSearchLimit =
            config.accountFetchingConfigs !== undefined &&
            config.accountFetchingConfigs.addressSearchLimit !== undefined
                ? config.accountFetchingConfigs.addressSearchLimit
                : DEFAULT_ADDRESS_SEARCH_LIMIT;
    }
    /**
     * Retrieve the set derivation path
     * @returns derivation path
     */
    public getPath(): string {
        return this._baseDerivationPath;
    }
    /**
     * Set a desired derivation path when computing the available user addresses
     * @param basDerivationPath The desired derivation path (e.g `44'/60'/0'`)
     */
    public setPath(basDerivationPath: string): void {
        this._baseDerivationPath = basDerivationPath;
    }
    /**
     * Retrieve a users Ledger accounts. The accounts are derived from the derivationPath,
     * master public key and chain code. Because of this, you can request as many accounts
     * as you wish and it only requires a single request to the Ledger device. This method
     * is automatically called when issuing a `eth_accounts` JSON RPC request via your providerEngine
     * instance.
     * @param numberOfAccounts Number of accounts to retrieve (default: 10)
     * @return An array of accounts
     */
    public async getAccountsAsync(numberOfAccounts: number = DEFAULT_NUM_ADDRESSES_TO_FETCH): Promise<string[]> {
        const initialDerivedKeyInfo = await this._initialDerivedKeyInfoAsync();
        const derivedKeyInfos = walletUtils.calculateDerivedHDKeyInfos(initialDerivedKeyInfo, numberOfAccounts);
        const accounts = derivedKeyInfos.map(k => k.address);
        return accounts;
    }
    /**
     * Signs a transaction on the Ledger with the account specificed by the `from` field in txParams.
     * If you've added the LedgerSubprovider to your app's provider, you can simply send an `eth_sendTransaction`
     * JSON RPC request, and this method will be called auto-magically. If you are not using this via a ProviderEngine
     * instance, you can call it directly.
     * @param txParams Parameters of the transaction to sign
     * @return Signed transaction hex string
     */
    public async signTransactionAsync(txParams: PartialTxParams): Promise<string> {
        LedgerSubprovider._validateTxParams(txParams);
        if (txParams.from === undefined || !Web3.utils.isAddress(txParams.from)) {
            throw new Error(WalletSubproviderErrors.FromAddressMissingOrInvalid);
        }
        const initialDerivedKeyInfo = await this._initialDerivedKeyInfoAsync();
        const derivedKeyInfo = this._findDerivedKeyInfoForAddress(initialDerivedKeyInfo, txParams.from);
        this._ledgerClientIfExists = await this._createLedgerClientAsync();

        txParams.chainId = this._networkId
        // Mount EIP-1559 transaction parameters 
        const common = new Common({ chain: this._networkId, hardfork: Hardfork.London, eips: [1559] })
        const tx = FeeMarketEIP1559Transaction.fromTxData(txParams as FeeMarketEIP1559TxData, {common});
        // Get transaction Hex to sign
        const txHex = tx.getMessageToSign(false).toString('hex');
        try {
            // Get derivation path of the account to sign
            const fullDerivationPath = derivedKeyInfo.derivationPath;
            // Request ledger to sign transaction
            const result = await this._ledgerClientIfExists.signTransaction(fullDerivationPath, txHex);
            const txSignedData:FeeMarketEIP1559TxData = txParams as FeeMarketEIP1559TxData
            txSignedData.r = '0x'+result.r
            txSignedData.s = '0x'+result.s
            txSignedData.v = '0x'+result.v
            const txSigned = FeeMarketEIP1559Transaction.fromTxData(txSignedData);
            
            // Validating signature
            if (!txSigned.validate()) throw new Error('Wrong Signature');
            // Compare signer requested
            if (txSigned.getSenderAddress().toString() != txParams.from)  throw new Error('Wrong Signer');
            
            const signedTxHex = `0x${txSigned.serialize().toString('hex')}`;
            await this._destroyLedgerClientAsync();
            return signedTxHex;
        } catch (err) {
            await this._destroyLedgerClientAsync();
            throw err;
        }
    }
    /**
     * Sign a personal Ethereum signed message. The signing account will be the account
     * associated with the provided address.
     * The Ledger adds the Ethereum signed message prefix on-device.  If you've added
     * the LedgerSubprovider to your app's provider, you can simply send an `eth_sign`
     * or `personal_sign` JSON RPC request, and this method will be called auto-magically.
     * If you are not using this via a ProviderEngine instance, you can call it directly.
     * @param data Hex string message to sign
     * @param address Address of the account to sign with
     * @return Signature hex string (order: rsv)
     */
    public async signPersonalMessageAsync(data: string, address: string): Promise<string> {
        if (data === undefined) {
            throw new Error(WalletSubproviderErrors.DataMissingForSignPersonalMessage);
        }
        const initialDerivedKeyInfo = await this._initialDerivedKeyInfoAsync();
        const derivedKeyInfo = this._findDerivedKeyInfoForAddress(initialDerivedKeyInfo, address);

        this._ledgerClientIfExists = await this._createLedgerClientAsync();
        try {
            const fullDerivationPath = derivedKeyInfo.derivationPath;
            const result = await this._ledgerClientIfExists.signPersonalMessage(
                fullDerivationPath,
                stripHexPrefix(data),
            );
            const lowestValidV = 27;
            const v = result.v - lowestValidV;
            const hexBase = 16;
            let vHex = v.toString(hexBase);
            if (vHex.length < 2) {
                vHex = `0${v}`;
            }
            const signature = `0x${result.r}${result.s}${vHex}`;
            await this._destroyLedgerClientAsync();
            return signature;
        } catch (err) {
            await this._destroyLedgerClientAsync();
            throw err;
        }
    }
    /**
     * eth_signTypedData is currently not supported on Ledger devices.
     * @param address Address of the account to sign with
     * @param data the typed data object
     * @return Signature hex string (order: rsv)
     */
    // tslint:disable-next-line:prefer-function-over-method
    public async signTypedDataAsync(address: string, typedData: any): Promise<string> {
        throw new Error(WalletSubproviderErrors.MethodNotSupported);
    }
    private async _createLedgerClientAsync(): Promise<LedgerEthereumClient> {
        await this._connectionLock.acquire();
        if (this._ledgerClientIfExists !== undefined) {
            this._connectionLock.release();
            throw new Error(LedgerSubproviderErrors.MultipleOpenConnectionsDisallowed);
        }
        const ledgerEthereumClient = await this._ledgerEthereumClientFactoryAsync();
        this._connectionLock.release();
        return ledgerEthereumClient;
    }
    private async _destroyLedgerClientAsync(): Promise<void> {
        await this._connectionLock.acquire();
        if (this._ledgerClientIfExists === undefined) {
            this._connectionLock.release();
            return;
        }
        await this._ledgerClientIfExists.transport.close();
        this._ledgerClientIfExists = undefined;
        this._connectionLock.release();
    }
    private async _initialDerivedKeyInfoAsync(): Promise<DerivedHDKeyInfo> {
        this._ledgerClientIfExists = await this._createLedgerClientAsync();

        const parentKeyDerivationPath = `m/${this._baseDerivationPath}`;
        let ledgerResponse;
        try {
            ledgerResponse = await this._ledgerClientIfExists.getAddress(
                parentKeyDerivationPath,
                this._shouldAlwaysAskForConfirmation,
                SHOULD_GET_CHAIN_CODE,
            );
        } finally {
            await this._destroyLedgerClientAsync();
        }
        const hdKey = new HDNode();
        hdKey.publicKey = new Buffer(ledgerResponse.publicKey, 'hex');
        hdKey.chainCode = new Buffer(ledgerResponse.chainCode, 'hex');
        const address = walletUtils.addressOfHDKey(hdKey);
        const initialDerivedKeyInfo = {
            hdKey,
            address,
            derivationPath: parentKeyDerivationPath,
            baseDerivationPath: this._baseDerivationPath,
        };
        return initialDerivedKeyInfo;
    }
    private _findDerivedKeyInfoForAddress(initalHDKey: DerivedHDKeyInfo, address: string): DerivedHDKeyInfo {
        const matchedDerivedKeyInfo = walletUtils.findDerivedKeyInfoForAddressIfExists(
            address,
            initalHDKey,
            this._addressSearchLimit,
        );
        if (matchedDerivedKeyInfo === undefined) {
            throw new Error(`${WalletSubproviderErrors.AddressNotFound}: ${address}`);
        }
        return matchedDerivedKeyInfo;
    }
}