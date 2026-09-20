import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
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
