"""Configuration management for the knowledge backend."""
import os
import json
from pathlib import Path
from pydantic_settings import BaseSettings


class BackendConfig(BaseSettings):
    """Configuration loaded from environment variables and settings.json."""

    knowledge_base_data_dir: str = ""
    knowledge_backend_port: int = 17390

    # Embedding API
    embedding_api_base: str = "https://api.openai.com"
    embedding_api_key: str = ""
    embedding_model: str = "text-embedding-3-small"

    # Rerank API
    rerank_api_base: str = "https://api.jina.ai"
    rerank_api_key: str = ""
    rerank_model: str = "jina-reranker-v2-base-multilingual"

    # Chunking defaults
    chunk_strategy: str = "recursive"
    chunk_size: int = 512
    chunk_overlap: int = 50

    class Config:
        env_prefix = ""
        env_file = ".env"

    def load_from_settings_json(self) -> "BackendConfig":
        """Load additional settings from the Tauri app's settings.json."""
        if self.knowledge_base_data_dir:
            settings_path = Path(self.knowledge_base_data_dir) / "settings.json"
            if settings_path.exists():
                with open(settings_path) as f:
                    data = json.load(f)
                for key, value in data.items():
                    if hasattr(self, key) and value:
                        setattr(self, key, value)
        return self


_config: BackendConfig | None = None


def get_config() -> BackendConfig:
    global _config
    if _config is None:
        _config = BackendConfig()
        _config.load_from_settings_json()
    return _config
