"""运行期配置：全部可用环境变量覆盖，方便从 SQLite 切到 MySQL/PG。"""

from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    app_name: str = "best-user-service"
    debug: bool = False

    # sqlite:  sqlite:///./best.db
    # mysql :  mysql+pymysql://user:pwd@127.0.0.1:3306/best?charset=utf8mb4
    database_url: str = "sqlite:///./best.db"
    db_echo: bool = False

    # 密码策略（校验规则的唯一来源，避免 schemas 里散落魔法数字）
    password_min_length: int = 8
    password_max_length: int = 64
    username_min_length: int = 3
    username_max_length: int = 32

    # bcrypt 输入上限 72 字节，超过会静默截断，这里直接拒掉
    password_max_bytes: int = 72


@lru_cache
def get_settings() -> Settings:
    return Settings()
