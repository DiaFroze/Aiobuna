/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
