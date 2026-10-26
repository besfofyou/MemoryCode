/** Jest 配置：项目是 ESM（package.json type: module），所以不做转译，直接跑原生 ESM。
 *  运行需要 --experimental-vm-modules（见 package.json 的 test:unit 脚本）。 */
export default {
  testEnvironment: 'node',
  transform: {},
  setupFiles: ['<rootDir>/test/jest/helpers/env.js'],
  testMatch: ['<rootDir>/test/jest/**/*.test.js'],
  // 集成测试（node:test）不在这个配置里跑，见 package.json 的 test 脚本
  clearMocks: false,
  verbose: true,
};
