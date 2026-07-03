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
    use_local_embedding: bool = False
    local_embedding_model: str = "Qwen3-Embedding-0.6B-Q8_0.gguf"

    # Rerank API
    rerank_api_base: str = "https://api.jina.ai/v1"
    rerank_api_key: str = ""
    rerank_model: str = "jina-reranker-v2-base-multilingual"
    use_local_rerank: bool = False
    local_rerank_model: str = "qwen3-reranker-0.6b-q8_0.gguf"

    # Local models (llama.cpp)
    llama_port: int = 0
    llama_threads: int = 0

    def effective_llama_port(self) -> int:
        return self.llama_port if self.llama_port > 0 else 8081

    def effective_llama_threads(self) -> int:
        return self.llama_threads if self.llama_threads > 0 else 4

    # Chunking defaults
    chunk_strategy: str = "recursive"
    chunk_size: int = 512
    chunk_overlap: int = 50

    # Multimodal processing
    extract_multimodal: bool = True

    # Dev mode: enable developer endpoints (ZIP save/load for testing)
    dev_mode: bool = False

    # VLM (Vision Language Model) for image descriptions
    vlm_api_base: str = ""
    vlm_api_key: str = ""
    vlm_model: str = ""

    class Config:
        env_prefix = ""
        env_file = ".env"

    def load_from_settings_json(self) -> "BackendConfig":
        """Load settings from settings.json, trying data_dir first then default dir."""
        search_paths = []
        if self.knowledge_base_data_dir:
            search_paths.append(Path(self.knowledge_base_data_dir) / "settings.json")
        search_paths.append(Path.home() / ".super-knowledge-base" / "settings.json")

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
    """Load config from settings.json and auto-resolve local models."""
    config = BackendConfig()
    config.load_from_settings_json()

    # Keep diagnostic info accessible via /llama-status
    config._llama_error = ""

    # Manage llama.cpp servers
    need_llama = config.use_local_embedding or config.use_local_rerank
    if not need_llama:
        # Stop any running servers when local mode is turned off
        try:
            from .llama_service import stop_all
            stop_all()
        except Exception:
            pass
    else:
        try:
            from .llama_service import start_embedding_server, start_rerank_server

            def _model_name(path: str) -> str:
                name = Path(path).stem
                return name or "local"

            if config.use_local_embedding:
                base_url = start_embedding_server(
                    config.local_embedding_model,
                    port=config.effective_llama_port(),
                    threads=config.effective_llama_threads(),
                )
                config.embedding_api_base = base_url
                config.embedding_api_key = "local"
                config.embedding_model = _model_name(config.local_embedding_model)

            if config.use_local_rerank:
                base_url = start_rerank_server(
                    config.local_rerank_model,
                    port=config.effective_llama_port() + 1,
                    threads=config.effective_llama_threads(),
                )
                config.rerank_api_base = base_url
                config.rerank_api_key = "local"
                config.rerank_model = _model_name(config.local_rerank_model)

        except Exception as e:
            import sys, traceback
            config._llama_error = f"{type(e).__name__}: {e}"
            print(f"[SKB] llama-server start failed: {e}", file=sys.stderr)
            traceback.print_exc(file=sys.stderr)

    return config
