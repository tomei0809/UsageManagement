import { defineConfig } from "vitest/config";

// 純粋関数のユニットテスト用(vite.config.ts の Cloudflare プラグインを読み込まない)
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
