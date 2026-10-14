import Constants from "expo-constants";

export const kitesDevEnabled =
  Constants.expoConfig?.extra?.kitesDev === true;
