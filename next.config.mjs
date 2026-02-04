const isGithubActions = process.env.GITHUB_ACTIONS === "true";
const repoName = process.env.GITHUB_REPOSITORY?.split("/")?.[1];

// GitHub Pages 通常部署在 /<repo>/ 下；本地 dev 保持根路径。
const inferredBasePath =
  isGithubActions && repoName ? `/${repoName}` : "";

const basePath =
  process.env.NEXT_PUBLIC_BASE_PATH ??
  inferredBasePath;

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  basePath,
  assetPrefix: basePath ? `${basePath}/` : undefined,
};

export default nextConfig;

