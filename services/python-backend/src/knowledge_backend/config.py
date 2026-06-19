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
    embedding_api_base: str = "https://api.openai.com/v1"
    embedding_api_key: str = ""
    embedding_model: str = "text-embedding-3-small"

    # Rerank API
    rerank_api_base: str = "https://api.jina.ai/v1"
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
        """Load settings from settings.json, trying data_dir first then default dir."""
        search_paths = []
        if self.knowledge_base_data_dir:
            search_paths.append(Path(self.knowledge_base_data_dir) / "settings.json")
        search_paths.append(Path.home() / ".local-knowledge-base" / "settings.json")

        for settings_path in search_paths:
            if settings_path.exists():
                with open(settings_path) as f:
                    data = json.load(f)
                for key, value in data.items():
                    if hasattr(self, key) and value:
                        setattr(self, key, value)
                return self
        return self


def get_config() -> BackendConfig:
    # Always reload from settings.json so config changes take effect without restart
    config = BackendConfig()
    config.load_from_settings_json()
    return config
