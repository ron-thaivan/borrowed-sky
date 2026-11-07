export const DEFAULT_CONFIG = Object.freeze({width:192, height:128, count:120, fps:20});
export const HARD_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const REQUEST_METADATA_BYTES = 16 * 1024;

export function validateConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid rendering configuration');
  const config = {...DEFAULT_CONFIG, ...input};
  for (const key of ['width','height','count','fps']) {
    if (!Number.isInteger(config[key]) || config[key] < 1) throw new Error(`Invalid ${key}`);
  }
  if (config.width > 2048 || config.height > 2048 || config.count > 600 || config.fps > 100 ||
      config.width * config.height * config.count > 128 * 1024 * 1024) {
    throw new Error('Rendering configuration exceeds supported limits');
  }
  return Object.freeze(config);
}

export function frameRequestLimit(config) {
  return 4 * Math.ceil(config.width * config.height / 3) + REQUEST_METADATA_BYTES;
}
