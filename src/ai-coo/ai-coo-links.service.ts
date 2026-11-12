import { Injectable } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';

export const COO_LINK_BYTES = 1024 * 1024;
export const COO_LINK_TIMEOUT_MS = 15_000;
const TEXT_LIMIT = 12_000;
// Remove non-printable bytes from remote text before adding it to the model context.
// eslint-disable-next-line no-control-regex
const CONTROL_BYTES = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export interface CooWebSource {
  type: 'url';
  url: string;
  title: string;
  status: 'read' | 'unavailable';
  error?: string;
  truncated?: boolean;
  text?: string;
}
export interface CooWebSources { sources: CooWebSource[]; omitted: number; }
type Budget = { remaining: number; deadline: number };
class LinkError extends Error {}

// Only globally routable IPv4 is supported. IPv6, mapped IPv4 and transition ranges are denied.
export function publicIPv4(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a, b, c] = address.split('.').map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || a === 100 && b >= 64 && b <= 127
    || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31
    || a === 192 && (b === 0 && (c === 0 || c === 2) || b === 88 && c === 99 || b === 168)
    || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)
    || a === 203 && b === 0 && c === 113);
}

export function publicPageUrl(value: string): URL {
  if (value.length > 2048) throw new LinkError('Ссылка слишком длинная.');
  let url: URL;
  try { url = new URL(value); } catch { throw new LinkError('Некорректная ссылка.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port)
    throw new LinkError('Доступны только публичные HTTP/HTTPS-страницы без авторизации и нестандартных портов.');
  if (url.hostname.startsWith('[') || isIP(url.hostname) && !publicIPv4(url.hostname))
    throw new LinkError('Внутренние и локальные адреса недоступны.');
  url.hash = '';
  return url;
}

export function messageLinks(text: string): string[] {
  return [...new Set((text.match(/https?:\/\/[^\s<>"'`]+/gi) || []).map((url) => url.replace(/[),.;!?\]}»]+$/, '')))];
}

async function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new LinkError('Сайт не ответил вовремя.');
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new LinkError('Сайт не ответил вовремя.')), remaining);
    })]);
  } finally { clearTimeout(timer); }
}

async function resolveAddress(url: URL, budget: Budget): Promise<string> {
  if (Date.now() >= budget.deadline) throw new LinkError('Сайт не ответил вовремя.');
  if (isIP(url.hostname)) return url.hostname;
  const addresses = await beforeDeadline(lookup(url.hostname, { family: 4, all: true, verbatim: true }), budget.deadline);
  if (!addresses.length || addresses.some(({ address }) => !publicIPv4(address)))
    throw new LinkError('Внутренние и локальные адреса недоступны.');
  return addresses[0].address;
}

function readResponse(url: URL, address: string, budget: Budget): Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const timeout = budget.deadline - Date.now();
    if (timeout <= 0) { reject(new LinkError('Сайт не ответил вовремя.')); return; }
    if (budget.remaining <= 0) { reject(new LinkError('Превышен общий лимит размера страниц (1 МБ).')); return; }
    // Lookup returns the checked address, never a second DNS result (DNS rebinding).
    const pinnedLookup = ((_hostname: string, options: { all?: boolean }, callback: (...args: any[]) => void) => {
      if (options.all) callback(null, [{ address, family: 4 }]);
      else callback(null, address, 4);
    }) as LookupFunction;
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: 'GET', agent: false, family: 4, lookup: pinnedLookup, maxHeaderSize: 16_384,
      headers: { Accept: 'text/html, text/plain', 'Accept-Encoding': 'identity', 'User-Agent': 'MyCoo/1.0' },
    }, (response) => {
      const status = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        finish(); resolve({ status, headers: response.headers, body: Buffer.alloc(0) }); response.destroy(); return;
      }
      const type = (response.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const encoding = response.headers['content-encoding'];
      const fail = (message: string) => { finish(); reject(new LinkError(message)); response.destroy(); request.destroy(); };
      if (status < 200 || status >= 300) { fail(`Страница недоступна (HTTP ${status}).`); return; }
      if (!['text/html', 'text/plain'].includes(type)) { fail('По этой ссылке не HTML-страница или текст. PDF и документы загрузите файлом.'); return; }
      if (encoding && encoding !== 'identity') { fail('Сайт вернул сжатый ответ, который нельзя прочитать. Загрузите материал файлом.'); return; }
      const expected = Number(response.headers['content-length']);
      if (Number.isFinite(expected) && expected > budget.remaining) { fail('Превышен общий лимит размера страниц (1 МБ).'); return; }
      const chunks: Buffer[] = [];
      response.on('data', (value: Buffer) => {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        if (chunk.length > budget.remaining) { budget.remaining = 0; fail('Превышен общий лимит размера страниц (1 МБ).'); return; }
        budget.remaining -= chunk.length;
        chunks.push(chunk);
      });
      response.on('end', () => { finish(); resolve({ status, headers: response.headers, body: Buffer.concat(chunks) }); });
      response.on('error', (error) => { finish(); reject(error); });
      response.on('aborted', () => { finish(); reject(new LinkError('Загрузка страницы прервалась.')); });
    });
    const timer = setTimeout(() => request.destroy(new LinkError('Сайт не ответил вовремя.')), timeout);
    const finish = () => clearTimeout(timer);
    request.on('error', (error) => { finish(); reject(error); });
    request.end();
  });
}

function decodeEntities(text: string): string {
  const names: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (original, entity: string) => {
    if (entity[0] !== '#') return names[entity.toLowerCase()] || original;
    const point = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : ' ';
  });
}

export function pageText(html: string, plain = false) {
  const strip = (value: string) => decodeEntities(value.replace(/<[^<>]*>/g, ' ').replace(/[<>]/g, ' ')).replace(CONTROL_BYTES, '').replace(/\s+/g, ' ').trim();
  const title = plain ? '' : strip(html.match(/<title\b[^<>]*>([\s\S]*?)(?:<\/title\s*>|$)/i)?.[1] || '').slice(0, 180);
  const text = plain ? html.replace(CONTROL_BYTES, '').trim()
    : strip(html.replace(/<!--[\s\S]*?(?:-->|$)/g, ' ').replace(/<(script|style|noscript|iframe|svg)\b[^<>]*>[\s\S]*?(?:<\/\1\s*>|$)/gi, ' '));
  return { title, text: text.slice(0, TEXT_LIMIT), truncated: text.length > TEXT_LIMIT };
}

@Injectable()
export class AiCooLinksService {
  async collect(question: string): Promise<CooWebSources> {
    const links = messageLinks(question);
    const budget = { remaining: COO_LINK_BYTES, deadline: Date.now() + COO_LINK_TIMEOUT_MS };
    const sources: CooWebSource[] = [];
    for (const link of links.slice(0, 3)) {
      let displayUrl = link.slice(0, 2048);
      try {
        let url = publicPageUrl(link);
        displayUrl = url.href;
        for (let redirect = 0; redirect <= 3; redirect++) {
          const address = await resolveAddress(url, budget);
          const response = await readResponse(url, address, budget);
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (!response.headers.location || redirect === 3) throw new LinkError('Слишком много перенаправлений.');
            url = publicPageUrl(new URL(response.headers.location, url).href);
            continue;
          }
          const charset = response.headers['content-type']?.match(/charset\s*=\s*["']?([^\s;"']+)/i)?.[1] || 'utf-8';
          let body: string;
          try { body = new TextDecoder(charset).decode(response.body); } catch { throw new LinkError('Кодировка страницы не поддерживается.'); }
          const parsed = pageText(body, response.headers['content-type']?.toLowerCase().startsWith('text/plain'));
          if (parsed.text.length < 30) throw new LinkError('На странице мало доступного текста. Скопируйте текст или загрузите документ.');
          sources.push({ type: 'url', url: displayUrl, title: parsed.title || url.hostname, status: 'read', text: parsed.text, truncated: parsed.truncated });
          break;
        }
      } catch (error) {
        sources.push({ type: 'url', url: displayUrl, title: '', status: 'unavailable',
          error: error instanceof LinkError ? error.message : 'Не удалось прочитать страницу. Она может требовать входа или запрещать загрузку.' });
      }
    }
    return { sources, omitted: Math.max(0, links.length - 3) };
  }
}
