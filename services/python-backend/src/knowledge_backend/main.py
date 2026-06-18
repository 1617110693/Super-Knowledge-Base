"""Main entry point for the Python backend service."""
import os
import sys

import uvicorn
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .api import chat, documents, knowledge_bases, search, settings


def create_app() -> FastAPI:
    app = FastAPI(
        title="Local Knowledge Base - Python Backend",
        version="0.1.0",
        description="Embedding, vector search, and RAG service",
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.include_router(search.router, prefix="/api/v1", tags=["search"])
    app.include_router(chat.router, prefix="/api/v1", tags=["chat"])
    app.include_router(documents.router, prefix="/api/v1", tags=["documents"])
    app.include_router(
        knowledge_bases.router, prefix="/api/v1", tags=["knowledge_bases"]
    )
    app.include_router(settings.router, prefix="/api/v1", tags=["settings"])

    @app.get("/api/v1/health")
    async def health():
        from .config import get_config

        c = get_config()
        return {
            "status": "ok",
            "version": "0.1.0",
            "data_dir": c.knowledge_base_data_dir,
        }

    return app


def main():
    """Entry point for `knowledge-backend` command."""
    port = int(os.environ.get("KNOWLEDGE_BACKEND_PORT", "17390"))
    data_dir = os.environ.get("KNOWLEDGE_BASE_DATA_DIR", "")
    if data_dir:
        os.environ["KNOWLEDGE_BASE_DATA_DIR"] = data_dir

    app = create_app()
    print(f"Starting Python backend on http://127.0.0.1:{port}")
    print(f"Data directory: {data_dir}")
    uvicorn.run(app, host="127.0.0.1", port=port, log_level="info")


if __name__ == "__main__":
    main()
