import { ClassConstructor, plainToInstance } from 'class-transformer';

export function fillDto<T extends object, V>(
  rdoClass: ClassConstructor<T>,
  input: V,
): T {
  return plainToInstance(rdoClass, input, {
    excludeExtraneousValues: true,
    exposeDefaultValues: true,
  });
}
