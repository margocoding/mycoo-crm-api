import { BadRequestException } from '@nestjs/common';
import { basename, extname } from 'node:path';

export const COO_FILE_SIZE = 10 * 1024 * 1024;
export const COO_FILE_COUNT = 5;
export interface CooUpload { buffer: Buffer; originalname: string; size: number; }

const MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export function validateCooFile(file?: CooUpload) {
  if (!file?.buffer?.length) throw new BadRequestException('Выберите непустой документ.');
  if (file.buffer.length > COO_FILE_SIZE) throw new BadRequestException('Размер документа не должен превышать 10 МБ.');
  // Multipart filenames may arrive as UTF-8 bytes interpreted as Latin-1.
  const decoded = Buffer.from(file.originalname, 'latin1').toString('utf8');
  const original = [...file.originalname].some(char => char.charCodeAt(0) > 255) || decoded.includes('\ufffd') ? file.originalname : decoded;
  const name = [...basename(original.replace(/\\/g, '/'))].filter(char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) !== 127).join('').trim();
  const extension = extname(name).toLowerCase();
  if (!name || name.length > 180 || !MIME[extension])
    throw new BadRequestException('Поддерживаются PDF, DOCX, XLSX и PPTX; имя — до 180 символов.');
  const validSignature = extension === '.pdf'
    ? file.buffer.subarray(0, 5).toString('ascii') === '%PDF-'
    : file.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  if (!validSignature) throw new BadRequestException('Содержимое файла не соответствует формату документа.');
  return { name, mimeType: MIME[extension], size: file.buffer.length, buffer: file.buffer };
}
