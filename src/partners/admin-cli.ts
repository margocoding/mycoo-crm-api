import 'dotenv/config';
import { PrismaService } from '../../prisma/prisma.service.js';
import { hashPartnerAdminPassword } from './partner-admin-auth.service.js';

class AdminSetupError extends Error {}

// This bootstrap intentionally does not reset or replace an existing administrator.
async function main() {
  const login = process.env.PARTNER_ADMIN_LOGIN?.trim().toLowerCase() ?? '';
  const password = process.env.PARTNER_ADMIN_PASSWORD ?? '';
  if (login.length < 3 || login.length > 100 || password.length < 8 || password.length > 256) {
    throw new AdminSetupError('Укажите PARTNER_ADMIN_LOGIN (3–100 символов) и PARTNER_ADMIN_PASSWORD (8–256 символов).');
  }
  const prisma = new PrismaService();
  try {
    await prisma.$connect();
    const passwordHash = await hashPartnerAdminPassword(password);
    await prisma.$transaction(async tx => {
      // Serialize concurrent first-run commands without storing a bootstrapping password.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(74829031)`;
      if (await tx.partnerAdmin.count()) throw new AdminSetupError('Администратор уже существует. Меняйте логин и пароль в настройках кабинета.');
      await tx.partnerAdmin.create({ data: { login, passwordHash } });
    });
    console.log('Администратор партнёрской программы создан.');
  } finally { await prisma.$disconnect(); }
}

main().catch(error => {
  console.error(error instanceof AdminSetupError ? error.message : 'Не удалось создать администратора. Проверьте подключение и миграции.');
  process.exitCode = 1;
});
