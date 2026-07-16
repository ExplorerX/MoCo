import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "Morse Learning Lab", template: "%s · Morse Learning Lab" },
  description: "声音优先、离线可用的 Morse Code 学习、听抄、发报与转换工具。",
  applicationName: "Morse Learning Lab",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
  openGraph: {
    title: "Morse Learning Lab",
    description: "听、认、拍、查一体化的专业 Morse Code 训练实验室。",
    type: "website",
    locale: "zh_CN",
    images: [{ url: "/og.png", width: 1729, height: 910, alt: "Morse Learning Lab 信号节奏预览" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Morse Learning Lab",
    description: "听、认、拍、查一体化的专业 Morse Code 训练实验室。",
    images: ["/og.png"],
  },
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Morse Lab" },
};

export const viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover" as const,
  themeColor: "#0f1110",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body></html>;
}
