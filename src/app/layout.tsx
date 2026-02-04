import "./globals.css";

export const metadata = {
  title: "arbitration-log",
  description: "arbitration-log",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

