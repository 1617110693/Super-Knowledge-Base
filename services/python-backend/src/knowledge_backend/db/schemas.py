"""LanceDB schema definitions using PyArrow."""
import pyarrow as pa


def get_chunk_schema(embedding_dim: int) -> pa.Schema:
    """Create the chunk table schema with the given embedding dimension."""
    return pa.schema(
        [
            pa.field("chunk_id", pa.string()),
            pa.field("doc_id", pa.string()),
            pa.field("kb_id", pa.string()),
            pa.field("doc_name", pa.string()),
            pa.field("content", pa.string()),
            pa.field("chunk_index", pa.int32()),
            pa.field("page_number", pa.int32()),
            pa.field("chunk_strategy", pa.string()),
            pa.field("metadata_json", pa.string()),
            pa.field("vector", pa.list_(pa.float32(), embedding_dim)),
        ]
    )
