import { useCallback } from "react";
import { Stack, useFocusEffect } from "expo-router";
import { msg } from "@lingui/macro";
import { useLingui } from "@lingui/react";
import { useQueryClient } from "@tanstack/react-query";

import { ProfileBalances } from "~/components/screens/profile/profile-balances";
import { appChainBalancesQueryKey, web3BalancesQueryKey } from "~/lib/web3";

export default function BalancesScreen() {
  const { _ } = useLingui();
  const queryClient = useQueryClient();

  useFocusEffect(
    useCallback(() => {
      void queryClient.invalidateQueries({ queryKey: web3BalancesQueryKey });
      void queryClient.invalidateQueries({
        queryKey: appChainBalancesQueryKey,
      });
    }, [queryClient]),
  );

  return (
    <>
      <Stack.Screen options={{ title: _(msg`Wallet`) }} />
      <ProfileBalances />
    </>
  );
}
