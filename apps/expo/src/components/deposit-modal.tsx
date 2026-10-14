import { useState } from "react";
import { Modal, Pressable, TouchableOpacity, View } from "react-native";
import QRCode from "react-native-qrcode-svg";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { showToastable } from "react-native-toastable";
import * as Clipboard from "expo-clipboard";
import { msg, Trans } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useTheme } from "@react-navigation/native";
import { XIcon } from "lucide-react-native";
import { type Address } from "viem";

import { Text } from "~/components/themed/text";
import {
  ActionButton,
  continuousCorners,
  radius,
  SectionLabel,
  useUi,
} from "~/components/ui";
import { appChains } from "~/lib/web3";

export const DepositModal = ({
  visible,
  walletAddress,
  onClose,
  onSetup,
}: {
  visible: boolean;
  walletAddress?: Address;
  onClose: () => void;
  onSetup: () => void;
}) => {
  const { _ } = useLingui();
  const theme = useTheme();
  const ui = useUi();
  const insets = useSafeAreaInsets();
  const [chainId, setChainId] = useState<number>(appChains[0]?.id ?? 0);
  const selectedChain = appChains.find((chain) => chain.id === chainId);
  const address = walletAddress;
  const qrValue =
    address && selectedChain
      ? `ethereum:${address}@${selectedChain.id}`
      : address;

  const copyAddress = async () => {
    if (!address) return;
    try {
      await Clipboard.setStringAsync(address);
      showToastable({ message: _(msg`Address copied`) });
    } catch {
      showToastable({
        message: _(msg`Could not copy address`),
        status: "danger",
      });
    }
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <View className="flex-1 justify-end">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={_(msg`Close deposit window`)}
          className="absolute inset-0 bg-black/50"
          onPress={onClose}
        />
        <View
          className="rounded-t-3xl px-5 pt-5"
          style={{
            backgroundColor: theme.colors.card,
            paddingBottom: Math.max(insets.bottom, 20),
          }}
        >
          <View className="mb-5 flex-row items-center justify-between">
            <Text className="text-xl font-semibold">
              <Trans>Deposit</Trans>
            </Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={_(msg`Close deposit window`)}
              onPress={onClose}
              className="rounded-full p-2"
            >
              <XIcon size={20} color={theme.colors.text} />
            </TouchableOpacity>
          </View>
          <Text
            className="mb-4 text-sm font-medium"
            style={{ color: ui.muted }}
          >
            <Trans>Receive funds into your Kites wallet.</Trans>
          </Text>
          <View className="mb-4 mt-4 flex-row gap-2">
            {appChains.map((chain) => (
              <DestinationButton
                key={chain.id}
                label={chain.name}
                selected={chain.id === chainId}
                onPress={() => setChainId(chain.id)}
              />
            ))}
          </View>
          {address ? (
            <>
              <Text className="mb-2 text-sm" style={{ color: ui.muted }}>
                <Trans>
                  Send funds on {selectedChain?.name ?? "the selected network"}
                  to this address.
                </Trans>
              </Text>
              <View
                className="items-center p-4"
                style={{
                  backgroundColor: ui.inset,
                  borderColor: ui.border,
                  borderWidth: 1,
                  borderRadius: radius.card,
                  ...continuousCorners,
                }}
              >
                {qrValue && <QRCode value={qrValue} size={156} />}
                <Text
                  selectable
                  className="mt-3 text-center text-sm font-medium"
                >
                  {address}
                </Text>
              </View>
              <ActionButton
                label={<Trans>Copy address</Trans>}
                onPress={() => void copyAddress()}
                className="mt-4"
              />
            </>
          ) : (
            <>
              <Text className="text-sm leading-5" style={{ color: ui.muted }}>
                <Trans>
                  Create your Kites wallet to get a deposit address.
                </Trans>
              </Text>
              <ActionButton
                label={<Trans>Set up wallet</Trans>}
                onPress={onSetup}
                className="mt-4"
              />
            </>
          )}
        </View>
      </View>
    </Modal>
  );
};

const DestinationButton = ({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) => {
  const ui = useUi();
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityState={{ selected }}
      activeOpacity={0.8}
      onPress={onPress}
      className="min-h-[52px] flex-1 items-center justify-center px-3"
      style={{
        backgroundColor: selected ? ui.primary : ui.inset,
        borderColor: selected ? ui.primary : ui.border,
        borderWidth: 1,
        borderRadius: radius.control,
      }}
    >
      <Text
        className="text-center text-[15px] font-semibold"
        style={{ color: selected ? "white" : ui.text }}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
};
