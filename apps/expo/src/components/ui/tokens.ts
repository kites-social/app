import { useMemo } from "react";
import { useTheme } from "@react-navigation/native";

export type Tone = "primary" | "positive" | "negative" | "warning" | "neutral";

/** Corner radii used across cards, controls, and inputs. */
export const radius = {
  card: 20,
  control: 14,
  input: 14,
  pill: 999,
} as const;

/** Continuous corners give iOS the smooth "squircle" look. */
export const continuousCorners = { borderCurve: "continuous" } as const;

export interface UiTheme {
  dark: boolean;
  background: string;
  card: string;
  /** Slightly recessed surface used for inputs and segmented tracks. */
  inset: string;
  border: string;
  text: string;
  muted: string;
  primary: string;
  positive: string;
  negative: string;
  warning: string;
  positiveSoft: string;
  negativeSoft: string;
  warningSoft: string;
  primarySoft: string;
  placeholder: string;
  toneColor: (tone: Tone) => string;
  toneSoft: (tone: Tone) => string;
}

/** Semantic design tokens derived from the active navigation theme. */
export function useUi(): UiTheme {
  const theme = useTheme();
  const dark = theme.dark;

  return useMemo(() => {
    const positive = dark ? "#4ade80" : "#15803d";
    const negative = dark ? "#f87171" : "#b91c1c";
    const warning = dark ? "#fbbf24" : "#b45309";
    const muted = dark ? "#a3a3a3" : "#6b7280";
    const inset = dark ? "rgba(255,255,255,0.05)" : "rgba(15,23,42,0.04)";
    const positiveSoft = dark ? "rgba(34,197,94,0.14)" : "rgba(22,101,52,0.08)";
    const negativeSoft = dark ? "rgba(239,68,68,0.14)" : "rgba(153,27,27,0.07)";
    const warningSoft = dark ? "rgba(245,158,11,0.14)" : "rgba(180,83,9,0.09)";
    const primarySoft = dark ? "rgba(255,255,255,0.08)" : "rgba(15,23,42,0.06)";

    const toneColor = (tone: Tone) =>
      ({
        primary: theme.colors.primary,
        positive,
        negative,
        warning,
        neutral: muted,
      })[tone];
    const toneSoft = (tone: Tone) =>
      ({
        primary: primarySoft,
        positive: positiveSoft,
        negative: negativeSoft,
        warning: warningSoft,
        neutral: inset,
      })[tone];

    return {
      dark,
      background: theme.colors.background,
      card: theme.colors.card,
      inset,
      border: theme.colors.border,
      text: theme.colors.text,
      muted,
      primary: theme.colors.primary,
      positive,
      negative,
      warning,
      positiveSoft,
      negativeSoft,
      warningSoft,
      primarySoft,
      placeholder: dark ? "#737373" : "#a3a3a3",
      toneColor,
      toneSoft,
    };
  }, [dark, theme.colors]);
}
