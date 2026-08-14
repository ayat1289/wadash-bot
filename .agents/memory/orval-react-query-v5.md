---
name: Orval + react-query v5 query options
description: Overriding a generated hook's query option requires passing queryKey too.
---

When calling an Orval-generated React Query hook (e.g. `useGetWhatsappStatus`) and passing the `query` option to override things like `refetchInterval`, you MUST also include `queryKey: getXxxQueryKey()`.

**Why:** With react-query v5 the generated `query` option is typed as the full `UseQueryOptions`, which makes `queryKey` required. Passing `{ query: { refetchInterval: 3000 } }` alone fails typecheck (TS2741: `queryKey` missing), even though the hook supplies a key internally at runtime.

**How to apply:** The query-key helpers are exported from the api-client barrel (e.g. `getGetWhatsappStatusQueryKey`). Pass `{ query: { queryKey: getGetWhatsappStatusQueryKey(), refetchInterval: 3000 } }`. Do not edit generated files — fix the caller.
