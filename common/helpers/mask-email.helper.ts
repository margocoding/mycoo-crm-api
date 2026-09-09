export function maskEmail(email: string): string {
  const [local, domain] = email.split('@');

  if (!local || !domain) {
    return '***';
  }

  const visible = local.slice(0, 2);
  const masked = '*'.repeat(Math.max(local.length - 2, 0));

  return `${visible}${masked}@${domain}`;
}
