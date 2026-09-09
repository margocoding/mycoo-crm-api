import { ClassConstructor } from 'class-transformer';
export declare function fillDto<T extends object, V>(rdoClass: ClassConstructor<T>, input: V): T;
