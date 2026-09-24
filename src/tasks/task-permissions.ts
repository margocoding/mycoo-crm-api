import type { DepartmentRole, TaskAssigningRole } from '../../generated/prisma/enums.js';

const ranks = { OWNER: 3, CHIEF: 2, ADMIN: 1, WORKER: 0 };

export function canEditAssignedTask(isOwner: boolean, role: DepartmentRole | undefined,
  assignedByRole: TaskAssigningRole | null, departmentCount: number) {
  if (isOwner) return true;
  if (!role || role === 'WORKER' || departmentCount !== 1) return false;
  // Existing tasks have no assignment history; keep their previous permissions.
  return ranks[role] >= (assignedByRole ? ranks[assignedByRole] : 0);
}
