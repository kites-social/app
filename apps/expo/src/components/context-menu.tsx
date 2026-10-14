import { type JSX } from "react";
import { type ViewProps } from "react-native";

export interface ContexMenuItem {
  key: string;
  label: string;
  action: () => void;
  icon: string;
  destructive?: boolean;
  reactIcon: JSX.Element;
}

interface Props extends ViewProps {
  menu: ContexMenuItem[];
}

export const ContextMenuButton = (_props: Props) => {};
