import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Server actions receive CSV payloads during import previews.
    serverActions: { bodySizeLimit: '10mb' },
  },
  /**
   * Where the sales orders used to live.
   *
   * The section is called Purchase orders now and the routes moved with it,
   * which would otherwise turn every link anybody has kept — a bookmark, a
   * pasted URL in an email, a row in somebody's spreadsheet — into a 404 for a
   * record that is still there under a different address.
   *
   * Permanent, because it is: the old path is not coming back, and a permanent
   * redirect is the one browsers and search engines stop asking about.
   */
  async redirects() {
    return [
      { source: '/sales-orders', destination: '/purchase-orders', permanent: true },
      { source: '/sales-orders/:path*', destination: '/purchase-orders/:path*', permanent: true },
    ]
  },
}

export default nextConfig
