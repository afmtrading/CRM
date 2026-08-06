import type { Metadata } from 'next'

import './globals.css'

export const metadata: Metadata = {
  title: 'FLO CRM',
  description: 'Internal CRM for the FLO Ventures portfolio',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen font-sans">{children}</body>
    </html>
  )
}
