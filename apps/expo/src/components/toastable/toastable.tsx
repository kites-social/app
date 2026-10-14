import { useEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import ReactNativeToastable, {
  type ToastableBodyParams,
  type ToastableMessageStatus,
} from "react-native-toastable";
import { useTheme } from "@react-navigation/native";

import { logFlow } from "~/lib/flow-log";

type WalletToastStatus = "progress" | ToastableMessageStatus;

interface WalletToastData {
  id: string;
  title: string;
  message: string;
  status: WalletToastStatus;
}

type ToastCardProps = Pick<
  ToastableBodyParams,
  "message" | "title" | "onPress"
> & {
  status?: WalletToastStatus;
  style?: StyleProp<ViewStyle>;
};

const DEFAULT_WALLET_TOAST_ID = "default";
const WALLET_TOAST_DISMISS_MS = 3000;
const WALLET_TOAST_GAP = 8;

// Map preserves insertion order, so updating a toast keeps its stack position.
const walletToasts = new Map<string, WalletToastData>();
const walletToastTimers = new Map<string, ReturnType<typeof setTimeout>>();
const walletToastListeners = new Set<(toasts: WalletToastData[]) => void>();

const notifyWalletToasts = () => {
  const snapshot = [...walletToasts.values()];
  walletToastListeners.forEach((listener) => listener(snapshot));
};

const clearWalletToastTimer = (id: string) => {
  const timer = walletToastTimers.get(id);
  if (timer) clearTimeout(timer);
  walletToastTimers.delete(id);
};

/**
 * Shows a wallet status toast. Toasts with different `id`s stack on screen at
 * the same time; showing a toast with an existing `id` replaces it in place.
 * Toasts without an `id` share a single slot.
 */
export const showWalletStatusToast = ({
  id = DEFAULT_WALLET_TOAST_ID,
  title,
  message,
  status,
}: Omit<WalletToastData, "id"> & { id?: string }) => {
  logFlow("wallet", "showWalletStatusToast", { id, title, message, status });
  clearWalletToastTimer(id);
  walletToasts.set(id, { id, title, message, status });
  notifyWalletToasts();

  if (status !== "progress") {
    walletToastTimers.set(
      id,
      setTimeout(() => {
        walletToastTimers.delete(id);
        walletToasts.delete(id);
        notifyWalletToasts();
      }, WALLET_TOAST_DISMISS_MS),
    );
  }
};

/** Clears one toast by `id`, or every wallet toast when no `id` is given. */
export const clearWalletStatusToast = (id?: string) => {
  logFlow("wallet", "clearWalletStatusToast", { id });
  if (id === undefined) {
    walletToastTimers.forEach((timer) => clearTimeout(timer));
    walletToastTimers.clear();
    walletToasts.clear();
  } else {
    clearWalletToastTimer(id);
    walletToasts.delete(id);
  }
  notifyWalletToasts();
};

export const Toastable = () => {
  const { top } = useSafeAreaInsets();

  return (
    <>
      <ReactNativeToastable
        position="top"
        offset={top}
        renderContent={(props) => <ToastCard {...props} />}
      />
      <WalletStatusToast />
    </>
  );
};

const ToastCard = ({
  title,
  message,
  status = "info",
  onPress,
  style,
}: ToastCardProps) => {
  const theme = useTheme();
  const statusColor =
    status === "success"
      ? "#16a34a"
      : status === "danger"
        ? "#dc2626"
        : status === "warning"
          ? "#d97706"
          : theme.colors.primary;

  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      disabled={!onPress}
      onPress={onPress}
      pointerEvents={onPress ? "auto" : "none"}
      style={[
        {
          minHeight: 72,
          flexDirection: "row",
          alignItems: "center",
          paddingHorizontal: 16,
          paddingVertical: 12,
          borderWidth: 1,
          borderColor: theme.colors.border,
          borderRadius: 16,
          backgroundColor: theme.colors.card,
          shadowColor: "#000",
          shadowOffset: { width: 0, height: 3 },
          shadowOpacity: 0.16,
          shadowRadius: 8,
        },
        style,
      ]}
    >
      <View
        style={{
          width: 28,
          alignItems: "center",
          justifyContent: "center",
          marginRight: 12,
        }}
      >
        {status === "progress" ? (
          <ActivityIndicator size="small" color={statusColor} />
        ) : (
          <View
            style={{
              width: 12,
              height: 12,
              borderRadius: 6,
              backgroundColor: statusColor,
            }}
          />
        )}
      </View>
      <View style={{ flex: 1 }}>
        {title != null && (
          <Text
            style={{
              color: theme.colors.text,
              fontSize: 15,
              fontWeight: "600",
            }}
          >
            {title}
          </Text>
        )}
        {message != null && (
          <Text
            style={{
              color: theme.colors.text,
              fontSize: 13,
              opacity: 0.75,
              marginTop: title != null ? 2 : 0,
            }}
          >
            {message}
          </Text>
        )}
      </View>
    </Pressable>
  );
};

export const WalletStatusToast = () => {
  const { top } = useSafeAreaInsets();
  const [toasts, setToasts] = useState(() => [...walletToasts.values()]);

  useEffect(() => {
    logFlow("wallet", "WalletStatusToast mounted", {
      toastCount: walletToasts.size,
    });
    walletToastListeners.add(setToasts);
    setToasts([...walletToasts.values()]);
    return () => {
      logFlow("wallet", "WalletStatusToast unmounted");
      walletToastListeners.delete(setToasts);
    };
  }, []);

  if (toasts.length === 0) return null;

  return (
    <View
      pointerEvents="none"
      style={{
        position: "absolute",
        top: top + 8,
        left: 16,
        right: 16,
        zIndex: 1000,
        elevation: 20,
        gap: WALLET_TOAST_GAP,
      }}
    >
      {toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          title={toast.title}
          message={toast.message}
          status={toast.status}
        />
      ))}
    </View>
  );
};
