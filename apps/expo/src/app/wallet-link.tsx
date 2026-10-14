import { useState } from "react";
import {
  ActivityIndicator,
  Platform,
  ScrollView,
  TouchableOpacity,
  View,
} from "react-native";
import { Stack, useLocalSearchParams } from "expo-router";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { useQuery } from "@tanstack/react-query";

import { Text } from "~/components/themed/text";
import { useAgent } from "~/lib/agent";
import { cx } from "~/lib/utils/cx";
import {
  resolvePublicWalletLink,
  WALLET_LINK_COLLECTION,
} from "~/lib/web3/custody/wallet-link";

const monospaceFontFamily = Platform.select({
  ios: "Menlo",
  android: "monospace",
  default: "monospace",
});
const contentGutter = 16;

export default function WalletLinkScreen() {
  const { did } = useLocalSearchParams<{ did: string }>();
  const agent = useAgent();
  const theme = useTheme();
  const { _ } = useLingui();
  const [verificationResult, setVerificationResult] = useState<
    "verified" | "invalid" | "error" | null
  >(null);
  const walletLink = useQuery({
    queryKey: ["wallet", "public-link", did],
    queryFn: () => resolvePublicWalletLink(agent, did),
    enabled: Boolean(did),
    staleTime: 60_000,
  });

  const verifyWalletLink = async () => {
    setVerificationResult(null);
    const result = await walletLink.refetch();
    setVerificationResult(
      result.isError ? "error" : result.data ? "verified" : "invalid",
    );
  };

  return (
    <>
      <Stack.Screen options={{ title: _(msg`Wallet record`) }} />
      {walletLink.isPending ? (
        <View className="flex-1 items-center justify-center">
          <ActivityIndicator size="large" />
        </View>
      ) : walletLink.isError ? (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-base text-neutral-600 dark:text-neutral-400">
            {verificationResult === "error" ? (
              <Trans>Could not load the record to verify it.</Trans>
            ) : (
              <Trans>
                Could not load this profile&apos;s public wallet record.
              </Trans>
            )}
          </Text>
        </View>
      ) : walletLink.data ? (
        <ScrollView
          className="flex-1"
          contentInsetAdjustmentBehavior="automatic"
          contentContainerStyle={{
            padding: contentGutter,
            paddingBottom: 32,
          }}
        >
          <Text className="text-base text-neutral-600 dark:text-neutral-400">
            <Trans>
              This AT Protocol record publicly links an EVM wallet address to
              this profile&apos;s DID. The wallet signs a typed message to prove
              control of the address.
            </Trans>
          </Text>
          <Text className="mb-2 mt-5 text-sm font-semibold">
            <Trans>Record URI</Trans>
          </Text>
          <Text
            selectable
            className="font-mono text-xs"
            style={{ fontFamily: monospaceFontFamily }}
          >
            {`at://${did}/${WALLET_LINK_COLLECTION}/self`}
          </Text>
          <Text className="mb-2 mt-6 text-sm font-semibold">
            <Trans>Record document</Trans>
          </Text>
          <CodeBlock
            value={{
              $type: WALLET_LINK_COLLECTION,
              version: 1,
              address: walletLink.data.address,
              createdAt: walletLink.data.createdAt,
              proof: walletLink.data.proof,
            }}
            fontFamily={monospaceFontFamily}
          />
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityState={{
              disabled: walletLink.isFetching,
              busy: walletLink.isFetching,
            }}
            disabled={walletLink.isFetching}
            onPress={() => void verifyWalletLink()}
            className="mt-4 rounded-full px-4 py-3"
            style={{ backgroundColor: theme.colors.primary }}
          >
            <Text className="text-center font-semibold text-white">
              {walletLink.isFetching ? (
                <Trans>Verifying wallet link…</Trans>
              ) : (
                <Trans>Verify wallet link</Trans>
              )}
            </Text>
          </TouchableOpacity>
          <Text className="mt-2 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
            <Trans>
              The app re-reads the public AT Protocol record and checks the
              signature locally on this device.
            </Trans>
          </Text>
          {verificationResult && (
            <Text
              className={cx(
                "mt-3 text-sm leading-5",
                verificationResult === "verified"
                  ? "text-green-700 dark:text-green-400"
                  : "text-red-700 dark:text-red-400",
              )}
            >
              {verificationResult === "verified" ? (
                <Trans>
                  Verified: the signature resolves to this wallet address and
                  is linked to this DID.
                </Trans>
              ) : verificationResult === "invalid" ? (
                <Trans>
                  Verification failed: no valid signed wallet record was found.
                </Trans>
              ) : (
                <Trans>Could not load the record to verify it.</Trans>
              )}
            </Text>
          )}
          <Text className="mb-3 mt-6 text-lg font-semibold">
            <Trans>Record fields</Trans>
          </Text>
          <View
            style={{
              marginHorizontal: -contentGutter,
              paddingHorizontal: contentGutter,
            }}
          >
            <Text className="mb-1 font-mono text-sm font-semibold">
              $type
            </Text>
            <Text className="mb-4 text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              <Trans>
                The AT Protocol collection that defines this record. It is not
                a field in the wallet signature.
              </Trans>
            </Text>
            <Text className="mb-1 font-mono text-sm font-semibold">
              version
            </Text>
            <Text className="mb-4 text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              <Trans>
                The version of this record format. It is not a field in the
                wallet signature.
              </Trans>
            </Text>
            <Text className="mb-1 font-mono text-sm font-semibold">
              address
            </Text>
            <Text className="mb-4 text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              <Trans>
                The public EVM address. It must match the address inside the
                signed proof.
              </Trans>
            </Text>
            <Text className="mb-1 font-mono text-sm font-semibold">
              createdAt
            </Text>
            <Text className="mb-4 text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              <Trans>
                An ISO timestamp derived from the signed issuedAt value. It is
                not a separate signed field.
              </Trans>
            </Text>
            <Text className="mb-1 font-mono text-sm font-semibold">proof</Text>
            <Text className="mb-4 text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              <Trans>
                The DID, address, nonce, issue time, audience, and wallet
                signature used to prove the link.
              </Trans>
            </Text>
          </View>

          <Text className="mb-2 mt-7 text-lg font-semibold">
            <Trans>How the proof is made</Trans>
          </Text>
          <Text className="text-sm leading-5 text-neutral-600 dark:text-neutral-400">
            <Trans>
              When the wallet is linked, the app requests a random 32-byte
              nonce and an issue time. The passkey-backed wallet signs the
              EIP-712 typed message below. This is a signature request, not a
              blockchain transaction, so it does not move funds or require gas.
            </Trans>
          </Text>

          <Text className="mb-2 mt-5 text-sm font-semibold">
            <Trans>Signing domain</Trans>
          </Text>
          <CodeBlock
            value={{ name: "Kites Wallet Link", version: "1", chainId: 1 }}
            fontFamily={monospaceFontFamily}
          />
          <Text className="mt-2 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
            <Trans>
              The chainId is part of the signature domain; it does not mean the
              wallet or funds are on Ethereum mainnet.
            </Trans>
          </Text>

          <Text className="mb-2 mt-5 text-sm font-semibold">
            <Trans>Primary type and field types</Trans>
          </Text>
          <CodeBlock
            value={{
              WalletLink: [
                { name: "did", type: "string" },
                { name: "address", type: "address" },
                { name: "nonce", type: "bytes32" },
                { name: "issuedAt", type: "uint64" },
                { name: "audience", type: "string" },
              ],
            }}
            fontFamily={monospaceFontFamily}
          />
          <Text className="mb-2 mt-5 text-sm font-semibold">
            <Trans>Exact signed message</Trans>
          </Text>
          <CodeBlock
            value={{
              did: walletLink.data.proof.did,
              address: walletLink.data.proof.address,
              nonce: walletLink.data.proof.nonce,
              issuedAt: walletLink.data.proof.issuedAt,
              audience: walletLink.data.proof.audience,
            }}
            fontFamily={monospaceFontFamily}
          />
          <Text className="mt-2 text-xs leading-5 text-neutral-500 dark:text-neutral-400">
            <Trans>
              issuedAt is a Unix timestamp in seconds. The nonce is a random
              32-byte value, and audience is social.kites.wallet.link.
            </Trans>
          </Text>

          <Text className="mb-2 mt-5 text-sm font-semibold">
            <Trans>Signature</Trans>
          </Text>
          <CodeBlock
            value={walletLink.data.proof.signature}
            fontFamily={monospaceFontFamily}
          />
          <Text className="mt-2 text-sm leading-5 text-neutral-600 dark:text-neutral-400">
            <Trans>
              This is a 65-byte ECDSA signature encoded as hexadecimal. A
              verifier recovers the signing address from the EIP-712 domain,
              typed message, and signature. The recovered address must equal
              proof.address and the record&apos;s address.
            </Trans>
          </Text>

          <Text className="mb-2 mt-6 text-lg font-semibold">
            <Trans>How to verify it</Trans>
          </Text>
          <View className="gap-2">
            <Text className="text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              <Trans>
                1. Read this record from the PDS for the DID in its AT URI.
              </Trans>
            </Text>
            <Text className="text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              <Trans>
                2. Confirm proof.did matches that DID, and proof.address
                matches the record&apos;s address.
              </Trans>
            </Text>
            <Text className="text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              <Trans>
                3. Recover the signer using the domain and WalletLink typed
                message shown above. It must equal the recorded address.
              </Trans>
            </Text>
            <Text className="text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              <Trans>
                During wallet linking, the server also checks that issuedAt is
                recent: no more than 10 minutes old or 60 seconds in the
                future.
              </Trans>
            </Text>
            <Text className="text-sm leading-5 text-neutral-600 dark:text-neutral-400">
              <Trans>
                The current server does not keep a used-nonce list. It enforces
                challenge freshness with issuedAt; the public signature remains
                verifiable after that registration window expires.
              </Trans>
            </Text>
          </View>
        </ScrollView>
      ) : (
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-base text-neutral-600 dark:text-neutral-400">
            {verificationResult === "invalid" ? (
              <Trans>
                Verification failed: no valid signed wallet record was found.
              </Trans>
            ) : (
              <Trans>This profile has no valid public wallet record.</Trans>
            )}
          </Text>
        </View>
      )}
    </>
  );
}

const CodeBlock = ({
  value,
  fontFamily,
}: {
  value: unknown;
  fontFamily: string | undefined;
}) => (
  <ScrollView
    horizontal
    nestedScrollEnabled
    showsHorizontalScrollIndicator
    className="rounded-xl bg-neutral-100 dark:bg-neutral-900"
    style={{ alignSelf: "stretch" }}
    contentContainerStyle={{ padding: 12 }}
  >
    <Text
      selectable
      className="font-mono text-xs leading-5"
      style={{ fontFamily }}
    >
      {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
    </Text>
  </ScrollView>
);
