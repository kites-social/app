import { createContext, useContext } from "react";
import { AtpAgent, type AtpSessionData } from "@atproto/api";

import { atprotoUrls } from "./atproto-urls";

export const defaultAgent = new AtpAgent({
  service: atprotoUrls.appView,
});

// Agent context - provides the current agent instance
const agentContext = createContext<AtpAgent>(defaultAgent);

export const AgentProvider = agentContext.Provider;

export const useAgent = () => {
  const agent = useContext(agentContext);
  return agent;
};

export const useOptionalAgent = () => {
  return useContext(agentContext);
};

// Auth context - provides auth actions
export interface AuthContextValue {
  login: (
    identifier: string,
    password: string,
    authFactorToken?: string,
  ) => Promise<void>;
  resumeSession: (session: AtpSessionData, pdsUrl?: string) => Promise<void>;
  logout: () => void;
}

const authContext = createContext<AuthContextValue | null>(null);

export const AuthProvider = authContext.Provider;

export const useAuth = () => {
  const auth = useContext(authContext);
  if (!auth) throw new Error("AuthContext not found");
  return auth;
};
