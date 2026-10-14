import { useAuth } from "./agent";

/**
 * @deprecated Use useAuth().logout directly instead
 */
export const useLogOut = () => {
  const { logout } = useAuth();
  return logout;
};
