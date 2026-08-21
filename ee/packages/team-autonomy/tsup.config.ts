import { defineConfig } from "tsup"

export default defineConfig({
  entry: {
    index: "src/index.ts",
    "db/index": "src/db/index.ts",
    "db/schema": "src/db/schema.ts",
    "http/routes": "src/http/routes.ts",
    "auth/hook": "src/auth/hook.ts",
    "ui/manifest": "src/ui/manifest.ts",
  },
  format: ["esm"],
  dts: true,
  clean: true,
  target: "es2022",
  platform: "node",
  sourcemap: false,
  splitting: false,
  treeshake: true,
})
