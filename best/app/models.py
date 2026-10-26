"""SQLAlchemy ORM 模型。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import Boolean, DateTime, String, func, text
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(primary_key=True, autoincrement=True)

    email: Mapped[str] = mapped_column(String(254), unique=True, index=True, nullable=False, comment="登录邮箱")
    username: Mapped[str] = mapped_column(String(32), unique=True, index=True, nullable=False, comment="登录名")
    nickname: Mapped[str | None] = mapped_column(String(32), nullable=True)

    hashed_password: Mapped[str] = mapped_column(String(128), nullable=False, comment="bcrypt 摘要，绝不存明文")

    is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, server_default=text("1"))

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False
    )

    def __repr__(self) -> str:  # pragma: no cover - 调试辅助
        return f"<User id={self.id} username={self.username!r} email={self.email!r}>"
