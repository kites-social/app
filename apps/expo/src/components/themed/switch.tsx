import { Switch, type SwitchProps } from "react-native";
import { useTheme } from "@react-navigation/native";

import { KitesColors } from "~/lib/theme";

export const ThemedSwitch = (props: SwitchProps) => {
  const theme = useTheme();
  const inactiveTrackColor = theme.dark ? "#3A443D" : "#DEE7E1";

  return (
    <Switch
      {...props}
      trackColor={{
        false: inactiveTrackColor,
        true: theme.colors.primary ?? KitesColors.primary,
      }}
      thumbColor="#FFFFFF"
      ios_backgroundColor={inactiveTrackColor}
    />
  );
};
