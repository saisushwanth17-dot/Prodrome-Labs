/** @type {import('next').NextConfig} */
// nextjs-integration/next.config.mjs
// Blueprint for Person 4 (Next.js 14 App Router UI integration)

const nextConfig = {
  reactStrictMode: true,
  // 1. Cross-Origin Headers required for Silero VAD & ONNX Runtime WebAssembly SIMD/threading
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          {
            key: 'Cross-Origin-Opener-Policy',
            value: 'same-origin',
          },
          {
            key: 'Cross-Origin-Embedder-Policy',
            value: 'credentialless',
          },
        ],
      },
    ];
  },

  // 2. Ignore server-side Node polyfills (fs/path) when bundling onnxruntime-web for client
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        path: false,
        crypto: false,
      };
    }
    return config;
  },
};

export default nextConfig;
