import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Server actions receive CSV payloads during import previews.
    serverActions: { bodySizeLimit: '10mb' },
  },
  /**
   * Where the orders briefly lived.
   *
   * They were at /sales-orders, moved to /purchase-orders for an afternoon,
   * and are back. Anybody who followed a link in between still has
   * /purchase-orders in their history, so it points home rather than 404ing on
   * a record that is right there under its old address.
   *
   * Temporary rather than permanent, and deliberately: a 308 is the one
   * browsers cache and stop asking about, and this pair has now moved twice.
   * A 307 costs one request and can be withdrawn without anybody holding a
   * cached instruction to the contrary.
   */
  async redirects() {
    return [
      { source: '/purchase-orders', destination: '/sales-orders', permanent: false },
      {
        source: '/purchase-orders/:path*',
        destination: '/sales-orders/:path*',
        permanent: false,
      },
    ]
  },
}

export default nextConfig
