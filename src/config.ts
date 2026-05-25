// Cloud config extracted from /Applications/Habitat.app/Wrapper/Habitat.app/www/main.*.js
// (Habitat HomeLink iOS app, downloaded from Mac App Store).
// See docs/cloud-api-reverse-engineering.md for how these were discovered.

export const REGION = "us-west-2";
export const USER_POOL_ID = "us-west-2_UqKk6Qvs1";
export const USER_POOL_CLIENT_ID = "ji4tv7q81n7rbbmv1bkmkeb8i";
export const IDENTITY_POOL_ID = "us-west-2:ba429fe0-7865-4c71-8715-287b89ec7b5f";

// Min/max setpoints accepted by this CLI — refuses anything outside this range
// as a safety net against typos. Adjust if your unit operates differently.
export const SETPOINT_MIN_F = 50;
export const SETPOINT_MAX_F = 90;
