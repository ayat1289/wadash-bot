---
name: Clerk shadcn theme on Tailwind v4
description: How to make Clerk's prebuilt shadcn theme render correctly in a Tailwind v4 + Vite artifact without style collisions.
---

When embedding Clerk's `<SignIn>/<SignUp>` with the `@clerk/themes` `shadcn` theme in a Tailwind v4 artifact, four things must line up or Clerk renders unstyled / its styles get stripped:

1. `src/index.css` must declare the cascade layer order **before** importing Tailwind:
   `@layer theme, base, clerk, components, utilities;` then `@import "tailwindcss";`
2. Import the Clerk theme stylesheet: `@import "@clerk/themes/shadcn.css";`
3. In the `ClerkProvider` `appearance`, set `theme: shadcn` and `cssLayerName: "clerk"` so Clerk emits into the declared `clerk` layer.
4. In `vite.config.ts`, the Tailwind plugin must run with `tailwindcss({ optimize: false })`.

**Why:** Tailwind v4's optimizer prunes/“lightning-css”-rewrites CSS it doesn't see referenced, which strips Clerk's runtime-injected classes; and without an explicit `@layer` order Clerk's styles land in an unpredictable layer and lose to Tailwind utilities. The named `clerk` layer + `optimize:false` keeps Clerk's styles intact and correctly ordered.

**How to apply:** Any new Vite+Tailwind-v4 artifact that uses Clerk prebuilt components. Theme tokens (primary color, font, radius) go in `appearance.variables` as `hsl(...)` strings; element overrides use Tailwind arbitrary values with underscores for spaces, e.g. `text-[hsl(222.2_84%_4.9%)]`.
