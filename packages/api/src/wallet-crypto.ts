import sodium from "libsodium-wrappers";
import { bytesToHex, hexToBytes, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export interface EncryptedWalletKey {
  encryptedPrivateKey: string;
  privateKeyNonce: string;
  encryptedDek: string;
  dekNonce: string;
  encryptionVersion: number;
}

const ENVELOPE_VERSION = 1;
const sodiumReady = sodium.ready;

function getMasterKey(): Uint8Array {
  const configuredKey = process.env.EVM_WALLET_MASTER_KEY;
  if (!configuredKey) {
    throw new Error("EVM_WALLET_MASTER_KEY is not configured");
  }

  const masterKey = sodium.from_base64(
    configuredKey,
    sodium.base64_variants.ORIGINAL,
  );
  if (masterKey.length !== sodium.crypto_secretbox_KEYBYTES) {
    sodium.memzero(masterKey);
    throw new Error("EVM_WALLET_MASTER_KEY must decode to 32 bytes");
  }
  return masterKey;
}

const encode = (value: Uint8Array) =>
  sodium.to_base64(value, sodium.base64_variants.ORIGINAL);

const decode = (value: string) =>
  sodium.from_base64(value, sodium.base64_variants.ORIGINAL);

export async function encryptWalletPrivateKey(
  did: string,
  address: Address,
  privateKey: Hex,
): Promise<EncryptedWalletKey> {
  await sodiumReady;
  if (
    privateKeyToAccount(privateKey).address.toLowerCase() !==
    address.toLowerCase()
  ) {
    throw new Error("Wallet address does not match private key");
  }

  const masterKey = getMasterKey();
  let dek: Uint8Array | undefined;
  let didBytes: Uint8Array | undefined;
  let addressBytes: Uint8Array | undefined;
  let privateKeyBytes: Uint8Array | undefined;
  let secretBytes: Uint8Array | undefined;

  try {
    didBytes = sodium.from_string(did);
    addressBytes = hexToBytes(address);
    privateKeyBytes = hexToBytes(privateKey);
    if (
      didBytes.length > 65_535 ||
      addressBytes.length !== 20 ||
      privateKeyBytes.length !== 32
    ) {
      throw new Error("Invalid wallet key data");
    }

    secretBytes = new Uint8Array(
      3 + didBytes.length + addressBytes.length + privateKeyBytes.length,
    );
    secretBytes[0] = ENVELOPE_VERSION;
    secretBytes[1] = didBytes.length >> 8;
    secretBytes[2] = didBytes.length & 0xff;
    secretBytes.set(didBytes, 3);
    secretBytes.set(addressBytes, 3 + didBytes.length);
    secretBytes.set(privateKeyBytes, 3 + didBytes.length + addressBytes.length);

    dek = sodium.randombytes_buf(sodium.crypto_secretbox_KEYBYTES);
    const privateKeyNonce = sodium.randombytes_buf(
      sodium.crypto_secretbox_NONCEBYTES,
    );
    const dekNonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);

    return {
      encryptedPrivateKey: encode(
        sodium.crypto_secretbox_easy(secretBytes, privateKeyNonce, dek),
      ),
      privateKeyNonce: encode(privateKeyNonce),
      encryptedDek: encode(
        sodium.crypto_secretbox_easy(dek, dekNonce, masterKey),
      ),
      dekNonce: encode(dekNonce),
      encryptionVersion: ENVELOPE_VERSION,
    };
  } finally {
    sodium.memzero(masterKey);
    if (dek) sodium.memzero(dek);
    if (didBytes) sodium.memzero(didBytes);
    if (addressBytes) sodium.memzero(addressBytes);
    if (privateKeyBytes) sodium.memzero(privateKeyBytes);
    if (secretBytes) sodium.memzero(secretBytes);
  }
}

export async function decryptWalletPrivateKey(
  expectedDid: string,
  expectedAddress: Address,
  envelope: EncryptedWalletKey,
): Promise<Hex> {
  await sodiumReady;
  if (envelope.encryptionVersion !== ENVELOPE_VERSION) {
    throw new Error("Unsupported wallet key envelope version");
  }

  const masterKey = getMasterKey();
  let encryptedDek: Uint8Array | undefined;
  let dekNonce: Uint8Array | undefined;
  let encryptedPrivateKey: Uint8Array | undefined;
  let privateKeyNonce: Uint8Array | undefined;
  let dek: Uint8Array | undefined;
  let secretBytes: Uint8Array | undefined;
  let expectedAddressBytes: Uint8Array | undefined;

  try {
    encryptedDek = decode(envelope.encryptedDek);
    dekNonce = decode(envelope.dekNonce);
    encryptedPrivateKey = decode(envelope.encryptedPrivateKey);
    privateKeyNonce = decode(envelope.privateKeyNonce);
    dek = sodium.crypto_secretbox_open_easy(encryptedDek, dekNonce, masterKey);
    secretBytes = sodium.crypto_secretbox_open_easy(
      encryptedPrivateKey,
      privateKeyNonce,
      dek,
    );

    if (secretBytes.length < 3) throw new Error("Invalid wallet key envelope");
    const [version, didLengthHigh, didLengthLow] = secretBytes;
    if (
      version === undefined ||
      didLengthHigh === undefined ||
      didLengthLow === undefined
    ) {
      throw new Error("Invalid wallet key envelope");
    }
    const didLength = (didLengthHigh << 8) | didLengthLow;
    const addressOffset = 3 + didLength;
    const privateKeyOffset = addressOffset + 20;
    if (
      version !== ENVELOPE_VERSION ||
      secretBytes.length !== privateKeyOffset + 32
    ) {
      throw new Error("Invalid wallet key envelope");
    }

    expectedAddressBytes = hexToBytes(expectedAddress);
    const storedDid = sodium.to_string(secretBytes.subarray(3, addressOffset));
    const storedAddress = bytesToHex(
      secretBytes.subarray(addressOffset, privateKeyOffset),
    );
    const privateKey = bytesToHex(secretBytes.subarray(privateKeyOffset));
    if (
      storedDid !== expectedDid ||
      storedAddress.toLowerCase() !==
        bytesToHex(expectedAddressBytes).toLowerCase() ||
      privateKeyToAccount(privateKey).address.toLowerCase() !==
        expectedAddress.toLowerCase()
    ) {
      throw new Error("Wallet key envelope does not match its owner");
    }

    return privateKey;
  } finally {
    sodium.memzero(masterKey);
    if (encryptedDek) sodium.memzero(encryptedDek);
    if (dekNonce) sodium.memzero(dekNonce);
    if (encryptedPrivateKey) sodium.memzero(encryptedPrivateKey);
    if (privateKeyNonce) sodium.memzero(privateKeyNonce);
    if (dek) sodium.memzero(dek);
    if (secretBytes) sodium.memzero(secretBytes);
    if (expectedAddressBytes) sodium.memzero(expectedAddressBytes);
  }
}
