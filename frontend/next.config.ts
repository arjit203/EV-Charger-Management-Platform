import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The dev-only badge defaults to bottom-left, where it sat on top of the sidebar's footer.
  devIndicators: { position: 'bottom-right' },
};

export default nextConfig;
