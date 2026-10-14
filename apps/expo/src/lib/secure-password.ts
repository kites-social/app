import { requireOptionalNativeModule } from "expo-modules-core";
import { Platform } from "react-native";

interface SecurePasswordModule {
  maskImmediately: (viewTag: number) => Promise<void>;
}

const securePasswordModule =
  Platform.OS === "android"
    ? requireOptionalNativeModule<SecurePasswordModule>("SecurePassword")
    : null;

export function maskPasswordImmediately(viewTag: number) {
  void securePasswordModule?.maskImmediately(viewTag).catch(console.error);
}
