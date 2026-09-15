// Plain JavaScript on purpose. A next.config.ts makes Next load TypeScript at runtime,
// and the production image ships without devDependencies -- Next then tries to npm-install
// typescript on boot, which needs network the assignment forbids after startup.

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // verify.sh curls "/" without following redirects, so "/" must serve real content.
  poweredByHeader: false,
};

export default nextConfig;
