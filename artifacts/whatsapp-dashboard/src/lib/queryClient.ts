import { QueryClient } from "@tanstack/react-query";

// Single shared client. Auth/tenant errors (401/409) must not be retried — they
// are resolved by signing in or linking, not by hammering the endpoint.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: false,
    },
  },
});
