export const AUTH_REDIS_KEYS = {
  code: (email: string) => `auth:code:${email}`,
  cooldown: (email: string) => `auth:code:cooldown:${email}`,
};
