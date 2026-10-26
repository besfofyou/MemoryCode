// Jest setupFiles：在任何测试/被测模块加载前固定环境变量
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.JWT_SECRET = 'jest-unit-test-secret-0123456789';
