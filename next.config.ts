import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  experimental: {
    // Server actions receive CSV payloads during import previews.
    serverActions: { bodySizeLimit: '10mb' },
  },
  /**
   * The public forms are meant to be framed.
   *
   * Which is unusual enough to say out loud. Every other page here would be a
   * clickjacking target inside somebody else's iframe, and the platform default
   * of refusing is right for them. A lead-capture form is the exception: an
   * iframe is how it gets onto a customer's website, and a form that refuses to
   * be framed is a form that cannot do its job.
   *
   * frame-ancestors rather than X-Frame-Options because only the former can say
   * "anyone", and it is the one modern browsers obey when both are present.
   * There is nothing to steal by framing this: no session, no authenticated
   * action, and every submission validated on the server against the form's own
   * question list.
   */
  async headers() {
    return [
      {
        source: '/f/:slug*',
        headers: [{ key: 'Content-Security-Policy', value: 'frame-ancestors *' }],
      },
    ]
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
