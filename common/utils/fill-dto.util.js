import { plainToInstance } from 'class-transformer';
export function fillDto(rdoClass, input) {
    return plainToInstance(rdoClass, input, {
        excludeExtraneousValues: true,
        exposeDefaultValues: true,
    });
}
//# sourceMappingURL=fill-dto.util.js.map