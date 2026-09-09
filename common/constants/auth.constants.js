export const AUTH_REDIS_KEYS = {
    code: (email) => `auth:code:${email}`,
    cooldown: (email) => `auth:code:cooldown:${email}`,
};
//# sourceMappingURL=auth.constants.js.map