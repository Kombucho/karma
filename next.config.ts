import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * The engine reads validation/*.json and seed/*.json at request time via dynamic
   * readdirSync/readFileSync, which Next's static file tracing cannot see. Without this,
   * a serverless deploy ships with zero wallets and every card 404s. The map key applies
   * the includes to every route.
   */
  outputFileTracingIncludes: {
    "/**": ["./validation/**/*.json", "./seed/**/*.json"],
  },
};

export default nextConfig;
