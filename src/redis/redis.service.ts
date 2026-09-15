import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {Redis} from "ioredis";

@Injectable()
export class RedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name);
  private readonly client: Redis;

  constructor(config: ConfigService) {
    this.client = new Redis(config.getOrThrow<string>("REDIS_URL"), {
      lazyConnect: true,
      maxRetriesPerRequest: 3,
    });

    this.client.on("error", (error) => {
      this.logger.error("Redis error", error);
    });
  }

  async onModuleInit(): Promise<void> {
    await this.client.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async setJson(
    key: string,
    value: unknown,
    ttlSeconds: number,
  ): Promise<void> {
    await this.client.set(key, JSON.stringify(value), "EX", ttlSeconds);
  }

  async getJson<T>(key: string): Promise<T | null> {
    const raw = await this.client.get(key);

    if (!raw) {
      return null;
    }

    return JSON.parse(raw) as T;
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async ttl(key: string): Promise<number> {
    return this.client.ttl(key);
  }

  async incrementCodeAttempts(
    key: string,
    purpose: string,
    codeHash: string,
  ): Promise<number | null> {
    const attempts = Number(await this.client.eval(`
      local raw = redis.call('GET', KEYS[1])
      if not raw then return -1 end
      local record = cjson.decode(raw)
      if record.purpose ~= ARGV[1] or record.codeHash ~= ARGV[2] then return -1 end
      local ttl = redis.call('PTTL', KEYS[1])
      if ttl <= 0 then return -1 end
      record.attempts = record.attempts + 1
      redis.call('SET', KEYS[1], cjson.encode(record), 'PX', ttl)
      return record.attempts
    `, 1, key, purpose, codeHash));
    return attempts < 0 ? null : attempts;
  }

  async setNxEx(key: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(
      key,
      "1",
      "EX",
      ttlSeconds,
      "NX",
    );

    return result === "OK";
  }

  async countAttempt(key: string, ttlSeconds: number): Promise<number> {
    return Number(await this.client.eval(
      "local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; return n",
      1, key, ttlSeconds,
    ));
  }
}
