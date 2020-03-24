import { TokenConfig, AddressToToken } from './tokens';

export default (token?: string, tokenConfig = TokenConfig, addressToToken = AddressToToken, expiration = 10800) => {
    return {
        explorer: 'https://testnet.explorer.aepps.com/transactions/',
        providerUrl: 'https://testnet.aeternity.io/',
        internalUrl: 'https://testnet.aeternity.io/',
        compilerUrl: 'https://compiler.aepps.com',
        wsUrl: 'wss://testnet.aeternal.io/websocket',
        contractAddress: 'ct_2ftiFiSQmiGe7xFuVzt2umrMkaNXkuRSf2iuQYda6qfxt6qCvy',
        receiverAddress: 'ak_471dYUrQ8EAtmzwuKDw4VBGQdnEcP5YF563WG4yR9Wvfp5tRp',
        blockTime: 5,
        expiration,
        unix: false,
        apiUrl: 'https://testnet.aeternal.io/',

        AddressToToken: addressToToken,
        TokenToAddress: (token?: string) => {
            return tokenConfig[token].address;
        },
        ...tokenConfig[token],
    };
};
