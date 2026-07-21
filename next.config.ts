import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	experimental: {
		serverActions: {
			allowedOrigins: ["*.app.github.dev", "localhost:3000"],
		},
	},
};

export default nextConfig;
