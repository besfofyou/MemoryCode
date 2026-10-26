import { fileURLToPath } from 'node:url';
import { jest } from '@jest/globals';

/**
 * 数据层（= 数据库连接边界）的 mock。
 * 单元测试里不连真库：`src/store.js` 被整体替换成这些 jest.fn()，
 * 换成 pg.Pool / Prisma 时，把这里替换成 jest.mock('pg') 之类的实现即可，
 * 路由层测试的写法不用变。
 */
export const dbMock = {
  list: jest.fn(),
  findById: jest.fn(),
  findByEmail: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  remove: jest.fn(),
  checkPassword: jest.fn(),
  count: jest.fn(),
  seedAdmin: jest.fn(),
  // 保持真实实现：只剔除 passwordHash
  toPublicUser: jest.fn(),
};

/** 用绝对路径注册 mock，保证与路由里 `import '../store.js'` 解析到同一个模块 */
export const STORE_PATH = fileURLToPath(new URL('../../../src/store.js', import.meta.url));

export function installStoreMock() {
  return jest.unstable_mockModule(STORE_PATH, () => dbMock);
}

const publicUser = (user) => {
  if (!user) return null;
  const { passwordHash, ...rest } = user;
  return rest;
};

/** 每个用例前重置：清调用记录 + 还原默认实现（默认查不到任何用户） */
export function resetDbMock() {
  jest.clearAllMocks();

  dbMock.toPublicUser.mockImplementation(publicUser);
  dbMock.findById.mockReturnValue(null);
  dbMock.findByEmail.mockReturnValue(null);
  dbMock.list.mockReturnValue({ items: [], total: 0, page: 1, limit: 20 });
  dbMock.checkPassword.mockResolvedValue(false);
  dbMock.create.mockImplementation(async (input) => ({
    id: 'u-new',
    name: input.name,
    email: String(input.email).toLowerCase(),
    role: input.role ?? 'user',
    passwordHash: 'stub-hash',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  }));
  dbMock.update.mockImplementation(async (id, patch) => ({ id, ...patch }));
  dbMock.remove.mockReturnValue(undefined);
}
