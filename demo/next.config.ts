import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Both calls use the page's origin; only Next.js connects to the configured relayer.
  // Keep the two destinations fixed, rather than exposing an arbitrary URL proxy.
  async rewrites() {
    const relayer = (process.env.NEXT_PUBLIC_RELAYER_URL?.trim() || 'http://127.0.0.1:8787').replace(/\/+$/, '');
    return ['health', 'relay'].map(endpoint => ({
      source: `/api/relayer/${endpoint}`, destination: `${relayer}/${endpoint}`,
    }));
  },
  // The demo consumes the @usl/sdk workspace package from TypeScript source.
  transpilePackages: ['@usl/sdk'],
  // Lint runs explicitly with `npm --workspace demo run lint`; type errors fail the build.
  eslint: { ignoreDuringBuilds: true },
  webpack: (config) => {
    // The SDK is TypeScript source written with explicit '.js' specifiers (NodeNext style),
    // so webpack must be told that './x.js' may mean './x.ts'.
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
