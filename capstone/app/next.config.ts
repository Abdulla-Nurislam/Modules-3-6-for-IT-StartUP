import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  turbopack: {
    resolveAlias: {
      fs: {
        browser: "./src/lib/empty-fs.ts",
      },
    },
  },
};

export default nextConfig;
