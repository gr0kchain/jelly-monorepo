import { Types, Address, Networks } from '@jelly-swap/btc-wallet';
import { BitcoinProvider } from '@jelly-swap/btc-provider';
import BtcLedger from '@ledgerhq/hw-app-btc';

import coinselect from 'coinselect';

import { BigNumber } from 'bignumber.js';
import { bip32, address, payments, ECPair } from 'bitcoinjs-lib';

import LedgerTransport from './transport';

const ADDRESS_PREFIX = { legacy: 44, 'p2sh-segwit': 49, bech32: 84 } as any;

export default class BitcoinLedgerProvider {
    private provider: BitcoinProvider;
    private network: Types.Network;

    private derivationPath: string;
    private addressType: string;

    private ledgerKeyCache: any;

    private ledger: LedgerTransport;

    constructor(provider: any, network = Networks.bitcoin, addressType = 'bech32') {
        this.provider = provider;
        this.addressType = addressType;
        this.derivationPath = `${ADDRESS_PREFIX[addressType]}'/${network.coinType}'/0'/`;
        this.network = network;
        this.ledgerKeyCache = {};

        this.ledger = new LedgerTransport(BtcLedger);
    }

    async getAddresses(startingIndex = 0, numAddresses = 1, change = false) {
        return this.getLedgerAddresses(startingIndex, numAddresses, change);
    }

    async getAddressList(numAddressPerCall = 25) {
        let addressList: any[] = [];

        const changeAddresses = await this.getChangeAddresses(0, numAddressPerCall);
        addressList = addressList.concat(changeAddresses);

        const nonChangeAddresses = await this.getNonChangeAddresses(0, numAddressPerCall);
        addressList = addressList.concat(nonChangeAddresses);

        return addressList;
    }

    async getWalletAddress(address: string, maxAddresses = 1000, addressesPerCall = 50) {
        let index = 0;
        let change = false;

        while (index < maxAddresses) {
            const addresses = await this.getAddresses(index, addressesPerCall, change);
            const addr = addresses.find((addr: Address) => addr.equals(address));

            if (addr) {
                return addr;
            }

            index += addressesPerCall;

            if (index === maxAddresses && !change) {
                index = 0;
                change = true;
            }
        }

        throw new Error('ADDRESS_MISSING_IN_LEDGER');
    }

    async getBalance(numAddressPerCall = 100) {
        let addressList = await this.getAddressList(numAddressPerCall);

        const utxos = await this.provider.getUnspentTransactions(addressList);

        const balance = utxos
            .reduce((prev: BigNumber, curr: any) => {
                return prev.plus(new BigNumber(curr.value));
            }, new BigNumber(0))
            .toNumber();

        return balance;
    }

    async getChangeAddresses(startingIndex = 0, numAddresses = 1) {
        return await this.getAddresses(startingIndex, numAddresses, true);
    }

    async getNonChangeAddresses(startingIndex = 0, numAddresses = 1) {
        return await this.getAddresses(startingIndex, numAddresses, false);
    }

    async getUsedAddresses(numAddressPerCall = 25) {
        return await this.getUsedUnusedAddresses(numAddressPerCall).then(({ usedAddresses }) => usedAddresses);
    }

    async getUnusedAddress(change = false, numAddressPerCall = 25) {
        const key = change ? 'change' : 'nonChange';
        return await this.getUsedUnusedAddresses(numAddressPerCall).then(({ unusedAddress }) => unusedAddress[key]);
    }

    async getUsedUnusedAddresses(numAddressPerCall = 25) {
        const usedAddresses = [];
        const unusedAddress: any = { change: null, nonChange: null };

        let addressList = await this.getAddressList(numAddressPerCall);

        const utxos = await this.provider.getUnspentTransactions(addressList);

        for (const address of addressList) {
            const key = address.change ? 'change' : 'nonChange';

            const isUsed = utxos.find((utxo: any) => address.equals(utxo.address));

            if (isUsed) {
                usedAddresses.push(address);
                unusedAddress[key] = null;
            } else {
                if (!unusedAddress[key]) {
                    unusedAddress[key] = address;
                }
            }
        }

        if (!unusedAddress['change']) {
            unusedAddress['change'] = addressList[0];
        }

        if (!unusedAddress['nonChange']) {
            unusedAddress['nonChange'] = addressList[0];
        }

        return { usedAddresses, unusedAddress };
    }

    async getUnusedChangeAddress(numAddressPerCall = 25) {
        return await this.getUnusedAddress(true, numAddressPerCall);
    }

    async getUnusedNonChangeAddress(numAddressPerCall = 25) {
        return await this.getUnusedAddress(false, numAddressPerCall);
    }

    async buildTransaction(to: string, value: number | string, data: any, feePerByte?: number | string) {
        return this._buildTransaction([{ to, value }], data, feePerByte);
    }

    async sendTransaction(to: string, value: number | string, data: any, feePerByte?: number | string) {
        return this._sendTransaction([{ to, value }], data, feePerByte);
    }

    async signP2SHTransaction(
        tx: any,
        rawTx: any,
        address: any,
        vout: any,
        outputScript: any,
        segwit = false,
        expiration = 0
    ) {
        const app = await this.ledger.getInstance();
        const walletAddress = await this.getWalletAddress(address);

        if (!segwit) {
            tx.setInputScript(vout.n, outputScript); // TODO: is this ok for p2sh-segwit??
        }

        const ledgerInputTx = await app.splitTransaction(rawTx, true);
        const ledgerTx = await app.splitTransaction(tx.toHex(), true);
        const ledgerOutputs = (await app.serializeTransactionOutputs(ledgerTx)).toString('hex');
        const ledgerSig = await app.signP2SHTransaction(
            [[ledgerInputTx, vout.n, outputScript.toString('hex'), 0]],
            [walletAddress.derivationPath],
            ledgerOutputs.toString('hex'),
            expiration,
            undefined, // SIGHASH_ALL
            segwit,
            2
        );

        const finalSig = segwit ? ledgerSig[0] : ledgerSig[0] + '01'; // Is this a ledger bug? Why non segwit signs need the sighash appended?
        const sig = Buffer.from(finalSig, 'hex');

        return sig;
    }

    getAddressFromPublicKey(publicKey: Buffer) {
        if (this.addressType === 'legacy') {
            return payments.p2pkh({
                pubkey: publicKey,
                network: this.network,
            }).address;
        } else if (this.addressType === 'p2sh-segwit') {
            return payments.p2sh({
                redeem: payments.p2wpkh({
                    pubkey: publicKey,
                    network: this.network,
                }),
                network: this.network,
            }).address;
        } else if (this.addressType === 'bech32') {
            return payments.p2wpkh({
                pubkey: publicKey,
                network: this.network,
            }).address;
        }
    }

    async getInputsForAmount(amount: number | string, feePerByte?: number | string, numAddressPerCall = 25) {
        let addrList = await this.getAddressList(numAddressPerCall);

        const utxos = await this.provider.getUnspentTransactions(addrList);

        const updatedUtxos = utxos.map((utxo: any) => {
            const addr = addrList.find((a) => a.equals(utxo.address));
            return {
                ...utxo,
                value: new BigNumber(utxo.amount).times(1e8).toNumber(),
                derivationPath: addr.derivationPath,
            };
        });

        if (!feePerByte) {
            feePerByte = await this.provider.getFeePerByte();
        }

        const result = this.getInputs(updatedUtxos, Number(amount), feePerByte);

        if (result.inputs) {
            return result;
        } else {
            // if user tries to use the whole available balance
            const fixedAmount = new BigNumber(amount).minus(result.fee).toNumber();
            const fixedResult = this.getInputs(updatedUtxos, Number(fixedAmount), feePerByte);
            if (fixedResult.inputs) {
                return fixedResult;
            }
        }

        throw new Error('NOT_ENOUGHT_BALANCE');
    }

    getInputs(utxos: any, amount: Number, feePerByte: any) {
        const { inputs, outputs, fee } = coinselect(utxos, [{ id: 'main', value: amount }], feePerByte);

        if (inputs && outputs) {
            let change = outputs.find((output: any) => output.id !== 'main');

            if (change) {
                if (change.length) {
                    change = change[0].value;
                }
            }

            return { inputs, change, fee, amount };
        }

        return { fee, amount };
    }

    padHexStart(hex: string, length: number) {
        let len = length || hex.length;
        len += len % 2;

        return hex.padStart(len, '0');
    }

    getAmountBuffer(amount: number) {
        let hexAmount = new BigNumber(Math.round(amount)).toString(16);

        hexAmount = this.padHexStart(hexAmount, 16);
        const valueBuffer = Buffer.from(hexAmount, 'hex');
        return valueBuffer.reverse();
    }

    async getLedgerInputs(utxos: any[]) {
        const ledger = await this.ledger.getInstance();

        return Promise.all(
            utxos.map(async (u) => {
                const hex = await this.provider.getRawTransaction(u.txid);
                const tx = ledger.splitTransaction(hex, true);
                return [tx, u.vout];
            })
        );
    }

    async _getWalletPublicKey(path: string) {
        const ledger = await this.ledger.getInstance();
        const format = this.addressType === 'p2sh-segwit' ? 'p2sh' : this.addressType;
        return ledger.getWalletPublicKey(path, { format: format });
    }

    async getWalletPublicKey(path: string) {
        if (path in this.ledgerKeyCache) {
            return this.ledgerKeyCache[path];
        }

        const key = await this._getWalletPublicKey(path);
        this.ledgerKeyCache[path] = key;
        return key;
    }

    async getLedgerAddresses(startingIndex: number, numAddresses: number, change = false) {
        const pubkey = await this.getWalletPublicKey(this.derivationPath);
        const compressed = ECPair.fromPublicKey(Buffer.from(pubkey)).publicKey.toString('hex');

        const node = bip32.fromPublicKey(
            Buffer.from(compressed, 'hex'),
            Buffer.from(pubkey.chainCode, 'hex'),
            this.network
        );

        const addresses = [];
        const lastIndex = startingIndex + numAddresses;
        const changeVal = change ? '1' : '0';

        for (let currentIndex = startingIndex; currentIndex < lastIndex; currentIndex++) {
            const subPath = changeVal + '/' + currentIndex;
            const publicKey = node.derivePath(subPath).publicKey;
            const address = this.getAddressFromPublicKey(publicKey);
            const path = this.derivationPath + subPath;

            addresses.push(new Address(address, path, publicKey, currentIndex, change));
        }

        return addresses;
    }

    async _buildTransaction(outputs: any, data: any, feePerByte?: any) {
        const ledger = await this.ledger.getInstance();

        const unusedAddress = await this.getUnusedAddress(true);
        const { inputs, change, amount } = await this.getInputsForAmount(outputs);
        let amountWithoutFee = amount;

        const ledgerInputs = await this.getLedgerInputs(inputs);
        const paths = inputs.map((utxo: any) => utxo.derivationPath);

        const ledgerOutputs = [];
        // Add metadata
        if (data) {
            const metadata = Buffer.from(`J_${data.eventName}`, 'utf8');
            const embed = payments.embed({ data: [metadata] });

            ledgerOutputs.push({
                amount: this.getAmountBuffer(0),
                script: embed.output,
            });

            // replace the inputAmount of the metadata with amount - fee in case the whole balance is used.
            if (amountWithoutFee) {
                data.inputAmount = amountWithoutFee;
            }
        }

        ledgerOutputs.concat(
            outputs.map((output: any) => {
                let amount;

                if (amountWithoutFee) {
                    amount = amountWithoutFee;
                    amountWithoutFee = null;
                } else {
                    amount = output.value;
                }

                return {
                    amount: this.getAmountBuffer(amount),
                    script: address.toOutputScript(output.to, this.network),
                };
            })
        );

        if (change) {
            ledgerOutputs.push({
                amount: this.getAmountBuffer(change.value),
                script: address.toOutputScript(unusedAddress, this.network),
            });
        }

        const serializedOutputs = ledger.serializeTransactionOutputs({ outputs }).toString('hex');

        return ledger.createPaymentTransactionNew(
            ledgerInputs,
            paths,
            unusedAddress.derivationPath,
            serializedOutputs,
            undefined,
            undefined,
            ['bech32', 'p2sh-segwit'].includes(this.addressType),
            undefined,
            this.addressType === 'bech32' ? ['bech32'] : undefined
        );
    }

    async _sendTransaction(outputs: any, data: any, feePerByte?: number | string) {
        const signedTransaction = await this._buildTransaction(outputs, data, feePerByte);
        return await this.provider.sendRawTransaction(signedTransaction, data);
    }
}
