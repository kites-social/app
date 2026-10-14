import { useCallback, useState } from "react";
import { Platform, ScrollView, TouchableOpacity, View } from "react-native";
import { Redirect, Stack } from "expo-router";
import { useQueryClient } from "@tanstack/react-query";
import {
  createWalletClient,
  http,
  recoverTransactionAddress,
  verifyMessage,
  type TransactionSerializedEIP1559,
} from "viem";

import { SelectableText, Text } from "~/components/themed/text";
import { useAgent } from "~/lib/agent";
import { kitesDevEnabled } from "~/lib/dev/config";
import { api } from "~/lib/utils/api";
import { monadTestnet, monadTestnetPublicClient } from "~/lib/web3";
import {
  deletePublicWalletLinkIfMatches,
  isPasskeySupported,
  resolvePublicWalletLink,
  useWallet,
  WALLET_RP_ID,
  type CustodySession,
} from "~/lib/web3/custody";

/** Renders the full error chain: Mera buries the native error in `cause`. */
const formatError = (error: unknown, depth = 0): string => {
  if (depth > 4) return "…";
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    const cause = (error as { cause?: unknown }).cause;
    const head = `${error.name}${
      typeof code === "string" ? `[${code}]` : ""
    }: ${error.message}`;
    return cause === undefined
      ? head
      : `${head} <- ${formatError(cause, depth + 1)}`;
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const parts = ["error", "code", "message"]
      .map((key) => record[key])
      .filter((value): value is string => typeof value === "string");
    return parts.length > 0 ? parts.join(" ") : JSON.stringify(error);
  }
  return String(error);
};

/**
 * TEMPORARY: manual harness for passkey creation, session lifecycle, and
 * signing. Reachable from Settings on dev builds. Delete once the wallet UX is
 * settled.
 */
export default function WalletTestScreen() {
  const agent = useAgent();
  const wallet = useWallet();
  const utils = api.useUtils();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [log, setLog] = useState<string[]>([]);

  const append = useCallback((entry: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLog((previous) => [`${stamp}  ${entry}`, ...previous]);
  }, []);

  const run = useCallback(
    async (label: string, fn: () => Promise<string>) => {
      setBusy(true);
      try {
        append(`${label}: ${await fn()}`);
      } catch (error) {
        append(`${label} FAILED: ${formatError(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [append],
  );

  const requireSession = (): CustodySession => wallet.requireSession();

  const signMessage = () =>
    run("signMessage", async () => {
      const { account } = requireSession();
      const message = `dummy message ${Date.now()}`;
      const signature = await account.signMessage({ message });
      const valid = await verifyMessage({
        address: account.address,
        message,
        signature,
      });
      return `${signature.slice(0, 20)}… verify=${valid}`;
    });

  const signTypedData = () =>
    run("signTypedData", async () => {
      const { account } = requireSession();
      const signature = await account.signTypedData({
        domain: {
          name: "KitesWalletTest",
          version: "1",
          chainId: monadTestnet.id,
        },
        types: {
          Test: [
            { name: "message", type: "string" },
            { name: "count", type: "uint256" },
          ],
        },
        primaryType: "Test",
        message: { message: "hello from custody test", count: BigInt(1) },
      });
      return `${signature.slice(0, 20)}… (${signature.length} hex chars)`;
    });

  const signDummyTransaction = () =>
    run("signTransaction", async () => {
      const { account } = requireSession();
      const serialized = await account.signTransaction({
        chainId: monadTestnet.id,
        to: account.address,
        value: BigInt(0),
        nonce: 0,
        gas: BigInt(21_000),
        maxFeePerGas: BigInt(1_000_000_000),
        maxPriorityFeePerGas: BigInt(1_000_000_000),
        type: "eip1559",
      });
      const recovered = await recoverTransactionAddress({
        serializedTransaction: serialized as TransactionSerializedEIP1559,
      });
      return `${serialized.slice(0, 18)}… from=${recovered}`;
    });

  const broadcastSelfTransfer = () =>
    run("broadcast 0 MON self-transfer", async () => {
      const { account } = requireSession();
      const client = createWalletClient({
        account,
        chain: monadTestnet,
        transport: http(),
      });
      const hash = await client.sendTransaction({
        to: account.address,
        value: BigInt(0),
      });
      const receipt = await monadTestnetPublicClient.waitForTransactionReceipt({
        hash,
      });
      return `${hash} status=${receipt.status}`;
    });

  const deleteWalletLink = () =>
    run("delete AT Protocol wallet link", async () => {
      const did = agent.session?.did;
      if (!did) throw new Error("Sign in before deleting your wallet link.");

      const link = await resolvePublicWalletLink(agent, did);
      if (link) {
        const deleted = await deletePublicWalletLinkIfMatches(
          agent,
          did,
          link.proof,
        );
        if (!deleted) {
          throw new Error(
            "The wallet link changed before it could be deleted. Refresh and try again.",
          );
        }
      }

      wallet.lock();
      queryClient.setQueryData(["wallet", "public-link", did], null);
      utils.wallet.mine.setData(undefined, null);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["wallet", "public-link", did],
        }),
        utils.wallet.mine.invalidate(),
      ]);

      return link
        ? `Removed ${link.address} from the AT Protocol record. The passkey and funds remain; use Create passkey + register to start a fresh wallet setup.`
        : "No wallet link was present. The local wallet session is locked; use Create passkey + register to start a fresh wallet setup.";
    });

  const session = (() => {
    try {
      return wallet.isUnlocked ? requireSession() : null;
    } catch {
      return null;
    }
  })();

  if (!kitesDevEnabled) return <Redirect href="/settings" />;

  return (
    <>
      <Stack.Screen options={{ title: "Wallet custody test" }} />
      <ScrollView
        className="flex-1"
        contentContainerStyle={{ padding: 16, paddingBottom: 48 }}
        contentInsetAdjustmentBehavior="automatic"
      >
        <View className="mb-4 rounded-2xl border border-neutral-400/30 p-4">
          <Text className="text-sm">
            unlocked: {wallet.isUnlocked ? "yes" : "no"} | busy:{" "}
            {wallet.isBusy || busy ? "yes" : "no"}
          </Text>
          <Text className="mt-1 text-sm">
            session: {session?.address ?? "—"}
          </Text>
          <Text className="mt-1 text-xs">
            linked: {wallet.address ?? "none"}
          </Text>
          <Text className="mt-1 text-xs">
            credential: {session?.credentialId ?? "—"}
          </Text>
          <Text className="mt-1 text-xs">
            rpId: {WALLET_RP_ID ?? "(unset)"} | platform: {Platform.OS}{" "}
            {String(Platform.Version)}
          </Text>
        </View>

        <Section title="AT Protocol wallet link">
          <Text className="text-sm text-neutral-600 dark:text-neutral-300">
            Removes the public wallet link only. The old passkey and funds stay
            at the old address, and a new wallet will not move them.
          </Text>
          <Button
            label="Delete wallet link from AT Protocol"
            disabled={busy || wallet.isBusy}
            onPress={() => void deleteWalletLink()}
          />
        </Section>

        <Section title="Passkey">
          <Button
            label="Check passkey support"
            disabled={busy}
            onPress={() =>
              void run("Passkey.isSupported", async () =>
                String(await isPasskeySupported()),
              )
            }
          />
          <Button
            label="Create passkey + register"
            disabled={busy || wallet.isBusy}
            onPress={() =>
              void run("createAndRegister", async () => {
                const created = await wallet.createAndRegister(
                  "Wallet custody test",
                );
                void wallet
                  .retryVenueSetup()
                  .catch((error: unknown) =>
                    append(`venue setup FAILED: ${formatError(error)}`),
                  );
                return created.address;
              })
            }
          />
          <Button
            label="Unlock existing passkey"
            disabled={busy || wallet.isBusy}
            onPress={() =>
              void run("unlock", async () => {
                const opened = await wallet.unlock();
                void wallet
                  .retryVenueSetup()
                  .catch((error: unknown) =>
                    append(`venue setup FAILED: ${formatError(error)}`),
                  );
                return opened.address;
              })
            }
          />
          <Button
            label="Lock (end session)"
            disabled={busy || !wallet.isUnlocked}
            onPress={() => {
              wallet.lock();
              append("lock: session ended");
            }}
          />
        </Section>

        <Section title="Sign">
          <Button
            label="Sign message"
            disabled={busy || !wallet.isUnlocked}
            onPress={() => void signMessage()}
          />
          <Button
            label="Sign typed data (EIP-712)"
            disabled={busy || !wallet.isUnlocked}
            onPress={() => void signTypedData()}
          />
          <Button
            label="Sign dummy transaction (offline)"
            disabled={busy || !wallet.isUnlocked}
            onPress={() => void signDummyTransaction()}
          />
          <Button
            label="Broadcast 0 MON self-transfer"
            disabled={busy || !wallet.isUnlocked}
            onPress={() => void broadcastSelfTransfer()}
          />
        </Section>

        <Section title="Log">
          <Button
            label="Clear log"
            disabled={log.length === 0}
            onPress={() => setLog([])}
          />
          <View className="mt-3 gap-2">
            {log.length === 0 ? (
              <Text className="text-sm opacity-60">No entries yet.</Text>
            ) : (
              log.map((entry, index) => (
                <SelectableText
                  key={`${entry}-${index}`}
                  className="text-xs"
                  selectable
                >
                  {entry}
                </SelectableText>
              ))
            )}
          </View>
        </Section>
      </ScrollView>
    </>
  );
}

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <View className="mb-4">
    <Text className="mb-2 text-base font-semibold">{title}</Text>
    <View className="gap-2">{children}</View>
  </View>
);

const Button = ({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) => (
  <TouchableOpacity
    accessibilityRole="button"
    disabled={disabled}
    onPress={onPress}
    className="items-center rounded-xl bg-blue-500 py-3"
    style={{ opacity: disabled ? 0.4 : 1 }}
  >
    <Text className="font-semibold text-white">{label}</Text>
  </TouchableOpacity>
);
