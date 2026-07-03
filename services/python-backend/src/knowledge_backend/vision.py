"""VLM-based image description for multimodal chunks.

Uses an OpenAI-compatible vision API (GPT-4V, Qwen-VL, etc.) to generate
rich text descriptions of images extracted from documents.
"""

import base64
import re
import sys
from typing import Optional

import httpx

VISION_PROMPT = """You are an expert image analyst. Describe this image in detail, covering:
1. What is depicted (chart, diagram, photo, table, formula, etc.)
2. Key information and data visible in the image
3. How it relates to its surrounding context (if provided below)

Return ONLY the description text — no JSON, no markdown fences, no extra commentary."""


def _has_vlm_config(vlm_api_base: str, vlm_api_key: str, vlm_model: str) -> bool:
    return bool(vlm_api_base.strip() and vlm_model.strip())


def describe_image(
    image_bytes: bytes,
    image_format: str = "png",
    *,
    vlm_api_base: str = "",
    vlm_api_key: str = "",
    vlm_model: str = "",
    caption: str = "",
    neighbor_text: str = "",
    http: Optional[httpx.Client] = None,
) -> tuple[str, dict]:
    """Generate a text description of an image via VLM.

    Returns ``(description, entity_info)``.  Falls back to caption when no
    VLM is configured or the VLM call fails.
    """
    if not _has_vlm_config(vlm_api_base, vlm_api_key, vlm_model):
        return _fallback_description(caption)

    b64 = base64.b64encode(image_bytes).decode("ascii")
    mime = f"image/{image_format}" if image_format else "image/png"

    context_parts = []
    if caption:
        context_parts.append(f"Caption: {caption}")
    if neighbor_text:
        context_parts.append(f"Surrounding text: {neighbor_text}")
    user_text = "\n".join(context_parts) if context_parts else "Describe this image in detail."

    messages = [
        {"role": "system", "content": VISION_PROMPT},
        {
            "role": "user",
            "content": [
                {"type": "text", "text": user_text},
                {"type": "image_url", "image_url": {"url": f"data:{mime};base64,{b64}"}},
            ],
        },
    ]

    own_client = http is None
    if own_client:
        http = httpx.Client(timeout=60.0)

    try:
        base = vlm_api_base.rstrip("/")
        resp = http.post(
            f"{base}/chat/completions",
            headers={
                "Content-Type": "application/json",
                "Authorization": f"Bearer {vlm_api_key}",
            },
            json={"model": vlm_model, "messages": messages, "max_tokens": 800},
        )
        resp.raise_for_status()
        result = resp.json()
        text = result["choices"][0]["message"]["content"]

        # Strip markdown fences if present, then use the text directly
        desc = re.sub(r'^```(?:json)?\s*\n?', '', text.strip())
        desc = re.sub(r'\n?```\s*$', '', desc)
        desc = desc.strip()

        if desc:
            return desc, _make_entity(caption)
        return _fallback_description(caption)

    except Exception as e:
        print(f"[vision] VLM call failed: {e}", file=sys.stderr)
        return _fallback_description(caption)
    finally:
        if own_client and http is not None:
            http.close()


def _fallback_description(caption: str) -> tuple[str, dict]:
    desc = caption.strip() if caption else "[Image - no description available]"
    return desc, _make_entity(caption)


def _make_entity(caption: str) -> dict:
    name = caption.strip()[:80] if caption else "Unnamed image"
    return {
        "entity_name": name,
        "entity_type": "image",
        "summary": caption.strip() if caption else "",
    }
