import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Server actions receive CSV payloads during import previews.
    serverActions: { bodySizeLimit: '10mb' },
  },
}

export default nextConfig
