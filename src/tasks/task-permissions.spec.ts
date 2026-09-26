import { describe, expect, it } from 'vitest';
import { canEditAssignedTask } from './task-permissions.js';

describe('Task assignment hierarchy', () => {
  it('lets the owner manage tasks from every assigning role, including shared tasks', () => {
    for (const role of ['OWNER', 'CHIEF', 'ADMIN', null] as const)
      expect(canEditAssignedTask(true, undefined, role, 2)).toBe(true);
  });
  it('blocks a chief from editing owner assignments', () => {
    expect(canEditAssignedTask(false, 'CHIEF', 'OWNER', 1)).toBe(false);
  });
  it('blocks an administrator from editing chief and owner assignments', () => {
    for (const role of ['CHIEF', 'OWNER'] as const)
      expect(canEditAssignedTask(false, 'ADMIN', role, 1)).toBe(false);
  });
  it('allows management of assignments at the same or a lower level', () => {
    expect(canEditAssignedTask(false, 'CHIEF', 'CHIEF', 1)).toBe(true);
    expect(canEditAssignedTask(false, 'CHIEF', 'ADMIN', 1)).toBe(true);
    expect(canEditAssignedTask(false, 'ADMIN', 'ADMIN', 1)).toBe(true);
  });
  it('never lets a worker or an outsider edit tasks', () => {
    expect(canEditAssignedTask(false, 'WORKER', null, 1)).toBe(false);
    expect(canEditAssignedTask(false, undefined, null, 1)).toBe(false);
  });
  it('keeps the existing owner-only restriction for shared tasks', () => {
    expect(canEditAssignedTask(false, 'CHIEF', 'ADMIN', 2)).toBe(false);
  });
  it('preserves previous manager permissions for tasks without assignment history', () => {
    expect(canEditAssignedTask(false, 'CHIEF', null, 1)).toBe(true);
    expect(canEditAssignedTask(false, 'ADMIN', null, 1)).toBe(true);
  });
});
