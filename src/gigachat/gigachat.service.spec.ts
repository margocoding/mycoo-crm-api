import { Test, TestingModule } from '@nestjs/testing';
import { GigachatService } from './gigachat.service.js';

describe('GigachatService', () => {
  let service: GigachatService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [GigachatService],
    }).compile();

    service = module.get<GigachatService>(GigachatService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
