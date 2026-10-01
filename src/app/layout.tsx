import type { Metadata, Viewport } from 'next';
import './globals.css';
import { ServiceWorkerRegistrar } from '@/components/shell/ServiceWorkerRegistrar';

export const metadata: Metadata = {
  title: { default: 'Inventory', template: '%s · Inventory' },
  description: 'Private restaurant inventory and food-cost system.',
  robots: { index: false, follow: false },
  appleWebApp: { capable: true, title: 'Inventory', statusBarStyle: 'default' },
  icons: { icon: '/icons/icon-192.png', apple: '/icons/apple-touch-icon.png' },
};

export const viewport: Viewport = {
  themeColor: '#0f766e',
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">
        {children}
        <ServiceWorkerRegistrar />
      </body>
    </html>
  );
}
