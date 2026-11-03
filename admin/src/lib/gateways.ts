/** The two gateways the console may call (spec M1: connect-src <gateway>). */
export const GATEWAYS = {
  test: "https://stereo3d-gateway-test-151335782809.us-central1.run.app",
  prod: "https://stereo3d-gateway-prod-151335782809.us-central1.run.app",
} as const;
