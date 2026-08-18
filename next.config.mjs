/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Never answer a POST with a 308 trailing-slash redirect. Payme's Merchant
  // API refuses to follow redirects and treats a 308 as a failure, so a
  // cabinet endpoint typed with a trailing slash (/api/payme/) would break the
  // whole integration. Disabling the redirect lets both /api/payme and
  // /api/payme/ reach the handler.
  skipTrailingSlashRedirect: true,
  // Keep server-only packages out of the client bundle.
  // (Next 14 key; renamed to `serverExternalPackages` in Next 15.)
  experimental: {
    serverComponentsExternalPackages: ["bullmq", "ioredis", "isomorphic-dompurify"],
  },
  images: {
    remotePatterns: [{ protocol: "https", hostname: "**" }],
  },
};

export default nextConfig;
