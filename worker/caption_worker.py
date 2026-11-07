#!/usr/bin/env python3
import base64
import json
import os
import re
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any

import requests
from PIL import Image

SUPPORTED_EXTENSIONS = {".png", ".jpg", ".jpeg"}
REQUEST_TIMEOUT = (10, 300)


def emit(event_type: str, **payload: Any) -> None:
    print(json.dumps({"type": event_type, **payload}, ensure_ascii=False), flush=True)


def encode_image_to_base64(image_path: str | Path) -> str:
    path = Path(image_path)
    with Image.open(path) as image:
        image.verify()
    with path.open("rb") as image_file:
        return base64.b64encode(image_file.read()).decode("ascii")


def clean_llm_response(text: str) -> str:
    cleaned = re.sub(r"<think>.*?</think>", "", text or "", flags=re.IGNORECASE | re.DOTALL)
    cleaned = re.sub(r"```(?:text|markdown)?\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = cleaned.replace("```", "")
    cleaned = re.sub(r"^\s*(?:assistant|caption|description)\s*:\s*", "", cleaned, flags=re.IGNORECASE)
    cleaned = re.sub(r"^\s*(?:here is|here's) (?:the|a) (?:caption|description)\s*:\s*", "", cleaned, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", cleaned).strip(" \t\r\n\"'")


def ensure_trigger_word(caption: str, trigger_word: str) -> str:
    trigger = trigger_word.strip()
    if not trigger or caption.casefold().startswith(trigger.casefold()):
        return caption
    return f"{trigger}, {caption}"


def compose_prompt(master_prompt: str, character_prompt: str, trigger_word: str = "", caption_format: str = "comma") -> str:
    format_instruction = {
        "comma": "Use concise comma-separated tags.",
        "natural": "Write one natural language descriptive paragraph.",
        "danbooru": "Use Danbooru-style comma-separated tags, ordered from subject to environment.",
    }.get(caption_format, "Use concise comma-separated tags.")
    sections = [
        "You are captioning an image for a LoRA training dataset.",
        "Produce only the final caption text. Do not include analysis, labels, markdown, or <think> blocks.",
        "CAPTION FORMAT:\n" + format_instruction,
        "TRIGGER WORD (put this at the beginning of the final caption exactly as written):\n" + (trigger_word or "No trigger word provided."),
        "GLOBAL MASTER PROMPT (style, composition, background, and formatting):\n" + (master_prompt or "No additional global rules provided."),
        "CHARACTER-SPECIFIC RULES (fixed anatomy, genetic traits, and locked features):\n" + (character_prompt or "No additional character-specific rules provided."),
        "Apply both sections together. Describe visible details accurately and do not invent hidden information.",
    ]
    return "\n\n".join(sections)


def openai_endpoint(api_url: str) -> str:
    base = api_url.rstrip("/")
    return f"{base}/chat/completions" if base.endswith("/v1") else f"{base}/v1/chat/completions"


def request_caption(api_type: str, api_url: str, model_name: str, api_key: str, prompt: str, image_base64: str) -> str:
    if api_type == "ollama":
        endpoint = f"{api_url.rstrip('/')}/api/generate"
        payload = {"model": model_name, "prompt": prompt, "images": [image_base64], "stream": False}
        headers = {}
    elif api_type == "gemini":
        endpoint = f"{api_url.rstrip('/')}/models/{model_name}:generateContent?key={api_key}"
        payload = {"contents": [{"parts": [{"text": prompt}, {"inline_data": {"mime_type": "image/jpeg", "data": image_base64}}]}]}
        headers = {}
    elif api_type == "anthropic":
        endpoint = f"{api_url.rstrip('/')}/v1/messages"
        payload = {
            "model": model_name,
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": [
                {"type": "text", "text": prompt},
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": image_base64}},
            ]}],
        }
        headers = {"x-api-key": api_key, "anthropic-version": "2023-06-01"}
    else:
        endpoint = openai_endpoint(api_url)
        payload = {
            "model": model_name,
            "messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": f"data:image/jpeg;base64,{image_base64}"}},
                ],
            }],
            "stream": False,
        }
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
    try:
        response = requests.post(endpoint, json=payload, headers=headers, timeout=REQUEST_TIMEOUT)
        response.raise_for_status()
    except requests.exceptions.ConnectionError as error:
        local_name = "llama.cpp" if api_type == "llama.cpp" else api_type
        raise ValueError(f"{local_name} server'a bağlanılamadı. Sunucunun {api_url} adresinde çalıştığını kontrol edin.") from error
    except requests.exceptions.Timeout as error:
        raise ValueError(f"{api_type} yanıt vermedi. Model sunucusunun çalıştığını ve modelin hazır olduğunu kontrol edin.") from error
    except requests.exceptions.HTTPError as error:
        status = error.response.status_code if error.response is not None else 0
        if status in {401, 403}:
            raise ValueError(f"{api_type} API key geçersiz veya yetkisiz.") from error
        if status == 404:
            raise ValueError(f"{api_type} model veya endpoint bulunamadı. Model adını ve API URL'sini kontrol edin.") from error
        if status in {400, 415}:
            raise ValueError(f"{api_type} isteği kabul etmedi. Seçilen modelin görsel desteklediğini kontrol edin.") from error
        raise ValueError(f"{api_type} HTTP {status} hatası döndürdü.") from error
    data = response.json()
    if api_type == "ollama":
        raw_text = data.get("response")
    elif api_type == "gemini":
        raw_text = data.get("candidates", [{}])[0].get("content", {}).get("parts", [{}])[0].get("text")
    elif api_type == "anthropic":
        raw_text = data.get("content", [{}])[0].get("text")
    else:
        raw_text = data.get("choices", [{}])[0].get("message", {}).get("content")
    if not isinstance(raw_text, str) or not raw_text.strip():
        raise ValueError(f"{api_type} returned no caption text.")
    caption = clean_llm_response(raw_text)
    if not caption:
        raise ValueError("The cleaned Ollama response was empty.")
    return caption


def write_caption(path: Path, caption: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    previous_caption = path.read_text(encoding="utf-8").strip() if path.exists() else ""
    history_path = path.parent / ".caption-history.json"
    try:
        history_store = json.loads(history_path.read_text(encoding="utf-8")) if history_path.exists() else {}
    except (OSError, json.JSONDecodeError):
        history_store = {}
    history = history_store.get(path.name, []) if isinstance(history_store, dict) else []
    legacy_path = path.with_name(f"{path.name}.history.json")
    if legacy_path.exists():
        try:
            history.extend(json.loads(legacy_path.read_text(encoding="utf-8")))
            legacy_path.unlink()
        except (OSError, json.JSONDecodeError):
            pass
    if previous_caption != caption:
        history.append({"timestamp": datetime.now().astimezone().isoformat(), "previous": previous_caption, "next": caption, "source": "worker"})
    history_store[path.name] = history[-50:]
    history_path.write_text(json.dumps(history_store, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", dir=path.parent, delete=False) as temporary:
        temporary.write(caption + "\n")
        temporary_path = Path(temporary.name)
    os.replace(temporary_path, path)
    return previous_caption


def process_dataset(config: dict[str, Any]) -> None:
    folder = Path(config["folderPath"]).expanduser().resolve()
    if not folder.is_dir():
        raise ValueError("The dataset path is not a directory.")
    only_files = set(config.get("onlyFiles", []))
    images = sorted((path for path in folder.iterdir() if path.is_file() and path.suffix.lower() in SUPPORTED_EXTENSIONS and (not only_files or path.name in only_files) and (not config.get("onlyMissing") or not path.with_suffix(".txt").exists())), key=lambda path: path.name.lower())
    if not images:
        raise ValueError("No PNG, JPG, or JPEG images were found in the dataset folder.")
    prompt = compose_prompt(config.get("masterPrompt", ""), config.get("characterPrompt", ""), config.get("triggerWord", ""), config.get("captionFormat", "comma"))
    total = len(images)
    success_count = 0
    failure_count = 0
    emit("status", status="running", total=total, completed=0, success=0, failed=0, message=f"Found {total} image(s).")
    for index, image_path in enumerate(images, start=1):
        emit("file", filename=image_path.name, index=index, total=total, completed=index - 1, success=success_count, failed=failure_count, message=f"Processing {image_path.name}...")
        try:
            encoded = encode_image_to_base64(image_path)
            caption = request_caption(config.get("apiType", "llama.cpp"), config["apiUrl"], config["modelName"], config.get("apiKey", ""), prompt, encoded)
            caption = ensure_trigger_word(caption, config.get("triggerWord", ""))
            previous_caption = write_caption(image_path.with_suffix(".txt"), caption)
            success_count += 1
            emit("file", filename=image_path.name, index=index, total=total, completed=index, success=success_count, failed=failure_count, result="success", caption=caption, previous_caption=previous_caption, message=f"Saved {image_path.stem}.txt")
        except Exception as error:
            failure_count += 1
            emit("file", filename=image_path.name, index=index, total=total, completed=index, success=success_count, failed=failure_count, result="error", message=f"Failed: {error}")
    emit("complete", summary={"total": total, "completed": total, "success": success_count, "failed": failure_count}, message=f"Finished: {success_count} succeeded, {failure_count} failed.")


def main() -> int:
    try:
        config = json.loads(sys.stdin.read())
        process_dataset(config)
        return 0
    except Exception as error:
        emit("error", summary={"message": str(error)}, message=str(error))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
