/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Never answer a POST with a 308 trailing-slash redirect. Payme's Merchant
  // API refuses to follow redirects and treats a 308 as a failure, so a
  // cabinet endpoint typed with a trailing slash (/api/payme/) would break the
  // whole integration. Disabling the redirect lets both /api/payme and
  // /api/payme/ reach the handler.
  skipTrailingSlashRedirect: true,
  // (No serverComponentsExternalPackages: the queue/sanitiser packages it used
  // to list — bullmq, ioredis, isomorphic-dompurify — were left over from the
  // removed storefront and worker, and have been uninstalled.)
  // No `images.remotePatterns`. It used to allow every https host ("**"), which
  // is the exact configuration named by the Next.js Image Optimizer DoS advisory:
  // a wildcard lets anyone make this server fetch and re-encode arbitrary remote
  // images. Nothing here needs it — `next/image` is not used anywhere in the
  // project (the admin panel renders no remote images at all), so the whole
  // surface is simply removed rather than upgraded around.
};

export default nextConfig;
