import "./globals.css";

export const metadata = {
  title: "Warframe 仲裁 ee.log 分析",
  description: "上传 ee.log，解析仲裁任务区间并统计 Spawned 与无人机数量。",
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

