import { useCallback } from "react";
import { Platform } from "react-native";
import { SystemBars } from "react-native-edge-to-edge";
import { useFocusEffect, useTheme } from "@react-navigation/native";

import { isIOS26 } from "~/lib/utils/version";

interface Props {
  style?: "light" | "dark" | "auto";
  modal?: boolean;
  applyToNavigationBar?: boolean;
}

export const StatusBar = ({ style, modal, applyToNavigationBar }: Props) => {
  const theme = useTheme();

  useFocusEffect(
    useCallback(() => {
      let statusBarStyle: "light" | "dark" =
        style && style !== "auto" ? style : theme.dark ? "light" : "dark";
      if (modal) {
        if (Platform.OS === "ios" ? Platform.isPad || isIOS26 : true) {
          // use whatever the underlying screen is using
          return;
        } else {
          statusBarStyle = style && style !== "auto" ? style : "light";
        }
      }
      const entry = SystemBars.pushStackEntry({
        style: {
          statusBar: statusBarStyle,
          navigationBar: applyToNavigationBar ? statusBarStyle : undefined,
        },
      });
      return () => {
        SystemBars.popStackEntry(entry);
      };
    }, [applyToNavigationBar, modal, style, theme.dark]),
  );

  return null;
};
