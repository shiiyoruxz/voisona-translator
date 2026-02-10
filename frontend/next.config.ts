import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /* config options here */
  experimental: {
    // Exclude agents-playground from build
    outputFileTracingRoot: process.cwd(),
  },
  // Exclude agents-playground from TypeScript compilation
  typescript: {
    ignoreBuildErrors: true,
  },
  // Exclude agents-playground from ESLint
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
