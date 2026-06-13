import "./globals.css";
import { Analytics } from "@vercel/analytics/next";

export const metadata = {
  title: "YouTube Subscription Sweeper",
  description: "Preview and unsubscribe from YouTube subscriptions by regex.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
