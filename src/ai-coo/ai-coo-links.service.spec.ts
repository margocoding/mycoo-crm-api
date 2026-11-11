import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiCooLinksService, COO_LINK_BYTES, COO_LINK_TIMEOUT_MS, messageLinks, pageText, publicIPv4, publicPageUrl } from './ai-coo-links.service.js';

const network = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn(), plans: [] as Array<Record<string, any>>, requests: [] as Array<Record<string, any>> }));
vi.mock('node:dns/promises', () => ({ lookup: network.lookup }));
vi.mock('node:http', () => ({ request: (...args: any[]) => network.request(...args) }));
vi.mock('node:https', () => ({ request: (...args: any[]) => network.request(...args) }));

beforeEach(() => {
  vi.clearAllMocks(); network.plans.length = 0; network.requests.length = 0;
  network.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  network.request.mockImplementation((url: URL, options: any, callback: (response: any) => void) => {
    const plan = network.plans.shift() || {};
    const request = new EventEmitter() as any;
    network.requests.push({ url, options, request });
    request.destroy = (error?: Error) => { if (error) queueMicrotask(() => request.emit('error', error)); return request; };
    request.end = () => queueMicrotask(() => {
      if (plan.hang) return;
      const response = new PassThrough() as any;
      response.statusCode = plan.status || 200;
      response.headers = plan.headers || { 'content-type': 'text/html; charset=utf-8' };
      callback(response);
      if (response.destroyed) return;
      for (const chunk of plan.chunks || [plan.body || '<title>Отчёт</title><p>Выручка компании за квартал увеличилась на 12 процентов.</p>']) {
        if (response.destroyed) break;
        response.write(chunk);
      }
      if (!response.destroyed) response.end();
    });
    return request;
  });
});
afterEach(() => vi.useRealTimers());

describe('AI COO public link boundaries', () => {
  it('denies local, private, metadata, multicast and IPv6 ranges', () => {
    for (const address of ['0.1.2.3', '10.2.3.4', '127.0.0.1', '100.64.0.1', '100.100.100.200', '169.254.169.254', '172.16.0.1', '172.31.255.255', '192.0.0.9', '192.0.2.1', '192.88.99.1', '192.168.1.1', '198.18.0.1', '198.19.1.1', '198.51.100.1', '203.0.113.9', '224.0.0.1', '255.255.255.255', '::1', '::ffff:8.8.8.8', '2002:0808:0808::1']) expect(publicIPv4(address), address).toBe(false);
    for (const address of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1']) expect(publicIPv4(address), address).toBe(true);
  });

  it('rejects credentials, alternate protocols, ports and encoded loopback spellings', () => {
    for (const url of ['file:///etc/passwd', 'ftp://example.com/a', 'https://user:pass@example.com', 'https://example.com:8443', 'http://2130706433', 'http://0x7f000001', 'http://127.1', 'http://[::ffff:127.0.0.1]']) expect(() => publicPageUrl(url), url).toThrow();
    expect(publicPageUrl('https://example.com:443/report#section').href).toBe('https://example.com/report');
  });

  it('reads only explicit question URLs, deduplicates them and caps at three', async () => {
    expect(messageLinks('Читайте [страницу](https://example.com/report), https://example.com/report.')).toEqual(['https://example.com/report']);
    const result = await new AiCooLinksService().collect('https://example.com/a https://example.com/b https://example.com/c https://example.com/d');
    expect(result.omitted).toBe(1); expect(result.sources).toHaveLength(3); expect(network.request).toHaveBeenCalledTimes(3);
  });

  it('pins the resolved public address and sends no cookies, authentication or referrer', async () => {
    network.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const result = await new AiCooLinksService().collect('https://example.com/report');
    expect(result.sources[0]).toMatchObject({ status: 'read', title: 'Отчёт' });
    const options = network.requests[0].options;
    const callback = vi.fn(); options.lookup('example.com', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '93.184.216.34', 4);
    const all = vi.fn(); options.lookup('example.com', { all: true }, all);
    expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
    expect(network.lookup).toHaveBeenCalledTimes(1);
    expect(options).toMatchObject({ agent: false, family: 4 });
    expect(Object.keys(options.headers).sort()).toEqual(['Accept', 'Accept-Encoding', 'User-Agent']);
  });

  it('does not connect when any DNS answer is private', async () => {
    network.lookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]);
    expect((await new AiCooLinksService().collect('https://example.com')).sources[0].status).toBe('unavailable');
    expect(network.request).not.toHaveBeenCalled();
  });

  it('rechecks redirect URLs before connecting to metadata or a private rebound host', async () => {
    network.plans.push({ status: 302, headers: { location: 'http://169.254.169.254/latest/meta-data' } });
    expect((await new AiCooLinksService().collect('https://example.com')).sources[0].status).toBe('unavailable');
    expect(network.request).toHaveBeenCalledTimes(1);
    network.plans.push({ status: 302, headers: { location: '/next' } });
    network.lookup.mockResolvedValueOnce([{ address: '93.184.216.34', family: 4 }]).mockResolvedValueOnce([{ address: '10.0.0.2', family: 4 }]);
    expect((await new AiCooLinksService().collect('https://example.com')).sources[0].status).toBe('unavailable');
    expect(network.request).toHaveBeenCalledTimes(2);
  });

  it('follows safe redirects without forwarding cookies', async () => {
    network.plans.push({ status: 302, headers: { location: '/report', 'set-cookie': 'private=value' } });
    expect((await new AiCooLinksService().collect('https://example.com')).sources[0].status).toBe('read');
    expect(network.requests[1].url.href).toBe('https://example.com/report');
    expect(network.requests[1].options.headers.Cookie).toBeUndefined();
  });

  it('stops redirect loops', async () => {
    network.plans.push(...Array.from({ length: 4 }, () => ({ status: 302, headers: { location: '/loop' } })));
    const result = await new AiCooLinksService().collect('https://example.com');
    expect(result.sources[0]).toMatchObject({ status: 'unavailable', error: 'Слишком много перенаправлений.' });
    expect(network.request).toHaveBeenCalledTimes(4);
  });

  it('enforces the byte budget even without Content-Length', async () => {
    network.plans.push({ chunks: [Buffer.alloc(COO_LINK_BYTES / 2, 'a'), Buffer.alloc(COO_LINK_BYTES / 2 + 1, 'b')] });
    const result = await new AiCooLinksService().collect('https://example.com');
    expect(result.sources[0]).toMatchObject({ status: 'unavailable', error: expect.stringContaining('1 МБ') });
  });

  it('shares the byte budget across all pages', async () => {
    network.plans.push({ body: 'a'.repeat(600_000) }, { body: 'b'.repeat(600_000) });
    const result = await new AiCooLinksService().collect('https://example.com/one https://example.com/two');
    expect(result.sources[0]).toMatchObject({ status: 'read', truncated: true });
    expect(result.sources[0].text).toHaveLength(12_000);
    expect(result.sources[1]).toMatchObject({ status: 'unavailable', error: expect.stringContaining('1 МБ') });
  });

  it('rejects binary and compressed payloads with useful per-source errors', async () => {
    network.plans.push({ headers: { 'content-type': 'application/pdf' } }, { headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' } });
    const result = await new AiCooLinksService().collect('https://example.com/file https://example.com/gzip');
    expect(result.sources.map((source) => source.status)).toEqual(['unavailable', 'unavailable']);
    expect(result.sources[0].error).toContain('PDF');
  });

  it('bounds a hanging DNS lookup and does not start a late HTTP request', async () => {
    vi.useFakeTimers(); network.lookup.mockImplementation(() => new Promise(() => {}));
    const result = new AiCooLinksService().collect('https://example.com');
    await vi.advanceTimersByTimeAsync(COO_LINK_TIMEOUT_MS + 1);
    expect((await result).sources[0].status).toBe('unavailable'); expect(network.request).not.toHaveBeenCalled();
  });

  it('aborts a hanging server within the total deadline', async () => {
    vi.useFakeTimers(); network.plans.push({ hang: true });
    const result = new AiCooLinksService().collect('https://example.com');
    await vi.advanceTimersByTimeAsync(COO_LINK_TIMEOUT_MS + 1);
    expect((await result).sources[0]).toMatchObject({ status: 'unavailable', error: 'Сайт не ответил вовремя.' });
  });

  it('strips script/style/embedded markup and never fetches URLs from a page', async () => {
    const html = '<title>План &amp; отчёт</title><!--secret--><script>fetch("http://127.0.0.1/admin")</script><style>hidden</style><p>План отдела: выполнить все задачи в течение следующей недели.</p><a href="https://example.net/other">Подробнее</a>';
    const parsed = pageText(html);
    expect(parsed.title).toBe('План & отчёт');
    expect(parsed.text).not.toContain('fetch'); expect(parsed.text).not.toContain('secret'); expect(parsed.text).not.toContain('hidden');
    network.plans.push({ body: html });
    await new AiCooLinksService().collect('https://example.com');
    expect(network.request).toHaveBeenCalledTimes(1);
    expect(pageText('<'.repeat(100_000)).text).toBe('');
  });
});
