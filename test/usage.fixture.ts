import { vi } from 'vitest';
import type { UsageService } from '../src/usage/usage.service.js';

export const usageScope = { workspaceId: 'company', actorId: 'owner', source: 'test' };
export function usageFixture() {
  return {
    rates: vi.fn(() => ({ input: 65, output: 65 })),
    reserve: vi.fn(async () => ({ id: 'usage-reservation' })),
    settle: vi.fn(async () => {}),
    assertSeat: vi.fn(async () => {}),
    assertTasks: vi.fn(async () => {}),
    reserveStorage: vi.fn(async () => ({ id: 'storage-reservation' })),
    releaseStorage: vi.fn(async () => {}),
    lockStorage: vi.fn(async () => {}),
    speechAmount: vi.fn((seconds: number) => ({ costMicros: 10100 * seconds, inputTokens: 0, outputTokens: 0, audioSeconds: seconds })),
  } as unknown as UsageService;
}
